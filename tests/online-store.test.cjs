const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");

const raw = JSON.parse(readFileSync(join(__dirname, "../data/catalog.json"), "utf8"));
const offers = JSON.parse(readFileSync(join(__dirname, "../data/offers.json"), "utf8"));
const schema = readFileSync(join(__dirname, "../online/schema.sql"), "utf8");
let createNodeDatabase, createStore, StoreError;
test.before(async () => {
  ({ createNodeDatabase } = await import("../online/node-db.mjs"));
  ({ createStore, StoreError } = await import("../online/store.mjs"));
});

function memory(t, options) {
  const db = createNodeDatabase();
  db.exec(schema);
  t.after(() => db.close());
  return { db, store: createStore(db, options) };
}

function status(expected) {
  return error => error instanceof StoreError && error.status === expected;
}

test("SQL-каталог сохраняет порядок всех 190 моделей, 22 сборок и источники", async t => {
  const { store } = memory(t);
  assert.equal(await store.seedCatalog(raw, offers, "original"), true);
  const saved = await store.readCatalog();
  assert.deepEqual(saved, { products: raw.products, builds: raw.builds, photos: raw.photos || {}, offers });
  assert.equal(saved.products.length, 190);
  assert.equal(saved.builds.length, 22);
  assert.equal(await store.seedCatalog(raw, offers, "original"), false);
});

test("Инициализация каталога соблюдает лимиты D1 и не создаёт таблиц в запросе", async t => {
  const { db } = memory(t);
  let queries = 0;
  const restricted = {
    prepare(sql) {
      assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP)\b/i);
      const statement = db.prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        assert.ok(values.length <= 100, "D1 permits at most 100 bound values");
        return bind(...values);
      };
      return statement;
    },
    batch(commands) {
      queries += commands.length + 1; // предварительный SELECT revision
      return db.batch(commands);
    },
  };
  await createStore(restricted).seedCatalog(raw, offers, "bounded");
  assert.ok(queries <= 50, "seed must fit one free-tier D1 request");
});

test("Сборка и сессия остаются после закрытия и повторного открытия SQLite", async t => {
  const directory = mkdtempSync(join(tmpdir(), "sobrano-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "instance", "sobrano.sqlite");
  let db = createNodeDatabase(file);
  db.exec(schema);
  let store = createStore(db);
  await store.seedCatalog(raw, offers, "durable");
  const session = await store.createSession();
  const { build } = await store.saveBuild(session.ownerId, "Моя сборка", { cpu: 0 }, randomUUID());
  db.close();
  db = createNodeDatabase(file);
  t.after(() => db.close());
  db.exec(schema);
  store = createStore(db);
  assert.equal((await store.findSession(session.token)).ownerId, session.ownerId);
  assert.deepEqual((await store.getBuild(build.id)).parts, { cpu: 0 });
  assert.equal((await store.readCatalog()).products.length, 190);
});

test("Токен сессии хранится только в виде хеша, неверные и просроченные отклоняются", async t => {
  let time = Date.parse("2026-10-28T12:00:00Z");
  const { db, store } = memory(t, { now: () => time });
  const session = await store.createSession();
  assert.match(session.token, /^[0-9a-f]{64}$/);
  assert.match(session.csrfToken, /^[0-9a-f]{64}$/);
  const row = await db.prepare("SELECT token_hash FROM visitor_sessions WHERE owner_id = ?").bind(session.ownerId).first();
  assert.notEqual(row.token_hash, session.token);
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(await store.findSession(session.token), {
    ownerId: session.ownerId, csrfToken: session.csrfToken, expiresAt: session.expiresAt,
  });
  assert.equal(await store.findSession("invalid"), null);
  assert.equal(await store.findSession("0".repeat(64)), null);
  time += 90 * 86400000;
  assert.equal(await store.findSession(session.token), null);
});

test("Авторы видят только свои списки и не могут менять или удалять чужую сборку", async t => {
  const { store } = memory(t);
  const a = await store.createSession(), b = await store.createSession();
  const requestId = randomUUID();
  const original = (await store.saveBuild(a.ownerId, "Сборка автора A", { cpu: 0 }, requestId)).build;
  const second = (await store.saveBuild(b.ownerId, "Сборка автора B", {}, requestId)).build;
  assert.notEqual(original.id, second.id);
  const own = await store.listBuilds(a.ownerId);
  assert.equal(own.length, 1);
  assert.equal(own[0].id, original.id);
  assert.deepEqual(Object.keys(own[0]).sort(), ["createdAt", "id", "name", "parts", "updatedAt", "version"]);
  await assert.rejects(store.updateBuild(original.id, b.ownerId, "Подмена", {}, 1), status(404));
  await assert.rejects(store.deleteBuild(original.id, b.ownerId), status(404));
  assert.equal((await store.getBuild(original.id)).name, "Сборка автора A");
  assert.equal((await store.listBuilds(b.ownerId))[0].id, second.id);
});

test("Повторная и параллельная отправка одного запроса создают только одну сборку", async t => {
  const { store } = memory(t);
  const owner = (await store.createSession()).ownerId;
  const requestId = randomUUID();
  const results = await Promise.all([
    store.saveBuild(owner, "Повтор", { cpu: 0, gpu: 85 }, requestId),
    store.saveBuild(owner, "Повтор", { gpu: 85, cpu: 0 }, requestId),
  ]);
  assert.equal(results[0].build.id, results[1].build.id);
  assert.equal(results.filter(value => value.created).length, 1);
  assert.equal((await store.listBuilds(owner)).length, 1);
  await assert.rejects(store.saveBuild(owner, "Другое содержимое", {}, requestId), status(409));
  assert.equal((await store.listBuilds(owner))[0].name, "Повтор");
});

test("Версия защищает от потери изменений в двух вкладках", async t => {
  let time = Date.parse("2026-10-28T12:00:00Z");
  const { store } = memory(t, { now: () => time });
  const owner = (await store.createSession()).ownerId;
  const initial = (await store.saveBuild(owner, "До", { cpu: 0 }, randomUUID())).build;
  time += 1000;
  const next = await store.updateBuild(initial.id, owner, "После", { cpu: 1 }, 1);
  assert.equal(next.version, 2);
  assert.equal(next.createdAt, initial.createdAt);
  assert.notEqual(next.updatedAt, initial.updatedAt);
  await assert.rejects(store.updateBuild(initial.id, owner, "Потерянное изменение", {}, 1), status(409));
  assert.deepEqual((await store.getBuild(initial.id)).parts, { cpu: 1 });
});

test("Квота не превышается конкурентными сохранениями и не удаляет старые данные", async t => {
  const { store } = memory(t);
  const owner = (await store.createSession()).ownerId;
  const firstRequest = randomUUID();
  const first = await store.saveBuild(owner, "Сохранить эту", { cpu: 0 }, firstRequest);
  const outcomes = await Promise.allSettled(Array.from({ length: 60 }, (_, i) =>
    store.saveBuild(owner, "Сборка " + i, {}, randomUUID())));
  assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 49);
  assert.equal(outcomes.filter(value => value.status === "rejected" && value.reason.status === 429).length, 11);
  assert.equal((await store.listBuilds(owner)).length, 50);
  assert.equal((await store.getBuild(first.build.id)).name, "Сохранить эту");
  const replay = await store.saveBuild(owner, "Сохранить эту", { cpu: 0 }, firstRequest);
  assert.equal(replay.created, false);
  assert.equal(replay.build.id, first.build.id);
});

test("Обновление исходного каталога сохраняет пользовательские составы и сессии", async t => {
  const { store } = memory(t);
  await store.seedCatalog(raw, offers, "v1");
  const session = await store.createSession();
  const { build } = await store.saveBuild(session.ownerId, "Оставить", { cpu: 0 }, randomUUID());
  const next = structuredClone(raw);
  next.products[0][2] += 100;
  await store.seedCatalog(next, offers, "v2");
  assert.equal((await store.readCatalog()).products[0][2], raw.products[0][2] + 100);
  assert.deepEqual((await store.getBuild(build.id)).parts, { cpu: 0 });
  assert.equal((await store.findSession(session.token)).ownerId, session.ownerId);
});

test("Ошибка в пакетной записи откатывает каталог и метаданные целиком", async t => {
  const { db, store } = memory(t);
  await store.seedCatalog(raw, offers, "before");
  const failing = createStore({
    prepare: db.prepare,
    batch(commands) {
      return db.batch([...commands, db.prepare("INSERT INTO catalog_metadata (key, value) VALUES (?, ?)").bind("revision", "duplicate")]);
    },
  });
  const altered = structuredClone(raw);
  altered.products[0][1] = "Не должно сохраниться";
  await assert.rejects(failing.seedCatalog(altered, [], "after"));
  assert.deepEqual(await store.readCatalog(), { products: raw.products, builds: raw.builds, photos: raw.photos || {}, offers });
  assert.equal((await db.prepare("SELECT value FROM catalog_metadata WHERE key = ?").bind("revision").first()).value, "before");
});

test("Пробелы порядка каталога не подменяют идентификаторы других товаров", async t => {
  const { db, store } = memory(t);
  await assert.rejects(store.readCatalog(), status(503));
  await store.seedCatalog(raw, offers, "full");
  await db.prepare("DELETE FROM catalog_entries WHERE kind = ? AND position = ?").bind("product", 0).run();
  await assert.rejects(store.readCatalog(), status(503));
});

test("Названия записываются как данные, ошибка ввода и удаление не портят другие строки", async t => {
  const { store } = memory(t);
  const owner = (await store.createSession()).ownerId;
  const name = "'; DROP TABLE saved_builds; --";
  const { build } = await store.saveBuild(owner, name, {}, randomUUID());
  assert.equal((await store.getBuild(build.id)).name, name);
  for (const invalid of ["", " ", "x".repeat(81), "line\nbreak"])
    await assert.rejects(store.saveBuild(owner, invalid, {}, randomUUID()), status(400));
  for (const invalid of [null, [], { cpu: false }, { cpu: -1 }, { cpu: 0.5 }])
    await assert.rejects(store.saveBuild(owner, "Ошибка", invalid, randomUUID()), status(400));
  await assert.rejects(store.saveBuild(owner, "Ошибка", {}, "invalid-id"), status(400));
  assert.equal((await store.listBuilds(owner)).length, 1);
  assert.equal(await store.deleteBuild(build.id, owner), true);
  assert.equal(await store.getBuild(build.id), null);
  await assert.rejects(store.deleteBuild(build.id, owner), status(404));
});
