const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../js/backend-client.js'),'utf8');
function client(apiBase='api/', response={parts:{},check:{status:'incomplete'},budget:{value:0},assessments:{p0:{allowed:true}}}, ok=true) {
  const calls=[];
  const window={
    SOBRANO_RUNTIME:{backend:'python',baseURL:'https://example.test/sobrano/',apiBase},
    SOBRANO_SERVER_DATA:{},
    SobranoCore:{
      products:[{id:'p0',i:0,c:'cpu'}],
      partsString:parts=>JSON.stringify(parts),
      validateParts:parts=>parts
    }
  };
  vm.runInNewContext(source,{window,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,
    fetch:async(url,options)=>{calls.push({url:String(url),options});return {ok,status:ok?200:503,json:async()=>response};}
  });
  return {api:window.SobranoBackend,calls};
}
test('API base без завершающего слеша сохраняет подпапку api',async()=>{
  const {api,calls}=client('api');
  await api.prepare({});
  assert.equal(calls[0].url,'https://example.test/sobrano/api/configuration');
  assert.equal(calls[0].options.method,'POST');
  assert.equal(calls[0].options.body,'{"parts":{}}');
});
test('API base со слешем и относительная подпапка дают одинаковый адрес',async()=>{
  const {api,calls}=client('api/');
  await api.prepare({});
  assert.equal(calls[0].url,'https://example.test/sobrano/api/configuration');
  assert.equal(api.check({}).status,'incomplete');
});
test('Ошибка сервера передаётся вызывающему интерфейсу',async()=>{
  const {api}=client('api/',{error:'Сервер временно недоступен'},false);
  await assert.rejects(api.prepare({}),/Сервер временно недоступен/);
  assert.throws(()=>api.check({}),/ещё нет ответа/);
});
test('Неполный ответ не сохраняется как готовая проверка',async()=>{
  const {api}=client('api/',{parts:{},check:{},budget:{}});
  await assert.rejects(api.prepare({}),/неполный результат/);
  assert.throws(()=>api.check({}),/ещё нет ответа/);
});

test('Нулевой бюджет передаётся Python, пустое поле не ограничивает подбор',async()=>{
  const {api,calls}=client('api/',{ids:[]});
  await api.builds('',0);
  assert.equal(new URL(calls[0].url).searchParams.get('budget'),'0');
  await api.builds('',null);
  assert.equal(new URL(calls[1].url).searchParams.has('budget'),false);
  await api.builds('Игры',100000);
  const query = new URL(calls[2].url).searchParams;
  assert.equal(query.get('budget'),'100000');
  assert.equal(query.get('task'),'Игры');
});
test('Неверный бюджет отклоняется до запроса к Python',async()=>{
  const {api,calls}=client('api/',{ids:[]});
  for (const value of [-1,0.5,NaN,Infinity,'oops',Number.MAX_SAFE_INTEGER+1])
    await assert.rejects(api.builds('',value),/целых тенге/);
  assert.equal(calls.length,0);
});

const savedID = '12345678-1234-4123-8123-123456789abc';
const requestID = '98765432-1234-4123-8123-123456789abc';
const savedExample = { id: savedID, name: 'Мой ПК', parts: { cpu: 0 }, version: 1, canEdit: true,
  createdAt: '2026-10-28T12:00:00.000Z', updatedAt: '2026-10-28T12:00:00.000Z' };
function onlineClient(handler, available = true) {
  const calls=[];
  const window={
    SOBRANO_RUNTIME:{backend:'server',baseURL:'https://example.test/sobrano/',apiBase:'api/',features:{savedBuilds:available}},
    SOBRANO_SERVER_DATA:{},
    SobranoCore:{products:[{id:'p0',i:0,c:'cpu'}],partsString:JSON.stringify,validateParts:parts=>parts}
  };
  vm.runInNewContext(source,{window,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,
    fetch:async(url,options)=>{
      const call={url:String(url),options}; calls.push(call);
      const result=await handler(call);
      const status=result.status || 200;
      return {ok:status>=200&&status<300,status,json:async()=>result.body};
    }
  });
  return {api:window.SobranoBackend,calls};
}
test('сохранение онлайн использует сессию, cookie и CSRF; повторная попытка сохраняет requestId', async()=>{
  const {api,calls}=onlineClient(call=>({body:call.url.endsWith('/session')?{csrfToken:'csrf-value'}:savedExample}));
  assert.equal(api.enabled,true);
  assert.equal(api.savedAvailable,true);
  await api.saved.create('Мой ПК',{cpu:0},requestID);
  await api.saved.create('Мой ПК',{cpu:0},requestID);
  assert.equal(calls.filter(c=>c.url.endsWith('/session')).length,1);
  const writes=calls.filter(c=>c.options.method==='POST');
  assert.equal(writes.length,2);
  for(const call of writes){
    assert.equal(call.options.credentials,'same-origin');
    assert.equal(call.options.headers['X-CSRF-Token'],'csrf-value');
    assert.equal(call.options.headers['Content-Type'],'application/json');
    assert.equal(JSON.parse(call.options.body).parts.cpu,0);
    assert.equal(JSON.parse(call.options.body).requestId,requestID);
    assert(!call.url.includes('csrf-value'));
  }
});
test('получение публичной сборки не создаёт ложную регистрацию и принимает индекс ноль', async()=>{
  const {api,calls}=onlineClient(()=>({body:{...savedExample,canEdit:false}}));
  const result=await api.saved.load(savedID);
  assert.equal(result.parts.cpu,0);
  assert.equal(result.canEdit,false);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://example.test/sobrano/api/saved-builds/'+savedID);
});
test('изменение и удаление требуют CSRF, версия отправляется для защиты от старого обновления', async()=>{
  const {api,calls}=onlineClient(call=>({body:call.url.endsWith('/session')?{csrfToken:'csrf-value'}:call.options.method==='DELETE'?{deleted:true}:{...savedExample,version:2}}));
  await api.saved.update(savedID,'Изменённое имя',{cpu:0},1);
  await api.saved.remove(savedID);
  const update=calls.find(c=>c.options.method==='PUT');
  assert.equal(JSON.parse(update.options.body).version,1);
  assert.equal(update.options.headers['X-CSRF-Token'],'csrf-value');
  assert.equal(calls.find(c=>c.options.method==='DELETE').options.headers['X-CSRF-Token'],'csrf-value');
});
test('HTTP 409 сохраняется для понятной обработки конфликта версий', async()=>{
  const {api}=onlineClient(call=>call.url.endsWith('/session')?{body:{csrfToken:'csrf-value'}}:{status:409,body:{error:'Версия уже изменилась'}});
  await assert.rejects(api.saved.update(savedID,'Мой ПК',{cpu:0},1),error=>error.status===409 && /Версия/.test(error.message));
});
test('недоступный или неверный saved API не выдаёт успех и не отправляет запрос по чужому пути', async()=>{
  const disabled=onlineClient(()=>{throw Error('must not fetch')},false);
  await assert.rejects(disabled.api.saved.list(),/онлайн-сервером/);
  assert.equal(disabled.calls.length,0);
  const {api,calls}=onlineClient(()=>({body:{...savedExample,parts:{gpu:0}}}));
  await assert.rejects(api.saved.load('../session'),/идентификатор/);
  assert.equal(calls.length,0);
  await assert.rejects(api.saved.load(savedID),/некорректную сохранённую/);
});
