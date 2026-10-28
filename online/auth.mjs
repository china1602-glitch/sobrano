/* Пароли не хранятся открыто. Один формат работает в Node.js и Workers.
   100000 — поддерживаемый предел PBKDF2 у выбранного облачного WebCrypto.
   Для большого публичного сервиса нужны отдельная оценка нагрузки и Argon2id. */
import { StoreError } from './store.mjs';
const ITERATIONS = 100000;
const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g) || [], byte => parseInt(byte, 16));

export function accountInput(body, registration = false) {
  const expected = registration ? ['username', 'password', 'displayName'] : ['username', 'password'];
  if (!body || Object.keys(body).some(key => !expected.includes(key)) || !Object.hasOwn(body, 'username') || !Object.hasOwn(body, 'password'))
    throw new StoreError(400, 'Нужны логин и пароль.');
  if (typeof body.username !== 'string' || !/^[A-Za-z0-9_]{3,32}$/.test(body.username))
    throw new StoreError(400, 'Логин: от 3 до 32 латинских букв, цифр или знаков _.');
  if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128 || !body.password.trim() || /[\u0000-\u001f\u007f]/.test(body.password))
    throw new StoreError(400, 'Пароль: от 10 до 128 символов без переносов строк.');
  const username = body.username.toLowerCase();
  let displayName = username;
  if (registration && Object.hasOwn(body, 'displayName')) {
    if (typeof body.displayName !== 'string' || body.displayName.trim().length > 60 || /[\u0000-\u001f\u007f]/.test(body.displayName))
      throw new StoreError(400, 'Имя должно содержать не более 60 символов без переносов строк.');
    displayName = body.displayName.trim() || username;
  }
  return { username, password: body.password, displayName };
}

async function derive(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256));
}
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${hex(salt)}$${hex(await derive(password, salt))}`;
}
export async function verifyPassword(password, saved) {
  const pattern = /^pbkdf2-sha256\$100000\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
  const parts = typeof saved === 'string' ? saved.match(pattern) : null;
  // Отсутствующий пользователь проходит ту же дорогую операцию, что неверный пароль.
  const actual = await derive(password, parts ? unhex(parts[1]) : new Uint8Array(16));
  const expected = parts ? unhex(parts[2]) : new Uint8Array(32);
  let mismatch = parts ? 0 : 1;
  for (let i = 0; i < actual.length; i++) mismatch |= actual[i] ^ expected[i];
  return mismatch === 0;
}
