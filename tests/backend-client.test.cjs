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
