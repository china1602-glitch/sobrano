'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
let startServer;
test.before(async()=>({startServer}=await import('../online/server.mjs')));
async function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'sobrano-auth-'));
  const app=await startServer({port:0,databasePath:join(directory,'auth.sqlite')});
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  return app;
}
async function req(app,route,{method='GET',body,visitor,headers={}}={}) {
  const response=await fetch(app.url+route,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),
    ...(visitor?{Cookie:visitor.cookie,'X-CSRF-Token':visitor.csrf,Origin:app.url}:{}),...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json(),headers:response.headers};
}
function visitorFrom(response) {
  return {cookie:response.headers.get('set-cookie')?.split(';')[0],csrf:response.body.csrfToken,user:response.body.user};
}
async function guest(app) {const r=await req(app,'/api/session');assert.equal(r.status,200);assert.equal(r.body.user,null);return visitorFrom(r);}
async function register(app,visitor,username='student_a',password='my long password',{displayName='Студент'}={}) {
  return req(app,'/api/auth/register',{method:'POST',visitor,body:{username,password,displayName}});
}
async function login(app,visitor,username='student_a',password='my long password',headers={}) {
  return req(app,'/api/auth/login',{method:'POST',visitor,body:{username,password},headers});
}
async function save(app,visitor,name='Мой состав') {
  return req(app,'/api/saved-builds',{method:'POST',visitor,body:{name,parts:{cpu:0},requestId:randomUUID()}});
}

test('Аккаунт: регистрация хранит хеш с солью, логин нормализуется, старый гостевой токен отозван',async t=>{
  const app=await fixture(t),anon=await guest(app);
  const build=await save(app,anon);assert.equal(build.status,201);
  const registered=await register(app,anon,'Student_A');
  assert.equal(registered.status,201);
  assert.deepEqual(Object.keys(registered.body).sort(),['csrfToken','user']);
  assert.deepEqual(Object.keys(registered.body.user).sort(),['displayName','id','username']);
  assert.equal(registered.body.user.username,'student_a');
  assert.equal(registered.body.user.displayName,'Студент');
  const account=visitorFrom(registered);
  assert.notEqual(account.cookie,anon.cookie);assert.notEqual(account.csrf,anon.csrf);
  assert.match(registered.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
  const row=await app.db.prepare('SELECT * FROM accounts').first();
  assert.match(row.password_hash,/^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.ok(!row.password_hash.includes('my long password'));
  const tokens=await app.db.prepare('SELECT token_hash FROM account_sessions').all();
  assert.equal(tokens.results.length,1);assert.notEqual(tokens.results[0].token_hash,account.cookie.split('=')[1]);
  assert.equal((await req(app,'/api/saved-builds',{visitor:anon})).body.items.length,0);
  assert.equal((await req(app,'/api/saved-builds/'+build.body.id,{visitor:anon})).body.canEdit,false);
  assert.equal((await req(app,'/api/saved-builds',{visitor:account})).body.items[0].id,build.body.id);
  assert.equal((await req(app,'/api/auth/me',{visitor:account})).body.user.id,account.user.id);
  assert.equal((await req(app,'/runtime.json')).body.features.accounts,true);
});

test('Аккаунт: ошибки полей, повтор логина и методы не создают лишние записи',async t=>{
  const app=await fixture(t),anon=await guest(app);
  for(const body of [ {},{username:'ab',password:'my long password'},{username:'русский',password:'my long password'},
    {username:'student',password:'short'},{username:'student',password:' '.repeat(12)},
    {username:'student',password:'x'.repeat(129)},{username:'student',password:'my long password',displayName:'x'.repeat(61)},
    {username:'student',password:'my long password',extra:true}]) {
    assert.equal((await req(app,'/api/auth/register',{method:'POST',visitor:anon,body})).status,400,JSON.stringify(body));
  }
  assert.equal((await register(app,anon)).status,201);
  const other=await guest(app);
  assert.equal((await register(app,other,'STUDENT_A')).status,409);
  assert.equal(await app.db.prepare('SELECT COUNT(*) AS n FROM accounts').first('n'),1);
  assert.equal((await req(app,'/api/auth/login')).status,405);
  assert.equal((await req(app,'/api/auth/me',{method:'POST',body:{}})).status,405);
});

test('Аккаунт: вход с другого браузера показывает те же сборки, гостевые черновики сохраняются',async t=>{
  const app=await fixture(t),anon=await guest(app);
  const first=visitorFrom(await register(app,anon));
  const own=await save(app,first,'В аккаунте');
  const secondGuest=await guest(app),draft=await save(app,secondGuest,'Гостевой черновик');
  const signed=await login(app,secondGuest,'STUDENT_A');assert.equal(signed.status,200);
  const second=visitorFrom(signed);
  const ids=(await req(app,'/api/saved-builds',{visitor:second})).body.items.map(x=>x.id).sort();
  assert.deepEqual(ids,[own.body.id,draft.body.id].sort());
  assert.deepEqual((await req(app,'/api/saved-builds',{visitor:first})).body.items.map(x=>x.id).sort(),ids);
  assert.notEqual(second.cookie,secondGuest.cookie);
  assert.equal((await req(app,'/api/saved-builds/'+draft.body.id,{visitor:secondGuest})).body.canEdit,false);
  assert.equal((await req(app,'/api/saved-builds/'+own.body.id)).body.canEdit,false);
  assert.equal((await req(app,'/api/auth/me',{visitor:first})).body.user.id,second.user.id);
});

test('Аккаунт: чужие записи не переносятся при переключении, редактирование и удаление защищены',async t=>{
  const app=await fixture(t);
  const a=visitorFrom(await register(app,await guest(app),'student_a'));
  const aBuild=await save(app,a,'Принадлежит A');
  const b=visitorFrom(await register(app,await guest(app),'student_b'));
  const bBuild=await save(app,b,'Принадлежит B');
  assert.equal((await req(app,'/api/saved-builds/'+aBuild.body.id,{method:'DELETE',visitor:b,body:{}})).status,404);
  assert.equal((await req(app,'/api/saved-builds/'+aBuild.body.id,{method:'PUT',visitor:b,body:{name:'Чужое',parts:{cpu:1},version:1}})).status,404);
  const switched=await login(app,a,'student_b');assert.equal(switched.status,200);
  const next=visitorFrom(switched);
  assert.deepEqual((await req(app,'/api/saved-builds',{visitor:next})).body.items.map(x=>x.id),[bBuild.body.id]);
  const back=visitorFrom(await login(app,next,'student_a'));
  assert.deepEqual((await req(app,'/api/saved-builds',{visitor:back})).body.items.map(x=>x.id),[aBuild.body.id]);
  assert.equal((await req(app,'/api/saved-builds',{visitor:a})).body.items.length,0);
  const updated=await req(app,'/api/saved-builds/'+aBuild.body.id,{method:'PUT',visitor:back,body:{name:'Исправлено A',parts:{cpu:1},version:1}});
  assert.equal(updated.status,200);assert.equal(updated.body.version,2);
});

test('Аккаунт: неверные данные входа одинаковы для неизвестного логина и неверного пароля',async t=>{
  const app=await fixture(t);
  const a=visitorFrom(await register(app,await guest(app)));
  const other=await guest(app);
  const wrong=await login(app,other,'student_a','wrong password value');
  const unknown=await login(app,other,'missing_user','wrong password value');
  assert.equal(wrong.status,401);assert.equal(unknown.status,401);assert.deepEqual(wrong.body,unknown.body);
  assert.equal(wrong.headers.get('set-cookie'),null);
  assert.equal((await req(app,'/api/auth/me',{visitor:a})).body.user.username,'student_a');
  assert.equal((await req(app,'/api/auth/me',{visitor:other})).body.user,null);
});

test('Аккаунт: CSRF и Origin обязательны для регистрации, входа и выхода; logout отзывает токен',async t=>{
  const app=await fixture(t),anon=await guest(app);
  for(const route of ['/api/auth/register','/api/auth/login']) {
    const body={username:'student_a',password:'my long password'};
    assert.equal((await req(app,route,{method:'POST',body,headers:{Cookie:anon.cookie}})).status,403);
    assert.equal((await req(app,route,{method:'POST',visitor:anon,body,headers:{Origin:'https://other.test'}})).status,403);
    assert.equal((await req(app,route,{method:'POST',body})).status,401);
  }
  const a=visitorFrom(await register(app,anon)),build=await save(app,a);
  const noToken=await req(app,'/api/auth/logout',{method:'POST',body:{},headers:{Cookie:a.cookie}});
  assert.equal(noToken.status,403);
  const loggedOut=await req(app,'/api/auth/logout',{method:'POST',visitor:a,body:{}});
  assert.equal(loggedOut.status,200);assert.deepEqual(loggedOut.body,{user:null,csrfToken:null});
  assert.match(loggedOut.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await req(app,'/api/saved-builds',{visitor:a})).body.items.length,0);
  assert.equal((await req(app,'/api/saved-builds/'+build.body.id,{method:'DELETE',visitor:a})).status,401);
  assert.equal((await req(app,'/api/saved-builds/'+build.body.id)).status,200);
  const renewed=await req(app,'/api/auth/me',{visitor:a});
  assert.equal(renewed.body.user,null);assert.notEqual(renewed.body.csrfToken,a.csrf);
  const restored=visitorFrom(await login(app,visitorFrom(renewed)));
  assert.equal((await req(app,'/api/saved-builds',{visitor:restored})).body.items[0].id,build.body.id);
});

test('Аккаунт: ограничены попытки одного логина и одного клиента, подмена XFF не обходит защиту',async t=>{
  const app=await fixture(t),anon=await guest(app);
  for(let i=0;i<8;i++) assert.equal((await login(app,anon,'missing_user','wrong password value')).status,401);
  const blocked=await login(app,anon,'MISSING_USER','wrong password value');
  assert.equal(blocked.status,429);assert.ok(Number(blocked.headers.get('retry-after'))>0);
  const buckets=await app.db.prepare('SELECT bucket_key FROM auth_rate_limits').all();
  assert.equal(buckets.results.length,2);assert.ok(buckets.results.every(x=>/^[a-f0-9]{64}$/.test(x.bucket_key)));
  for(let i=0;i<31;i++) assert.equal((await login(app,anon,'missing_'+i,'wrong password value',{'X-Forwarded-For':'10.0.0.'+i,'CF-Connecting-IP':'10.0.1.'+i})).status,401);
  const clientBlocked=await login(app,anon,'different_user','wrong password value',{'X-Forwarded-For':'12.0.0.1'});
  assert.equal(clientBlocked.status,429);
  assert.ok(await app.db.prepare('SELECT COUNT(*) AS n FROM auth_rate_limits').first('n')<=33);
});

test('Аккаунт: перезапуск SQLite сохраняет вход и доступ к сборкам',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'sobrano-auth-restart-')),databasePath=join(directory,'auth.sqlite');
  let app=await startServer({port:0,databasePath}),closed=false;
  t.after(async()=>{if(!closed)await app.close();rmSync(directory,{recursive:true,force:true});});
  const a=visitorFrom(await register(app,await guest(app))),build=await save(app,a,'Останется после перезапуска');
  await app.close();closed=true;app=await startServer({port:0,databasePath});closed=false;
  assert.equal((await req(app,'/api/auth/me',{visitor:a})).body.user.id,a.user.id);
  assert.equal((await req(app,'/api/saved-builds',{visitor:a})).body.items[0].id,build.body.id);
  const another=visitorFrom(await login(app,await guest(app)));
  assert.equal(another.user.id,a.user.id);
  assert.equal((await req(app,'/api/saved-builds/'+build.body.id,{visitor:another})).body.canEdit,true);
});

test('Аккаунт: новые миграции сохраняют существующие гостевые составы и исходную схему',async()=>{
  const {createNodeDatabase}=await import('../online/node-db.mjs');
  const {createStore}=await import('../online/store.mjs');
  const {hashPassword}=await import('../online/auth.mjs');
  const db=createNodeDatabase(':memory:');
  try {
    db.exec(readFileSync(join(__dirname,'../drizzle/0000_useful_stingray.sql'),'utf8'));
    // До добавления аккаунтов старый store не нужен: заполняем прежние четыре таблицы.
    const owner=randomUUID(),requestId=randomUUID(),buildId=randomUUID();
    await db.prepare('INSERT INTO visitor_sessions VALUES (?, ?, ?, ?, ?)').bind(owner,'a'.repeat(64),'b'.repeat(64),'2026-10-28T00:00:00.000Z','2027-01-26T00:00:00.000Z').run();
    await db.prepare('INSERT INTO saved_builds VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(buildId,owner,'Старая сборка','{"cpu":0}','2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z',1,requestId,'c'.repeat(64)).run();
    db.exec(readFileSync(join(__dirname,'../drizzle/0001_majestic_william_stryker.sql'),'utf8'));
    assert.equal((await db.prepare('SELECT * FROM saved_builds WHERE id = ?').bind(buildId).first()).owner_id,owner);
    const store=createStore(db),newGuest=await store.createSession();
    const account=await store.registerAccount(newGuest.token,'student_m','Имя',await hashPassword('another long password'));
    assert.equal(account.user.username,'student_m');
    assert.equal((await store.getBuild(buildId)).name,'Старая сборка');
  } finally {db.close();}
});

test('Аккаунт: соли различаются, сессии истекают, выход на одном устройстве не выключает другое',async t=>{
  const app=await fixture(t);
  const a=visitorFrom(await register(app,await guest(app),'student_a'));
  const b=visitorFrom(await register(app,await guest(app),'student_b'));
  const hashes=(await app.db.prepare('SELECT password_hash FROM accounts').all()).results.map(x=>x.password_hash);
  assert.equal(hashes.length,2);assert.notEqual(hashes[0],hashes[1]);
  const a2=visitorFrom(await login(app,await guest(app),'student_a'));
  assert.equal((await req(app,'/api/auth/logout',{method:'POST',visitor:a,body:{}})).status,200);
  assert.equal((await req(app,'/api/auth/me',{visitor:a2})).body.user.id,a.user.id);
  assert.equal((await req(app,'/api/auth/me',{visitor:b})).body.user.id,b.user.id);
  const token=a2.cookie.split('=')[1];
  const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
  await app.db.prepare('UPDATE account_sessions SET expires_at = ? WHERE token_hash = ?').bind('2000-01-01T00:00:00.000Z',digest).run();
  assert.equal((await req(app,'/api/auth/me',{visitor:a2})).body.user,null);
  assert.equal((await req(app,'/api/auth/me',{visitor:b})).body.user.id,b.user.id);
});

test('Аккаунт: два одновременных гостевых входа не превышают квоту и сохраняют отклонённый черновик',async()=>{
  const {createNodeDatabase}=await import('../online/node-db.mjs');
  const {createStore}=await import('../online/store.mjs');
  const {hashPassword}=await import('../online/auth.mjs');
  const db=createNodeDatabase(':memory:');
  db.exec(readFileSync(join(__dirname,'../online/schema.sql'),'utf8'));
  try {
    const store=createStore(db),seed=await store.createSession();
    const a=await store.registerAccount(seed.token,'student_a','Студент',await hashPassword('my long password'));
    const account=await store.findAccount('student_a');
    for(let i=0;i<49;i++)await store.saveBuild(a.ownerId,'Запись '+i,{},randomUUID());
    const guests=await Promise.all([store.createSession(),store.createSession()]);
    const drafts=await Promise.all(guests.map((s,i)=>store.saveBuild(s.ownerId,'Черновик '+i,{cpu:0},randomUUID())));
    const results=await Promise.allSettled(guests.map(s=>store.loginAccount(s.token,account)));
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.status===409).length,1);
    assert.equal((await store.listBuilds(a.ownerId)).length,50);
    const rejected=results.findIndex(x=>x.status==='rejected');
    assert.equal((await store.listBuilds(guests[rejected].ownerId))[0].id,drafts[rejected].build.id);
    assert.equal((await store.findSession(guests[rejected].token)).ownerId,guests[rejected].ownerId);
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM account_sessions').first('n'),2);
  } finally {db.close();}
});
