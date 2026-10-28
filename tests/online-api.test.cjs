const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID } = require("node:crypto");

let startServer;
test.before(async () => { ({ startServer } = await import("../online/server.mjs")); });

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "sobrano-http-"));
  const databasePath = join(directory, "private", "site.sqlite");
  const app = await startServer({ port: 0, databasePath });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return app;
}

async function request(app, route, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(app.url + route, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  const text = await response.text();
  const value = response.headers.get("content-type")?.includes("application/json") && text ? JSON.parse(text) : text;
  return { status: response.status, body: value, headers: response.headers };
}

async function session(app) {
  const response = await request(app, "/api/session");
  assert.equal(response.status, 200);
  assert.match(response.body.csrfToken, /^[0-9a-f]{64}$/);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^sobrano_session=[0-9a-f]{64};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return { cookie: cookie.split(";")[0], csrf: response.body.csrfToken };
}

function auth(app, visitor, extra = {}) {
  return { "Content-Type": "application/json", Cookie: visitor.cookie, "X-CSRF-Token": visitor.csrf, Origin: app.url, ...extra };
}

async function save(app, visitor, options = {}) {
  return request(app, "/api/saved-builds", { method: "POST", headers: auth(app, visitor),
    body: { name: "Мой черновик", parts: { cpu: 0 }, requestId: randomUUID(), ...options } });
}

test("HTTP: каталог и runtime действительно приходят из JavaScript/SQLite backend", async t => {
  const app = await fixture(t);
  const runtime = await request(app, "/runtime.json");
  assert.equal(runtime.status, 200);
  assert.equal(runtime.body.backend, "server");
  assert.equal(runtime.body.features.savedBuilds, true);
  const health = await request(app, "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.backend, "JavaScript");
  assert.equal(health.body.database, "SQLite");
  assert.equal(health.body.products, 190);
  assert.equal(health.body.builds, 22);
  const catalog = await request(app, "/api/catalog");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.products.length, 190);
  assert.equal(catalog.body.builds.length, 22);
  assert.equal(catalog.body.offers.length, 8);
  assert.equal(Object.keys(catalog.body.prices).length, 190);
  assert.equal(Object.keys(catalog.body.buildResults).length, 22);
  assert.equal(catalog.body.products[0].length, 4);
  const head = await request(app, "/api/health", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
});

test("HTTP: нулевой бюджет, фильтр и RTX 4090 исключают слабый БП", async t => {
  const app = await fixture(t);
  assert.deepEqual((await request(app, "/api/builds?budget=0")).body.ids, []);
  assert.equal((await request(app, "/api/builds?budget=")).body.ids.length, 22);
  const filtered = await request(app, "/api/products?cat=cpu&socket=AM5&search=Ryzen");
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.ids.length > 0);
  const response = await request(app, "/api/configuration", { method: "POST", headers: { "Content-Type": "application/json" }, body: { parts: { gpu: 85 } } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.parts, { gpu: 85 });
  assert.equal(Object.keys(response.body.assessments).length, 190);
  assert.equal(response.body.assessments.p40.allowed, false);
  const supplies = await request(app, "/api/products?cat=psu&parts=,85,,,,,,");
  assert.equal(supplies.status, 200);
  assert.ok(!supplies.body.ids.includes("p40"));
});

test("HTTP: неверные JSON, типы, числа и методы отклоняются понятными 4xx", async t => {
  const app = await fixture(t);
  const jsonHeaders = { "Content-Type": "application/json" };
  for (const body of ["", "{broken", "[]", "null", { parts: null }, { parts: [] }, { parts: { cpu: true } }, { parts: { cpu: 0.5 } }, { parts: { cpu: 9999 } }, { parts: { other: 0 } }, { parts: {}, extra: 1 }]) {
    const response = await request(app, "/api/configuration", { method: "POST", headers: jsonHeaders, body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(typeof response.body.error, "string");
  }
  const wrongType = await request(app, "/api/configuration", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(wrongType.status, 415);
  const oversized = await request(app, "/api/configuration", { method: "POST", headers: jsonHeaders, body: " ".repeat(65537) });
  assert.equal(oversized.status, 413);
  for (const route of ["/api/builds?budget=-1", "/api/builds?budget=0.5", "/api/builds?budget=NaN", "/api/products?min=100&max=1", "/api/products?cat=cpu&cat=gpu"]) {
    const response = await request(app, route);
    assert.equal(response.status, 400, route);
  }
  for (const [route, method, status] of [["/api/configuration", "GET", 405], ["/api/catalog", "POST", 405], ["/api/missing", "GET", 404], ["/api/session", "POST", 405]]) {
    const response = await request(app, route, { method });
    assert.equal(response.status, status);
    assert.equal(typeof response.body.error, "string");
  }
});

test("HTTP: публичные страницы доступны, служебные файлы и база не раздаются", async t => {
  const app = await fixture(t);
  for (const route of ["/", "/index.html", "/catalog.html", "/builder.html", "/js/bootstrap.js", "/css/style.css", "/assets/favicon.svg"]) {
    const response = await request(app, route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  for (const route of ["/.git/config", "/%2egit/config", "/.openai/hosting.json", "/%2eopenai/hosting.json", "/online/schema.sql", "/online/store.mjs", "/instance/sobrano.sqlite", "/tests/online-api.test.cjs", "/README.md"]) {
    assert.equal((await request(app, route)).status, 404, route);
    assert.equal((await request(app, route, { method: "HEAD" })).status, 404, route + " HEAD");
  }
});

test("HTTP: сохранение реально записывает состав, повторы не создают дубликатов", async t => {
  const app = await fixture(t);
  const visitor = await session(app);
  const requestId = randomUUID();
  const created = await save(app, visitor, { name: "Черновик CPU 0", requestId });
  assert.equal(created.status, 201);
  assert.match(created.body.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(created.body.parts, { cpu: 0 });
  assert.equal(created.body.canEdit, true);
  assert.equal(created.body.version, 1);
  assert.ok(created.body.budget.value > 0);
  const stored = await app.store.getBuild(created.body.id);
  assert.deepEqual(stored.parts, { cpu: 0 });
  const repeated = await save(app, visitor, { name: "Черновик CPU 0", requestId });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.id, created.body.id);
  const conflicting = await save(app, visitor, { name: "Другой состав", parts: { cpu: 1 }, requestId });
  assert.equal(conflicting.status, 409);
  const list = await request(app, "/api/saved-builds", { headers: { Cookie: visitor.cookie } });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].id, created.body.id);
});

test("HTTP: общая ссылка открывает сборку без cookie и не выдаёт данные сессии", async t => {
  const app = await fixture(t);
  const visitor = await session(app);
  const created = await save(app, visitor);
  const shared = await request(app, "/api/saved-builds/" + created.body.id);
  assert.equal(shared.status, 200);
  assert.equal(shared.body.canEdit, false);
  assert.deepEqual(shared.body.parts, { cpu: 0 });
  for (const key of ["ownerId", "token", "csrfToken", "requestHash", "requestId"])
    assert.equal(Object.hasOwn(shared.body, key), false, key);
  assert.deepEqual((await request(app, "/api/saved-builds")).body.items, []);
});

test("HTTP: CSRF, Origin и авторство защищают запись и чужие сборки", async t => {
  const app = await fixture(t);
  const owner = await session(app), other = await session(app);
  const created = await save(app, owner);
  const route = "/api/saved-builds/" + created.body.id;
  const withoutCSRF = await request(app, "/api/saved-builds", { method: "POST", headers: { Cookie: owner.cookie, "Content-Type": "application/json" }, body: { name: "Нет CSRF", parts: {}, requestId: randomUUID() } });
  assert.equal(withoutCSRF.status, 403);
  const foreignOrigin = await request(app, "/api/saved-builds", { method: "POST", headers: auth(app, owner, { Origin: "https://other.example" }), body: { name: "Чужой Origin", parts: {}, requestId: randomUUID() } });
  assert.equal(foreignOrigin.status, 403);
  const anonymousWrite = await request(app, route, { method: "DELETE" });
  assert.equal(anonymousWrite.status, 401);
  const otherUpdate = await request(app, route, { method: "PUT", headers: auth(app, other), body: { name: "Подмена", parts: {}, version: 1 } });
  assert.equal(otherUpdate.status, 404);
  assert.equal((await request(app, route, { method: "DELETE", headers: auth(app, other) })).status, 404);
  const ownList = await request(app, "/api/saved-builds", { headers: { Cookie: owner.cookie } });
  const otherList = await request(app, "/api/saved-builds", { headers: { Cookie: other.cookie } });
  assert.equal(ownList.body.items.length, 1);
  assert.deepEqual(otherList.body.items, []);
  assert.equal((await request(app, route, { headers: { Cookie: owner.cookie } })).body.canEdit, true);
});

test("HTTP: ошибочный состав или название не создают запись, конфликт даёт 422", async t => {
  const app = await fixture(t);
  const visitor = await session(app);
  for (const parts of [{ cpu: false }, { cpu: 9999 }, { gpu: 0 }, { unknown: 0 }, null, []])
    assert.equal((await save(app, visitor, { parts })).status, 400, JSON.stringify(parts));
  const conflict = await save(app, visitor, { parts: { gpu: 85, psu: 40 } });
  assert.equal(conflict.status, 422);
  assert.match(conflict.body.error, /конфликт/);
  for (const name of ["", " ", "x".repeat(81), 123, "с\nпереносом"])
    assert.equal((await save(app, visitor, { name })).status, 400, JSON.stringify(name));
  assert.equal((await save(app, visitor, { requestId: "bad-id" })).status, 400);
  const valid = await save(app, visitor, { name: "Я" });
  assert.equal(valid.status, 201);
  assert.equal((await request(app, "/api/saved-builds", { headers: { Cookie: visitor.cookie } })).body.items.length, 1);
});

test("HTTP: версия предотвращает потерю обновлений, автор может удалить сборку", async t => {
  const app = await fixture(t);
  const visitor = await session(app);
  const created = await save(app, visitor);
  const route = "/api/saved-builds/" + created.body.id;
  const updated = await request(app, route, { method: "PUT", headers: auth(app, visitor), body: { name: "Обновлена", parts: { cpu: 1 }, version: 1 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.version, 2);
  assert.deepEqual(updated.body.parts, { cpu: 1 });
  const stale = await request(app, route, { method: "PUT", headers: auth(app, visitor), body: { name: "Старое состояние", parts: {}, version: 1 } });
  assert.equal(stale.status, 409);
  assert.equal((await request(app, route)).body.name, "Обновлена");
  const deleted = await request(app, route, { method: "DELETE", headers: auth(app, visitor) });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);
  assert.equal((await request(app, route)).status, 404);
  assert.deepEqual((await request(app, "/api/saved-builds", { headers: { Cookie: visitor.cookie } })).body.items, []);
});

test("HTTP: закрытие и повторный запуск сервера сохраняют данные и права автора", async t => {
  const directory = mkdtempSync(join(tmpdir(), "sobrano-http-restart-"));
  const databasePath = join(directory, "site.sqlite");
  let app = await startServer({ port: 0, databasePath });
  let closed = false;
  t.after(async () => { if (!closed) await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const visitor = await session(app);
  const created = await save(app, visitor, { name: "После перезапуска" });
  assert.equal(created.status, 201);
  await app.close(); closed = true;
  app = await startServer({ port: 0, databasePath }); closed = false;
  const loaded = await request(app, "/api/saved-builds/" + created.body.id, { headers: { Cookie: visitor.cookie } });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.name, "После перезапуска");
  assert.equal(loaded.body.canEdit, true);
  assert.deepEqual(loaded.body.parts, { cpu: 0 });
  const priorSession = await request(app, "/api/session", { headers: { Cookie: visitor.cookie } });
  assert.equal(priorSession.body.csrfToken, visitor.csrf);
  assert.equal(priorSession.headers.get("set-cookie"), null);
});
