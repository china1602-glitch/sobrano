import { createAPI } from './api.mjs';
import { createStore } from './store.mjs';
import catalog from '../data/catalog.json';
import offers from '../data/offers.json';
import { assets } from './generated-assets.mjs';

const applications = new WeakMap();
function application(db) {
  if (applications.has(db)) return applications.get(db);
  const store = createStore(db);
  let ready;
  const api = createAPI({store,engine:'Cloudflare Workers',getClientAddress:request=>request.headers.get('cf-connecting-ip')||'unknown',ensureReady:()=> {
    if (!ready) ready=store.seedCatalog(catalog,offers,'sobrano-190-2026-10-28-v1').catch(error=>{ready=undefined;throw error;});
    return ready;
  }});
  applications.set(db,api);
  return api;
}

export default {
  async fetch(request,env) {
    const url = new URL(request.url);
    if (url.pathname === '/runtime.json' || url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (!env.DB) return Response.json({error:'Серверная база данных ещё не подключена.'},{status:503,headers:{'Cache-Control':'no-store'}});
      return application(env.DB)(request);
    }
    if (!['GET','HEAD'].includes(request.method)) return new Response('Метод не поддерживается.',{status:405});
    let pathname;
    try {pathname=decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);} catch {return new Response('Неверный адрес.',{status:400});}
    const asset=assets[pathname];
    if (!asset) return new Response('Страница не найдена.',{status:404,headers:{'Content-Type':'text/plain; charset=utf-8'}});
    const body=asset.binary ? Uint8Array.from(atob(asset.body),c=>c.charCodeAt(0)) : asset.body;
    return new Response(request.method==='HEAD'?null:body,{headers:{'Content-Type':asset.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});
  },
};
