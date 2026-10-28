/* Локальный запуск того же серверного API, которое размещается в интернете. */
import http from 'node:http';
import { Readable } from 'node:stream';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAPI } from './api.mjs';
import { createStore } from './store.mjs';
import { createNodeDatabase } from './node-db.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SEED_REVISION = 'sobrano-190-2026-10-28-v1';
const TYPES = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png','.jpg':'image/jpeg',
  '.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.txt':'text/plain; charset=utf-8'};
export const PUBLIC_PATH = /^(?:[a-z]+\.html|js\/[a-z-]+\.js|css\/[a-z-]+\.css|data\/[a-z-]+\.json|assets\/(?:favicon\.svg|fonts\/[\w.-]+|products\/[\w.-]+))$/;

export async function startServer({ port = 8080, host = '127.0.0.1', databasePath = path.join(ROOT, 'instance/sobrano.sqlite') } = {}) {
  const db = createNodeDatabase(databasePath);
  try {
    db.exec(await readFile(path.join(ROOT, 'online/schema.sql'), 'utf8'));
    const raw = JSON.parse(await readFile(path.join(ROOT, 'data/catalog.json'), 'utf8'));
    const offers = JSON.parse(await readFile(path.join(ROOT, 'data/offers.json'), 'utf8'));
    const store = createStore(db);
    await store.seedCatalog(raw, offers, SEED_REVISION);
    const api = createAPI({ store, engine: 'Node.js ' + process.versions.node,
      getClientAddress: request => request.headers.get('x-sobrano-client-key') || 'unknown' });
    const server = http.createServer(async (incoming, outgoing) => {
      try {
        const origin = 'http://' + (incoming.headers.host || 'localhost');
        const url = new URL(incoming.url || '/', origin);
        const headers = new Headers(incoming.headers);
        // Доверяем адресу сокета, а не переданным посетителем X-Forwarded-For/CF-*.
        headers.set('x-sobrano-client-key', incoming.socket.remoteAddress || 'unknown');
        const request = new Request(url, { method: incoming.method, headers,
          ...(['GET','HEAD'].includes(incoming.method) ? {} : {body: Readable.toWeb(incoming), duplex: 'half'}) });
        const response = await api(request);
        if (response) {
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
          return;
        }
        if (!['GET','HEAD'].includes(incoming.method)) { outgoing.writeHead(405); outgoing.end(); return; }
        const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
        const target = path.resolve(ROOT, relative);
        const resolved = path.relative(ROOT, target).split(path.sep).join('/');
        if (!PUBLIC_PATH.test(resolved) || resolved.includes('\0') || resolved.split('/').some(part=>part.startsWith('.')))
          throw Object.assign(new Error('not found'), {code:'ENOENT'});
        const actual = await realpath(target);
        if (path.relative(ROOT, actual).startsWith('..')) throw Object.assign(new Error('not found'), {code:'ENOENT'});
        const bytes = await readFile(actual);
        outgoing.writeHead(200, {'Content-Type':TYPES[path.extname(actual)] || 'application/octet-stream',
          'Content-Length':bytes.length,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
        outgoing.end(incoming.method === 'HEAD' ? undefined : bytes);
      } catch (error) {
        outgoing.writeHead(error.code === 'ENOENT' ? 404 : error instanceof URIError ? 400 : 500,
          {'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff'});
        outgoing.end(error.code === 'ENOENT' ? 'Страница не найдена.' : 'Не удалось обработать запрос.');
      }
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
    return { server, store, db, url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((resolve,reject)=>server.close(error=>{db.close();error?reject(error):resolve();})) };
  } catch (error) { db.close(); throw error; }
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Нужен Node.js 24 LTS или новее.');
  const args = process.argv.slice(2); const options = {};
  for (let i=0;i<args.length;i+=2) {
    const flag=args[i], value=args[i+1];
    if (!value || !['--port','--host','--db'].includes(flag)) throw Error('Параметры: --port 8080 --host 127.0.0.1 --db путь-к-базе');
    if (flag==='--port') { const p=Number(value); if(!Number.isInteger(p)||p<1||p>65535) throw Error('Порт должен быть от 1 до 65535.'); options.port=p; }
    else if(flag==='--host') { if(!['127.0.0.1','0.0.0.0'].includes(value))throw Error('Допустим host 127.0.0.1 или 0.0.0.0.');options.host=value; }
    else options.databasePath=path.resolve(value);
  }
  const app = await startServer(options);
  console.log('СОБРАНО — JavaScript API / Node.js / SQLite');
  const displayURL = app.url.replace('127.0.0.1','localhost');
  console.log('Сайт: '+displayURL+'/');
  console.log('Проверка сервера: '+displayURL+'/api/health');
  console.log('Каталог и сохранённые сборки хранятся в базе данных. Остановка: Ctrl+C.');
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>app.close().then(()=>process.exit(0)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error=>{console.error('Не удалось запустить сервер: '+error.message);process.exitCode=1;});
