import { createDomain, HttpError } from './domain.mjs';
import { StoreError } from './store.mjs';
import { accountInput, hashPassword, verifyPassword } from './auth.mjs';

const COOKIE = 'sobrano_session';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIMIT = 65536;
function sessionCookie(current, url) {
  return `${COOKIE}=${current.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000${url.protocol === 'https:' ? '; Secure' : ''}`;
}
const sessionBody = current => ({ user: current.user || null, csrfToken: current.csrfToken });

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Vary': 'Cookie', ...headers,
  }});
}

function cookieToken(request) {
  const values = (request.headers.get('cookie') || '').split(';');
  const match = values.map(v => v.trim()).find(v => v.startsWith(COOKIE + '='));
  const value = match?.slice(COOKIE.length + 1) || '';
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

async function readBody(request) {
  if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new HttpError(415, 'Требуется Content-Type: application/json.');
  if (Number(request.headers.get('content-length')) > LIMIT)
    throw new HttpError(413, 'Тело запроса превышает 64 КБ.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Нужно непустое тело JSON.');
  const chunks = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > LIMIT) { await reader.cancel(); throw new HttpError(413, 'Тело запроса превышает 64 КБ.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  try {
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error();
    return result;
  } catch { throw new HttpError(400, 'Тело запроса содержит некорректный JSON-объект.'); }
}

function fields(body, expected) {
  if (Object.keys(body).length !== expected.length || expected.some(key => !Object.hasOwn(body, key)))
    throw new HttpError(400, 'Ожидаются поля: ' + expected.join(', ') + '.');
}

function buildName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value))
    throw new HttpError(400, 'Название должно содержать от 1 до 80 символов без переносов строк.');
  return value.trim();
}

function publicBuild(build, ownerId, domain) {
  const result = domain.configurationPayload(build.parts);
  return { id: build.id, name: build.name, parts: result.parts,
    createdAt: build.createdAt, updatedAt: build.updatedAt, version: build.version,
    canEdit: build.ownerId === ownerId, budget: result.budget, check: result.check };
}

function savable(domain, parts) {
  const result = domain.configurationPayload(parts);
  const conflicts = new Set(result.check.bad || []);
  for (const index of Object.values(result.parts)) {
    const assessment = result.assessments['p' + index];
    if (!assessment.allowed) for (const reason of assessment.conflicts) conflicts.add(reason);
  }
  if (conflicts.size) throw new HttpError(422, 'Состав содержит конфликт: ' + [...conflicts].join(' '));
  return result.parts;
}

/** Один обработчик работает в Node.js и в Cloudflare Workers. */
export function createAPI({ store, engine = 'JavaScript', ensureReady = async () => {}, getClientAddress = () => 'unknown' }) {
  async function session(request, required = false) {
    const token = cookieToken(request);
    const result = token ? await store.findSession(token) : null;
    if (!result && required) throw new HttpError(401, 'Сессия завершилась. Обновите страницу и повторите сохранение.');
    return result;
  }
  async function author(request) {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin)
      throw new HttpError(403, 'Запись разрешена только с этого сайта.');
    const current = await session(request, true);
    if (request.headers.get('x-csrf-token') !== current.csrfToken)
      throw new HttpError(403, 'Не удалось подтвердить действие. Обновите страницу.');
    return current;
  }

  return async function api(request) {
    const url = new URL(request.url); const path = url.pathname;
    if (path !== '/runtime.json' && path !== '/api' && !path.startsWith('/api/')) return null;
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    let response;
    try {
      if (path === '/runtime.json') {
        if (method !== 'GET') throw new HttpError(405, 'Метод не поддерживается.');
        response = json({ backend: 'server', engine, apiBase: 'api/', features: { savedBuilds: true, accounts: true } });
      } else {
        const saved = path.match(/^\/api\/saved-builds\/([^/]+)$/);
        const allowed = ['/api/configuration','/api/auth/register','/api/auth/login','/api/auth/logout'].includes(path) ? ['POST']
          : path === '/api/saved-builds' ? ['GET','POST']
          : saved ? ['GET','PUT','DELETE']
          : ['/api/health','/api/catalog','/api/products','/api/builds','/api/session','/api/auth/me'].includes(path) ? ['GET'] : [];
        if (!allowed.length) throw new HttpError(404, 'Маршрут API не найден.');
        if (!allowed.includes(method)) throw new HttpError(405, 'Метод не поддерживается этим маршрутом.');
        await ensureReady();
        if (path === '/api/session' || path === '/api/auth/me') {
          let current = await session(request); const headers = {};
          if (!current) {
            current = await store.createSession();
            headers['Set-Cookie'] = sessionCookie(current, url);
          }
          response = json(sessionBody(current), 200, headers);
        } else if (path === '/api/auth/logout') {
          await author(request);
          fields(await readBody(request), []);
          await store.revokeSession(cookieToken(request));
          response = json({user:null,csrfToken:null},200,{
            'Set-Cookie':`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${url.protocol === 'https:' ? '; Secure' : ''}`,
          });
        } else if (path === '/api/auth/register' || path === '/api/auth/login') {
          const current = await author(request);
          const registration = path === '/api/auth/register';
          if (registration && current.user) throw new HttpError(409,'Сначала выйдите из текущего аккаунта.');
          const input = accountInput(await readBody(request),registration);
          await store.consumeAuthAttempt(input.username, String(getClientAddress(request)).slice(0,200));
          let next;
          if (registration) {
            next = await store.registerAccount(cookieToken(request),input.username,input.displayName,await hashPassword(input.password));
          } else {
            const account = await store.findAccount(input.username);
            const valid = await verifyPassword(input.password,account?.password_hash);
            if (!valid || !account) throw new HttpError(401,'Неверный логин или пароль.');
            next = await store.loginAccount(cookieToken(request),account);
          }
          response = json(sessionBody(next),registration?201:200,{'Set-Cookie':sessionCookie(next,url)});
        } else {
          const raw = await store.readCatalog();
          const domain = createDomain(raw, raw.offers);
          if (path === '/api/health') response = json({ status: 'ok', project: 'СОБРАНО', backend: 'JavaScript', engine,
            database: 'SQLite', products: raw.products.length, builds: raw.builds.length, offers: raw.offers.length });
          else if (path === '/api/catalog') response = json(domain.catalogPayload());
          else if (path === '/api/products') response = json(domain.productsPayload(url.searchParams));
          else if (path === '/api/builds') response = json(domain.buildsPayload(url.searchParams));
          else if (path === '/api/configuration') {
            const body = await readBody(request); fields(body, ['parts']);
            response = json(domain.configurationPayload(body.parts));
          } else if (path === '/api/saved-builds' && method === 'GET') {
            const current = await session(request);
            response = json({ items: current ? await store.listBuilds(current.ownerId) : [] });
          } else if (path === '/api/saved-builds') {
            const current = await author(request); const body = await readBody(request);
            fields(body, ['name', 'parts', 'requestId']);
            if (typeof body.requestId !== 'string' || !UUID.test(body.requestId)) throw new HttpError(400, 'Некорректный идентификатор сохранения.');
            const parts = savable(domain, body.parts);
            const saved = await store.saveBuild(current.ownerId, buildName(body.name), parts, body.requestId);
            response = json(publicBuild(saved.build, current.ownerId, domain), saved.created ? 201 : 200);
          } else if (saved) {
            const id = saved[1];
            if (!UUID.test(id)) throw new HttpError(404, 'Сохранённая сборка не найдена.');
            if (method === 'GET') {
              const build = await store.getBuild(id);
              if (!build) throw new HttpError(404, 'Сохранённая сборка не найдена.');
              const current = await session(request);
              response = json(publicBuild(build, current?.ownerId, domain));
            } else {
              const current = await author(request);
              if (method === 'DELETE') {
                await store.deleteBuild(id, current.ownerId);
                response = json({ deleted: true });
              } else {
                const body = await readBody(request); fields(body, ['name', 'parts', 'version']);
                if (!Number.isSafeInteger(body.version) || body.version < 1) throw new HttpError(400, 'Некорректная версия сборки.');
                const build = await store.updateBuild(id, current.ownerId, buildName(body.name), savable(domain, body.parts), body.version);
                response = json(publicBuild(build, current.ownerId, domain));
              }
            }
          }
        }
      }
    } catch (error) {
      const known = error instanceof HttpError || error instanceof StoreError;
      if (!known) console.error('СОБРАНО API:', error?.name || 'Error');
      response = json({ error: known ? error.message : 'Сервер не смог обработать запрос. Повторите действие позже.' }, known ? error.status : 500,
        known && error.retryAfter ? {'Retry-After':String(error.retryAfter)} : {});
    }
    return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
  };
}
