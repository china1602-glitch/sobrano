'use strict';
// Проверка собранного Worker локально с настоящей SQLite. Это не запуск cloud D1.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const origin = 'https://sobrano.test';
let worker;
let createNodeDatabase;

test.before(async () => {
  let source;
  try { source = readFileSync(path.join(root, 'dist/server/index.js'), 'utf8'); }
  catch (error) {
    throw new Error('Сначала выполните npm run build: Worker dist/server/index.js не найден.', { cause: error });
  }
  // Такой же импорт ESM, как при проверке артефакта перед публикацией.
  worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
  assert.equal(typeof worker?.fetch, 'function');
  ({ createNodeDatabase } = await import('../online/node-db.mjs'));
});

async function fixture(t) {
  const db = createNodeDatabase(':memory:');
  t.after(() => db.close());
  const migrationDir = path.join(root, 'drizzle');
  const files = readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.length > 0, 'В drizzle/ должна находиться сгенерированная миграция');
  // Миграции исполняются ДО первого HTTP-запроса. online/schema.sql не используется.
  for (const file of files) db.exec(readFileSync(path.join(migrationDir, file), 'utf8'));
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).results.map(row => row.name);
  for (const name of ['catalog_entries', 'catalog_metadata', 'saved_builds', 'visitor_sessions'])
    assert.ok(tables.includes(name), 'Сгенерированная миграция создаёт ' + name);
  return { db, env: { DB: db } };
}

function fetchWorker(env, route, options = {}) {
  return worker.fetch(new Request(new URL(route, origin), options), env);
}

async function jsonRequest(env, route, options = {}) {
  const response = await fetchWorker(env, route, options);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('Built Worker + local SQLite: all ten HTML pages and linked local assets are embedded', async t => {
  const { env } = await fixture(t);
  const pages = ['index.html', 'catalog.html', 'builds.html', 'builder.html', 'compare.html',
    'favorites.html', 'about.html', 'account.html', 'product.html?id=p0', 'build.html?id=b0'];
  const resources = new Set(['/css/style.css', '/js/core.js', '/js/compatibility.js', '/js/pricing.js',
    '/js/catalog-ui.js', '/js/backend-client.js', '/js/media.js', '/js/product-images.js', '/js/app.js']);
  for (const page of pages) {
    const response = await fetchWorker(env, '/' + page);
    assert.equal(response.status, 200, page);
    assert.match(response.headers.get('content-type') || '', /text\/html/);
    const html = await response.text();
    assert.match(html, /<!doctype html>/i, page);
    assert.match(html, /СОБРАНО/);
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const url = new URL(match[1], origin + '/' + page);
      if (url.origin === origin && !url.hash) resources.add(url.pathname + url.search);
    }
  }
  for (const resource of resources) {
    const response = await fetchWorker(env, resource);
    assert.equal(response.status, 200, resource);
    assert.ok((await response.arrayBuffer()).byteLength > 0, resource + ' is not empty');
    const head = await fetchWorker(env, resource, { method: 'HEAD' });
    assert.equal(head.status, 200, resource + ' HEAD');
    assert.equal(await head.text(), '');
  }
  const home = await fetchWorker(env, '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<!doctype html>/i);
});

test('Built Worker + local SQLite: WOFF2 fonts retain their actual binary bytes', async t => {
  const { env } = await fixture(t);
  const fonts = readdirSync(path.join(root, 'assets/fonts')).filter(name => name.endsWith('.woff2'));
  assert.ok(fonts.length >= 2, 'В проекте должны находиться латинский и кириллический Manrope');
  for (const font of fonts) {
    const response = await fetchWorker(env, '/assets/fonts/' + font);
    assert.equal(response.status, 200, font);
    assert.match(response.headers.get('content-type') || '', /font\/woff2/);
    const embedded = Buffer.from(await response.arrayBuffer());
    assert.equal(embedded.subarray(0, 4).toString(), 'wOF2');
    assert.deepEqual(embedded, readFileSync(path.join(root, 'assets/fonts', font)), font);
  }
});

test('Built Worker + local SQLite: API seeds the migrated SQL catalog and executes compatibility', async t => {
  const { env, db } = await fixture(t);
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM catalog_entries').first('count'), 0);
  const runtime = await jsonRequest(env, '/runtime.json');
  assert.equal(runtime.status, 200);
  assert.equal(runtime.body.backend, 'server');
  assert.equal(runtime.body.engine, 'Cloudflare Workers');
  assert.equal(runtime.body.features.savedBuilds, true);
  const catalog = await jsonRequest(env, '/api/catalog');
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.products.length, 190);
  assert.equal(catalog.body.builds.length, 22);
  assert.equal(catalog.body.offers.length, 8);
  assert.equal(Object.keys(catalog.body.prices).length, 190);
  const counts = (await db.prepare('SELECT kind, COUNT(*) AS count FROM catalog_entries GROUP BY kind ORDER BY kind').all()).results;
  assert.deepEqual(counts, [{kind:'build',count:22},{kind:'offer',count:8},{kind:'product',count:190}]);
  assert.equal((await db.prepare("SELECT value FROM catalog_metadata WHERE key = 'revision'").first()).value, 'sobrano-190-2026-10-28-v1');
  const config = await jsonRequest(env, '/api/configuration', { method:'POST',
    headers:{'Content-Type':'application/json'}, body:JSON.stringify({parts:{gpu:85}}) });
  assert.equal(config.status, 200);
  assert.deepEqual(config.body.parts, {gpu:85});
  assert.equal(config.body.assessments.p40.allowed, false);
  const zero = await jsonRequest(env, '/api/builds?budget=0');
  assert.deepEqual(zero.body.ids, []);
});

test('Built Worker + local SQLite: secure session saves real SQL data and shares read-only without a cookie', async t => {
  const { env, db } = await fixture(t);
  const session = await jsonRequest(env, '/api/session');
  assert.equal(session.status, 200);
  const setCookie = session.headers.get('set-cookie');
  assert.match(setCookie, /^sobrano_session=[0-9a-f]{64};/);
  assert.match(setCookie, /; HttpOnly(?:;|$)/);
  assert.match(setCookie, /; Secure(?:;|$)/);
  assert.match(setCookie, /; SameSite=Lax(?:;|$)/);
  assert.match(session.body.csrfToken, /^[0-9a-f]{64}$/);
  const cookie = setCookie.split(';')[0];
  const body = {name:'Сборка для защиты',parts:{cpu:0},requestId:randomUUID()};
  const options = { method:'POST',headers:{'Content-Type':'application/json', Cookie:cookie,
    'X-CSRF-Token':session.body.csrfToken,Origin:origin},body:JSON.stringify(body) };
  const saved = await jsonRequest(env, '/api/saved-builds', options);
  assert.equal(saved.status, 201);
  assert.equal(saved.body.name, body.name);
  assert.deepEqual(saved.body.parts, {cpu:0});
  assert.equal(saved.body.canEdit, true);
  const row = await db.prepare('SELECT name, parts_json FROM saved_builds WHERE id = ?').bind(saved.body.id).first();
  assert.equal(row.name, body.name);
  assert.deepEqual(JSON.parse(row.parts_json), {cpu:0});
  const again = await jsonRequest(env, '/api/saved-builds', options);
  assert.equal(again.status, 200);
  assert.equal(again.body.id, saved.body.id);
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM saved_builds').first('count'), 1);
  const shared = await jsonRequest(env, '/api/saved-builds/' + saved.body.id);
  assert.equal(shared.status, 200);
  assert.equal(shared.body.canEdit, false);
  assert.deepEqual(shared.body.parts, body.parts);
  assert.equal(Object.hasOwn(shared.body, 'ownerId'), false);
  assert.equal(Object.hasOwn(shared.body, 'csrfToken'), false);
  assert.deepEqual((await jsonRequest(env, '/api/saved-builds')).body.items, []);
  const denied = await jsonRequest(env, '/api/saved-builds/' + saved.body.id, { method:'DELETE' });
  assert.equal(denied.status, 401);
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM saved_builds').first('count'), 1);
});

test('Built Worker: missing DB binding returns honest 503 while static interface remains available', async () => {
  for (const route of ['/runtime.json', '/api/health', '/api/catalog']) {
    const result = await jsonRequest({}, route);
    assert.equal(result.status, 503);
    assert.match(result.body.error, /база данных.*не подключена/);
  }
  assert.equal((await fetchWorker({}, '/index.html')).status, 200);
  assert.equal((await fetchWorker({}, '/.openai/hosting.json')).status, 404);
  assert.equal((await fetchWorker({}, '/online/store.mjs')).status, 404);
});

test('Built Worker + local SQLite: registration, rotated secure cookie and account builds survive another login', async t => {
  const { env } = await fixture(t);
  async function session() {
    const response = await jsonRequest(env, '/api/session');
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken };
  }
  const guest = await session();
  const write = (route, body, credentials) => jsonRequest(env, route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin,
      Cookie: credentials.cookie, 'X-CSRF-Token': credentials.csrf }, body: JSON.stringify(body),
  });
  const saved = await write('/api/saved-builds', { name: 'Worker draft', parts: { cpu: 0 }, requestId: randomUUID() }, guest);
  assert.equal(saved.status, 201);
  const registration = await write('/api/auth/register', {
    username: 'worker_student', password: 'Worker_Practice_2026!', displayName: 'Студент',
  }, guest);
  assert.equal(registration.status, 201);
  assert.equal(registration.body.user.username, 'worker_student');
  assert.equal(Object.hasOwn(registration.body.user, 'passwordHash'), false);
  assert.notEqual(registration.headers.get('set-cookie').split(';')[0], guest.cookie);
  assert.match(registration.headers.get('set-cookie'), /; Secure(?:;|$)/);
  const other = await session();
  const login = await write('/api/auth/login', { username: 'WORKER_STUDENT', password: 'Worker_Practice_2026!' }, other);
  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, registration.body.user.id);
  const list = await jsonRequest(env, '/api/saved-builds', {
    headers: { Cookie: login.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].id, saved.body.id);
});
