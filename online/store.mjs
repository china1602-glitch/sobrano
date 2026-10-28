/* Данные каталога, гостевые сессии и сохранённые сборки: SQLite локально, D1 онлайн.
   Создание таблиц выполняется миграциями до HTTP-запросов, а не в этом модуле. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_LIFETIME = 90 * 86400000;
export const MAX_SAVED_BUILDS = 50;

export class StoreError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "StoreError";
    this.status = status;
  }
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function publicBuild(row, includeOwner = false) {
  if (!row) return null;
  const value = {
    id: row.id, name: row.name, parts: JSON.parse(row.parts_json),
    createdAt: row.created_at, updatedAt: row.updated_at, version: row.version,
  };
  if (includeOwner) value.ownerId = row.owner_id;
  return value;
}

function buildInput(name, parts) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 80 || /[\u0000-\u001f\u007f]/u.test(name))
    throw new StoreError(400, "Название сборки должно содержать от 1 до 80 символов.");
  if (!parts || typeof parts !== "object" || Array.isArray(parts)
      || Object.keys(parts).length > 8
      || Object.values(parts).some(value => !Number.isSafeInteger(value) || value < 0))
    throw new StoreError(400, "Неверный состав сборки.");
  // Единый порядок ключей делает повтор запроса идемпотентным.
  return { name: name.trim(), parts: Object.fromEntries(Object.entries(parts).sort(([a], [b]) => a.localeCompare(b))) };
}

export function createStore(db, { now = () => Date.now() } = {}) {
  const stamp = () => new Date(now()).toISOString();
  const first = (sql, ...args) => db.prepare(sql).bind(...args).first();
  const all = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;

  async function seedCatalog(raw, offers, revision) {
    if (!raw || !Array.isArray(raw.products) || !Array.isArray(raw.builds) || !Array.isArray(offers)
        || typeof revision !== "string" || !revision || revision.length > 200)
      throw new StoreError(500, "Некорректные исходные данные каталога.");
    const current = await first("SELECT value FROM catalog_metadata WHERE key = ?", "revision");
    if (current?.value === revision) return false;
    const entries = [
      ...raw.products.map((row, position) => ["product", position, JSON.stringify(row)]),
      ...raw.builds.map((row, position) => ["build", position, JSON.stringify(row)]),
      ...offers.map((row, position) => ["offer", position, JSON.stringify(row)]),
    ];
    const commands = [db.prepare("DELETE FROM catalog_entries")];
    // 25 строк × 3 параметра: меньше лимита D1 в 100 параметров на запрос.
    for (let start = 0; start < entries.length; start += 25) {
      const chunk = entries.slice(start, start + 25);
      commands.push(db.prepare("INSERT INTO catalog_entries (kind, position, row_json) VALUES "
        + chunk.map(() => "(?, ?, ?)").join(", ")).bind(...chunk.flat()));
    }
    for (const [key, value] of [["photos", JSON.stringify(raw.photos || {})], ["revision", revision]])
      commands.push(db.prepare("INSERT INTO catalog_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value));
    await db.batch(commands);
    return true;
  }

  async function readCatalog() {
    const revision = await first("SELECT value FROM catalog_metadata WHERE key = ?", "revision");
    if (!revision) throw new StoreError(503, "Каталог ещё не инициализирован.");
    const rows = await all("SELECT kind, position, row_json FROM catalog_entries ORDER BY kind, position");
    const groups = { product: [], build: [], offer: [] };
    for (const row of rows) {
      if (!Object.hasOwn(groups, row.kind) || row.position !== groups[row.kind].length)
        throw new StoreError(503, "Нарушен порядок моделей в каталоге.");
      groups[row.kind].push(JSON.parse(row.row_json));
    }
    if (!groups.product.length) throw new StoreError(503, "Каталог моделей пуст.");
    const photos = await first("SELECT value FROM catalog_metadata WHERE key = ?", "photos");
    return { products: groups.product, builds: groups.build, photos: JSON.parse(photos?.value || "{}"), offers: groups.offer };
  }

  async function createSession() {
    const token = randomToken();
    const ownerId = crypto.randomUUID();
    const csrfToken = randomToken();
    const createdAt = stamp();
    const expiresAt = new Date(now() + SESSION_LIFETIME).toISOString();
    await db.prepare("INSERT INTO visitor_sessions (owner_id, token_hash, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(ownerId, await sha256(token), csrfToken, createdAt, expiresAt).run();
    return { token, ownerId, csrfToken, expiresAt };
  }

  async function findSession(token) {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
    const tokenHash = await sha256(token);
    const account = await first(`SELECT a.id, a.owner_id, a.username, a.display_name, s.csrf_token, s.expires_at
      FROM account_sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = ? AND s.expires_at > ?`, tokenHash, stamp());
    if (account) return { ownerId: account.owner_id, csrfToken: account.csrf_token, expiresAt: account.expires_at,
      user: { id: account.id, username: account.username, displayName: account.display_name } };
    const row = await first(`SELECT owner_id, csrf_token, expires_at FROM visitor_sessions
      WHERE token_hash = ? AND expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM accounts WHERE accounts.owner_id = visitor_sessions.owner_id)`, tokenHash, stamp());
    return row ? { ownerId: row.owner_id, csrfToken: row.csrf_token, expiresAt: row.expires_at } : null;
  }

  async function findAccount(username) {
    return first("SELECT id, owner_id, username, display_name, password_hash FROM accounts WHERE username = ?", username);
  }

  function accountUser(row) {
    return { id: row.id, username: row.username, displayName: row.display_name };
  }

  async function newAccountSession(account) {
    const token = randomToken(), csrfToken = randomToken();
    return { token, tokenHash: await sha256(token), csrfToken, ownerId: account.owner_id,
      user: accountUser(account), createdAt: stamp(), expiresAt: new Date(now() + SESSION_LIFETIME).toISOString() };
  }

  async function registerAccount(token, username, displayName, passwordHash) {
    const current = await findSession(token);
    if (!current) throw new StoreError(401, "Сессия завершилась. Обновите страницу.");
    if (current.user) throw new StoreError(409, "Сначала выйдите из текущего аккаунта.");
    const account = { id: crypto.randomUUID(), owner_id: current.ownerId, username, display_name: displayName };
    const next = await newAccountSession(account);
    const oldHash = await sha256(token), revokedHash = await sha256(randomToken());
    let results;
    try {
      results = await db.batch([
        db.prepare(`INSERT INTO accounts (id, owner_id, username, display_name, password_hash, created_at)
          SELECT ?, owner_id, ?, ?, ?, ? FROM visitor_sessions
          WHERE owner_id = ? AND token_hash = ? AND expires_at > ?
          AND NOT EXISTS (SELECT 1 FROM accounts WHERE accounts.owner_id = visitor_sessions.owner_id)
          RETURNING id`).bind(account.id, username, displayName, passwordHash, stamp(), current.ownerId, oldHash, stamp()),
        db.prepare(`INSERT INTO account_sessions (token_hash, account_id, csrf_token, created_at, expires_at)
          SELECT ?, id, ?, ?, ? FROM accounts WHERE id = ?`)
          .bind(next.tokenHash, next.csrfToken, next.createdAt, next.expiresAt, account.id),
        db.prepare("UPDATE visitor_sessions SET token_hash = ? WHERE owner_id = ? AND EXISTS (SELECT 1 FROM accounts WHERE id = ?)")
          .bind(revokedHash, current.ownerId, account.id),
      ]);
    } catch (error) {
      if (await findAccount(username)) throw new StoreError(409, "Этот логин уже занят. Выберите другой.");
      throw error;
    }
    if (!results[0].results?.length) throw new StoreError(409, "Сессия уже изменилась. Обновите страницу.");
    return next;
  }

  async function loginAccount(token, account) {
    const current = await findSession(token);
    if (!current) throw new StoreError(401, "Сессия завершилась. Обновите страницу.");
    const next = await newAccountSession(account);
    const oldHash = await sha256(token);
    const guestOwner = !current.user && current.ownerId !== account.owner_id ? current.ownerId : null;
    const quota = guestOwner ? '(SELECT COUNT(*) FROM saved_builds WHERE owner_id IN (?, ?)) <= ?' : '1 = 1';
    // Проверка лимита и INSERT находятся в одной SQL-транзакции; два гостевых входа
    // не могут независимо проверить COUNT и превысить квоту общей учётной записи.
    const commands = [db.prepare(`INSERT INTO account_sessions (token_hash, account_id, csrf_token, created_at, expires_at)
      SELECT ?, ?, ?, ?, ? WHERE ${quota} AND (
        EXISTS (SELECT 1 FROM visitor_sessions WHERE token_hash = ? AND expires_at > ?)
        OR EXISTS (SELECT 1 FROM account_sessions WHERE token_hash = ? AND expires_at > ?))
      RETURNING token_hash`).bind(next.tokenHash, account.id, next.csrfToken, next.createdAt, next.expiresAt,
      ...(guestOwner ? [guestOwner, account.owner_id, MAX_SAVED_BUILDS] : []), oldHash, stamp(), oldHash, stamp())];
    // Переносятся только записи текущего гостя. Составы другого аккаунта никогда не переносятся.
    if (guestOwner) {
      commands.push(db.prepare(`UPDATE saved_builds SET owner_id = ?, request_id = 'import-' || id
        WHERE owner_id = ? AND NOT EXISTS (SELECT 1 FROM accounts WHERE owner_id = ?)
        AND EXISTS (SELECT 1 FROM account_sessions WHERE token_hash = ?)`)
        .bind(account.owner_id, current.ownerId, current.ownerId, next.tokenHash));
    }
    commands.push(db.prepare(`DELETE FROM account_sessions WHERE token_hash = ?
      AND EXISTS (SELECT 1 FROM account_sessions WHERE token_hash = ?)`).bind(oldHash, next.tokenHash));
    commands.push(db.prepare(`UPDATE visitor_sessions SET token_hash = ? WHERE token_hash = ?
      AND EXISTS (SELECT 1 FROM account_sessions WHERE token_hash = ?)`)
      .bind(await sha256(randomToken()), oldHash, next.tokenHash));
    const results = await db.batch(commands);
    if (!results[0].results?.length) {
      if (!await findSession(token)) throw new StoreError(409, "Сессия уже изменилась. Обновите страницу.");
      throw new StoreError(409, "В аккаунте и гостевом списке больше 50 сборок. Удалите ненужные гостевые сборки перед входом.");
    }
    return next;
  }

  async function revokeSession(token) {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return;
    const tokenHash = await sha256(token);
    await db.batch([
      db.prepare("DELETE FROM account_sessions WHERE token_hash = ?").bind(tokenHash),
      db.prepare("UPDATE visitor_sessions SET token_hash = ? WHERE token_hash = ?").bind(await sha256(randomToken()), tokenHash),
    ]);
  }

  async function consumeAuthAttempt(username, clientAddress) {
    const windowSize = 15 * 60 * 1000;
    const start = Math.floor(now() / windowSize) * windowSize;
    // Ограничение клиента проверяется до создания новых корзин логинов.
    await db.prepare('DELETE FROM auth_rate_limits WHERE window_start < ?').bind(start - 86400000).run();
    const increment = async key => first(`INSERT INTO auth_rate_limits (bucket_key, window_start, attempts)
      VALUES (?, ?, 1) ON CONFLICT(bucket_key) DO UPDATE SET
      attempts = CASE WHEN window_start = excluded.window_start THEN attempts + 1 ELSE 1 END,
      window_start = excluded.window_start RETURNING attempts`,key,start);
    const client = await increment(await sha256('client:' + clientAddress));
    const login = client.attempts <= 40 ? await increment(await sha256('username:' + username)) : null;
    if (client.attempts > 40 || login.attempts > 8) {
      const error = new StoreError(429, "Слишком много попыток входа. Повторите через 15 минут.");
      error.retryAfter = Math.max(1, Math.ceil((start + windowSize - now()) / 1000));
      throw error;
    }
  }

  async function listBuilds(ownerId) {
    return (await all("SELECT id, name, parts_json, created_at, updated_at, version FROM saved_builds WHERE owner_id = ? ORDER BY updated_at DESC, id", ownerId))
      .map(row => publicBuild(row));
  }

  async function getBuild(id) {
    return publicBuild(await first("SELECT * FROM saved_builds WHERE id = ?", id), true);
  }

  async function saveBuild(ownerId, name, parts, requestId) {
    const input = buildInput(name, parts);
    if (typeof requestId !== "string" || !UUID.test(requestId))
      throw new StoreError(400, "Для сохранения нужен идентификатор запроса UUID.");
    requestId = requestId.toLowerCase();
    const requestHash = await sha256(JSON.stringify(input));
    const time = stamp();
    // Проверка квоты и INSERT выполняются одним SQL-оператором, без гонки COUNT → INSERT.
    const row = await first(`INSERT INTO saved_builds
      (id, owner_id, name, parts_json, created_at, updated_at, version, request_id, request_hash)
      SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?
      WHERE (SELECT count(*) FROM saved_builds WHERE owner_id = ?) < ?
      ON CONFLICT(owner_id, request_id) DO NOTHING
      RETURNING *`, crypto.randomUUID(), ownerId, input.name, JSON.stringify(input.parts), time, time,
    requestId, requestHash, ownerId, MAX_SAVED_BUILDS);
    if (row) return { build: publicBuild(row, true), created: true };
    const prior = await first("SELECT * FROM saved_builds WHERE owner_id = ? AND request_id = ?", ownerId, requestId);
    if (prior) {
      if (prior.request_hash !== requestHash)
        throw new StoreError(409, "Этот запрос уже использован для другого состава. Повторите сохранение новым запросом.");
      return { build: publicBuild(prior, true), created: false };
    }
    throw new StoreError(429, "Сохранено максимальное количество сборок (50). Удалите ненужную сборку перед добавлением новой.");
  }

  async function updateBuild(id, ownerId, name, parts, expectedVersion) {
    const input = buildInput(name, parts);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new StoreError(400, "Нужна корректная версия сохранённой сборки.");
    const row = await first(`UPDATE saved_builds SET name = ?, parts_json = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND owner_id = ? AND version = ? RETURNING *`,
    input.name, JSON.stringify(input.parts), stamp(), id, ownerId, expectedVersion);
    if (row) return publicBuild(row, true);
    const existing = await first("SELECT version FROM saved_builds WHERE id = ? AND owner_id = ?", id, ownerId);
    if (!existing) throw new StoreError(404, "Сохранённая сборка не найдена.");
    throw new StoreError(409, "Сборка уже изменена в другой вкладке. Откройте её заново перед сохранением.");
  }

  async function deleteBuild(id, ownerId) {
    const result = await db.prepare("DELETE FROM saved_builds WHERE id = ? AND owner_id = ?").bind(id, ownerId).run();
    if (!result.meta?.changes) throw new StoreError(404, "Сохранённая сборка не найдена.");
    return true;
  }

  return { seedCatalog, readCatalog, createSession, findSession, findAccount, registerAccount, loginAccount,
    revokeSession, consumeAuthAttempt, listBuilds, getBuild, saveBuild, updateBuild, deleteBuild };
}
