'use strict';
// Явный список файлов одинаково работает в Windows и Linux, без shell-glob.
const { readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const root = resolve(__dirname, '..');
const files = readdirSync(resolve(root, 'tests'))
  .filter(name => name.endsWith('.test.cjs'))
  .sort()
  .map(name => resolve(root, 'tests', name));
if (!files.length) {
  console.error('JavaScript-тесты не найдены в tests/.');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status === null ? 1 : result.status;
}
