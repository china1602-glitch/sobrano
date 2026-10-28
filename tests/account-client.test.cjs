'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/backend-client.js'), 'utf8');
const user = { id: '12345678-1234-4123-8123-123456789abc', username: 'student_1', displayName: 'Студент' };
const record = { id: '12345678-1234-4123-8123-123456789abc', name: 'Рабочий ПК', parts: { cpu: 0 }, version: 1, canEdit: true, createdAt: '2026-10-28T12:00:00.000Z', updatedAt: '2026-10-28T12:00:00.000Z' };
function client(handler, enabled = true) {
  const calls = [];
  const window = {
    SOBRANO_RUNTIME: { backend: 'server', baseURL: 'http://localhost:8080/', apiBase: 'api/', features: { savedBuilds: true, accounts: enabled } },
    SOBRANO_SERVER_DATA: {},
    SobranoCore: { products: [{ id: 'p0', i: 0, c: 'cpu' }], partsString: JSON.stringify, validateParts: parts => parts },
  };
  vm.runInNewContext(source, { window, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      const call = { url: String(url), options }; calls.push(call);
      const result = await handler(call);
      const status = result.status || 200;
      return { ok: status >= 200 && status < 300, status, json: async () => result.body };
    },
  });
  return { api: window.SobranoBackend, calls };
}
test('регистрация использует CSRF гостя и заменяет кэш сессии после ротации', async () => {
  const { api, calls } = client(call => ({ body: call.url.endsWith('/session') ? { user: null, csrfToken: 'guest-csrf' } : call.url.endsWith('/auth/register') ? { user, csrfToken: 'account-csrf' } : record }));
  await api.auth.register('student_1', 'safe-example-password', 'Студент');
  assert.equal(api.auth.user.username, user.username);
  assert.equal(api.auth.loaded, true);
  await api.saved.create(record.name, record.parts, record.id);
  const register = calls.find(call => call.url.endsWith('/auth/register'));
  const saved = calls.find(call => call.url.endsWith('/saved-builds'));
  assert.equal(register.options.headers['X-CSRF-Token'], 'guest-csrf');
  assert.equal(saved.options.headers['X-CSRF-Token'], 'account-csrf');
  assert.equal(register.options.credentials, 'same-origin');
  assert.equal(JSON.parse(register.options.body).password, 'safe-example-password');
  assert(!register.url.includes('safe-example-password'));
  assert.equal(calls.filter(call => call.url.endsWith('/session')).length, 1);
});
test('выход очищает пользователя и кэш CSRF; следующее сохранение получает новую гостевую сессию', async () => {
  let sessions = 0;
  const { api, calls } = client(call => {
    if (call.url.endsWith('/auth/me')) return { body: { user, csrfToken: 'account-csrf' } };
    if (call.url.endsWith('/auth/logout')) return { body: { user: null, csrfToken: null } };
    if (call.url.endsWith('/session')) return { body: { user: null, csrfToken: 'guest-csrf-' + (++sessions) } };
    return { body: record };
  });
  await api.auth.me();
  await api.auth.logout();
  assert.equal(api.auth.user, null);
  await api.saved.create(record.name, record.parts, record.id);
  const logout = calls.find(call => call.url.endsWith('/auth/logout'));
  assert.equal(logout.options.headers['X-CSRF-Token'], 'account-csrf');
  assert.equal(calls.at(-1).options.headers['X-CSRF-Token'], 'guest-csrf-1');
});
test('ошибка входа возвращается форме, повторная попытка заново запрашивает сессию', async () => {
  let attempts = 0;
  const { api, calls } = client(call => call.url.endsWith('/session')
    ? { body: { user: null, csrfToken: 'guest-csrf' } }
    : ++attempts === 1 ? { status: 401, body: { error: 'Неверный логин или пароль.' } } : { body: { user, csrfToken: 'account-csrf' } });
  await assert.rejects(api.auth.login('student_1', 'wrong-example-password'), error => error.status === 401);
  assert.equal(api.auth.user, null);
  await api.auth.login('student_1', 'safe-example-password');
  assert.equal(api.auth.user.id, user.id);
  assert.equal(calls.filter(call => call.url.endsWith('/session')).length, 2);
});
test('в режиме без аккаунтов клиент не изображает регистрацию и не отправляет пароль', async () => {
  const { api, calls } = client(() => { throw new Error('fetch must not run'); }, false);
  assert.equal(api.accountsAvailable, false);
  await assert.rejects(api.auth.login('student_1', 'safe-example-password'), /Node.js/);
  await assert.rejects(api.auth.register('student_1', 'safe-example-password', ''), /Node.js/);
  assert.equal(calls.length, 0);
});
test('некорректный ответ сервера не становится состоянием авторизованного пользователя', async () => {
  const { api } = client(() => ({ body: { user: { ...user, username: '<script>' }, csrfToken: 'csrf' } }));
  await assert.rejects(api.auth.me(), /некорректные данные аккаунта/);
  assert.equal(api.auth.user, null);
  assert.equal(api.auth.loaded, false);
});
