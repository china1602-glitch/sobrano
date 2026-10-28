'use strict';
// Проверка настоящего Chrome через DevTools Protocol, без npm-зависимостей.
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, readdirSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const publicURL = process.env.SOBRANO_PUBLIC_URL;
const chromePath = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch {} await delay(80); }
  throw new Error('Timeout: ' + label);
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; this.requestURLs = [];
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      else {
        this.events.push(m);
        if(m.method==='Network.requestWillBeSent') this.requestURLs.push(m.params.request.url);
        if(this.onEvent) this.onEvent(m);
      }
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, {once:true}); ws.addEventListener('error', reject, {once:true}); });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, {resolve,reject}); this.ws.send(JSON.stringify({id,method,params})); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}
(async () => {
  const children = []; let cdp;
  const checks = [];
  try {
    if (!chromePath) throw new Error('Chrome/Chromium не найден. Укажите CHROME_PATH — полный путь к браузеру.');
    if (typeof WebSocket !== 'function') throw new Error('Для браузерных проверок нужен Node.js 22 или новее.');
    const sqlDirectory = mkdtempSync(path.join(tmpdir(), 'sobrano-browser-db-'));
    if (!publicURL) for (const [port,command,args] of [[18080,'python',['-B','server.py','--port','18080']], [18081,'python',['-B','-m','http.server','18081','--bind','127.0.0.1','--directory',path.dirname(root)]], [18082,process.execPath,['online/server.mjs','--port','18082','--db',path.join(sqlDirectory,'browser.sqlite')]]]) {
      const p = spawn(command, args, {cwd:root, windowsHide:true, stdio:'ignore'});
      children.push(p);
      await until(async () => (await fetch('http://127.0.0.1:'+port+'/')).ok, 'server '+port);
    }
    const profile = mkdtempSync(path.join(tmpdir(), 'sobrano-browser-'));
    const chromeArgs = ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'];
    // Только для изолированного Linux CI без поддержки sandbox; обычный запуск его сохраняет.
    if (process.env.SOBRANO_CHROME_NO_SANDBOX === '1') chromeArgs.unshift('--no-sandbox');
    const chrome = spawn(chromePath, chromeArgs, {windowsHide:true,stdio:'ignore'});
    children.push(chrome);
    const port = await until(() => readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0], 'Chrome port');
    const targets = await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    cdp = await CDP.open(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Network.enable');
    await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:profile});
    await cdp.send('Emulation.setDeviceMetricsOverride', {width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    async function go(url) {
      cdp.events = [];
      await cdp.eval('window.SobranoApp = null');
      await cdp.send('Page.navigate',{url});
      await until(() => cdp.eval('Boolean(window.SOBRANO_READY && window.SobranoApp)'), url);
      assert.equal(await cdp.eval('window.SOBRANO_READY'), true, url);
      const errors = cdp.events.filter(e=>e.method==='Runtime.exceptionThrown');
      assert.equal(errors.length,0,'JS exception at '+url);
    }
    async function settled() { await until(()=>cdp.eval('!document.querySelector("[aria-busy=true]")'), 'idle'); await delay(180); }
    async function click(selector) { await cdp.eval('document.querySelector('+JSON.stringify(selector)+').click()'); await settled(); }
    async function select(selector,value) {
      await cdp.eval('(()=>{const el=document.querySelector('+JSON.stringify(selector)+');el.value='+JSON.stringify(value)+';el.dispatchEvent(new Event("change",{bubbles:true}));})()'); await settled();
    }
    async function check(label, fn) { await fn(); checks.push(label); console.log('PASS '+label); }
    const publicBackend = publicURL ? (await (await fetch(new URL('runtime.json', publicURL))).json()).backend : null;
    const modes = publicURL
      ? [[publicBackend, new URL(publicURL).href]]
      : [['static','http://127.0.0.1:18081/'+path.basename(root)+'/'], ['python','http://127.0.0.1:18080/'], ['server','http://127.0.0.1:18082/']];
    for (const [mode,base] of modes) {
      const downloadDir=mkdtempSync(path.join(tmpdir(),'sobrano-txt-'+mode+'-'));
      await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDir});
      cdp.requestURLs = [];
      await go(base); await cdp.eval('localStorage.clear()');
      for (const page of ['index.html','catalog.html','builds.html','builder.html','compare.html','favorites.html','about.html','account.html','product.html?id=p0','build.html?id=b0']) {
        await check(mode+' page '+page, async()=>{
          await go(base+page);
          assert.equal(await cdp.eval('window.SobranoApp.backend'),mode);
          assert.ok((await cdp.eval('document.querySelector("#app").innerText')).length>100);
          const broken = await cdp.eval('(async()=>{const bad=[];for(const a of document.querySelectorAll("a[href],script[src],link[href]")){const url=new URL(a.href||a.src,location.href);if(url.origin!==location.origin)continue;const r=await fetch(url,{method:"HEAD"});if(!r.ok)bad.push(url.href);if(url.hash&&url.pathname===location.pathname&&!document.getElementById(decodeURIComponent(url.hash.slice(1))))bad.push("anchor "+url.hash);}return bad;})()');
          assert.deepEqual(broken,[]);
        });
      }
      await check(mode+' favorites and comparison',async()=>{
        await go(base+'catalog.html?cat=cpu');
        const ids=await cdp.eval('[...document.querySelectorAll("#results [data-action=compare]")].slice(0,2).map(n=>n.dataset.index)');
        await click('[data-action=favorite][data-index="'+ids[0]+'"]');
        for(const id of ids) await click('[data-action=compare][data-index="'+id+'"]');
        await go(base+'favorites.html'); assert.equal(await cdp.eval('document.querySelectorAll("#results .product-row").length'),1);
        await go(base+'compare.html'); assert.ok(await cdp.eval('Boolean(document.querySelector(".compare-table"))'));
        await click('#only-differences');
        assert.ok(await cdp.eval('[...document.querySelectorAll(".compare-table tr.same")].every(tr=>tr.hidden)'));
        await click('[data-action=clear-compare]');
        assert.equal(await cdp.eval('document.querySelector(".compare-table")'),null);
      });
      await check(mode+' catalog search, sort, pagination and empty state',async()=>{
        await go(base+'catalog.html');
        const count=await cdp.eval('document.querySelectorAll("#results .product-row").length');
        await click('[data-action=more]'); assert.ok(await cdp.eval('document.querySelectorAll("#results .product-row").length')>count);
        await select('#sort','asc');
        await click('[data-action=view][data-view=grid]');
        assert.ok(await cdp.eval('document.querySelector("#results").classList.contains("catalog-grid")'));
        await go(base+'catalog.html?cat=cpu');
        await select('#socket','AM5');
        await select('#brand','AMD');
        await cdp.eval('document.querySelector("#search").value="Ryzen 5 7600";document.querySelector("#search").dispatchEvent(new Event("input",{bubbles:true}))'); await delay(350); await settled();
        assert.ok((await cdp.eval('document.querySelector("#results").innerText')).includes('7600'));
        await cdp.eval('document.querySelector("#global-search").value="RTX 4090";document.querySelector(".global-search").requestSubmit()');
        await until(()=>cdp.eval('location.search.includes("RTX") && Boolean(window.SobranoApp)'),'global search navigation');
        await settled();
        assert.ok((await cdp.eval('document.querySelector("#results").innerText')).includes('RTX 4090'));
        await go(base+'catalog.html?search=ZZZ_no_such_model'); assert.ok((await cdp.eval('document.querySelector("#results").innerText')).includes('Моделей не найдено'));
      });
      await check(mode+' configurator GPU first, power filter, share and removal',async()=>{
        await go(base+'builder.html?parts=,,,,,,,');
        const gpu=await cdp.eval('SobranoApp.products.find(p=>p.name.includes("RTX 4090")).i');
        await select('#slot-gpu',String(gpu));
        assert.equal(await cdp.eval('[...document.querySelector("#slot-psu").options].some(o=>o.textContent.includes("PK550D"))'),false);
        const priorDownloads=new Set(readdirSync(downloadDir));
        await click('[data-action=export]');
        const downloaded=await until(()=>readdirSync(downloadDir).find(name=>name.endsWith('.txt')&&!priorDownloads.has(name)),'TXT download');
        assert.ok(readFileSync(path.join(downloadDir,downloaded),'utf8').includes('RTX 4090'));
        await click('[data-action=share]'); assert.ok((await cdp.eval('document.querySelector("#share-link").value')).includes(String(gpu)));
        const sharedURL=await cdp.eval('document.querySelector("#share-link").value');
        if (new URL(base).hostname === '127.0.0.1') {
          assert.ok((await cdp.eval('document.querySelector("#details").innerText')).includes('только на этом компьютере'));
          assert.equal(new URL(sharedURL).origin,new URL(base).origin);
        }
        await click('[data-action=close-dialog]');
        await go(sharedURL); assert.equal(await cdp.eval('document.querySelector("#slot-gpu").value'),String(gpu));
        await click('[data-action=remove-part][data-category=gpu]');
        assert.equal(await cdp.eval('document.querySelector("#slot-gpu").value'),'');
        assert.equal(await cdp.eval('[...document.querySelector("#slot-psu").options].some(o=>o.textContent.includes("PK550D"))'),true);
      });
      await check(mode+' build loading and task/budget filters',async()=>{
        await go(base+'build.html?id=b0'); await click('[data-action=load-build]');
        await until(()=>cdp.eval('location.pathname.endsWith("builder.html") && Boolean(document.querySelector("#slot-cpu"))'),'load build');
        assert.notEqual(await cdp.eval('document.querySelector("#slot-cpu").value'),'');
        await go(base+'builds.html');
        await cdp.eval('document.querySelector("#budget").value="1";document.querySelector("#budget").dispatchEvent(new Event("input",{bubbles:true}))'); await delay(350);
        assert.ok((await cdp.eval('document.querySelector("#build-results").innerText')).includes('Сборок с такими параметрами нет'));
      });
      await check(mode+' zero, empty and invalid build budgets',async()=>{
        await go(base+'builds.html');
        async function setBudget(value) {
          await cdp.eval('(()=>{const el=document.querySelector("#budget");el.value='+JSON.stringify(value)+';el.dispatchEvent(new Event("input",{bubbles:true}));})()');
          await delay(350); await settled();
        }
        const initial=await cdp.eval('document.querySelectorAll("#build-results .build-card").length');
        assert.equal(initial,22);
        await setBudget('0');
        assert.equal(await cdp.eval('document.querySelectorAll("#build-results .build-card").length'),0);
        assert.ok((await cdp.eval('document.querySelector("#build-results").innerText')).includes('Сборок с такими параметрами нет'));
        await setBudget('');
        assert.equal(await cdp.eval('document.querySelectorAll("#build-results .build-card").length'),initial);
        for (const value of ['-1','0.5']) {
          const before=cdp.requestURLs.filter(url=>url.includes('/api/builds')).length;
          await setBudget(value);
          assert.equal(await cdp.eval('document.querySelector("#budget").validity.customError'),true);
          assert.ok((await cdp.eval('document.querySelector("#build-results").innerText')).includes('целых тенге'));
          assert.equal(cdp.requestURLs.filter(url=>url.includes('/api/builds')).length,before);
        }
        await setBudget('');
        assert.equal(await cdp.eval('document.querySelector("#budget").validity.valid'),true);
        assert.equal(await cdp.eval('document.querySelectorAll("#build-results .build-card").length'),initial);
      });
      await check(mode+(publicURL?' representative':' all')+' product and build detail pages',async()=>{
        const data=JSON.parse(readFileSync(path.join(root,'data/catalog.json'),'utf8'));
        const categories=new Set();
        const indices=data.products.map((row,i)=>i).filter(i=>{
          if(!publicURL) return true;
          const category=data.products[i][0];
          if(categories.has(category)) return false;
          categories.add(category); return true;
        });
        for(const i of indices) {
          await go(base+'product.html?id=p'+i);
          assert.ok((await cdp.eval('document.querySelector("#app").innerText')).includes(data.products[i][1]),'product p'+i);
        }
        for(let i=0;i<data.builds.length;i++) {
          await go(base+'build.html?id=b'+i);
          assert.ok(await cdp.eval('Boolean(document.querySelector(".composition"))'),'build b'+i);
        }
        for(const route of ['product.html?id=p99999','build.html?id=b99999','builder.html?parts=bad']) {
          await go(base+route); assert.ok((await cdp.eval('document.querySelector("#app").innerText')).length>60);
        }
      });
      await check(mode+' source of calculations and API failures',async()=>{
        await go(base+'builder.html?parts=,,,,,,,');
        if(mode!=='static') {
          await cdp.eval('SobranoCore.check=()=>{throw Error("client check forbidden")};SobranoCompatibility.assess=()=>{throw Error("client assess forbidden")};SobranoPricing.price=()=>{throw Error("client price forbidden")};SobranoPricing.budget=()=>{throw Error("client budget forbidden")}');
          await select('#slot-gpu','85');
          assert.equal(await cdp.eval('[...document.querySelector("#slot-psu").options].some(o=>o.textContent.includes("PK550D"))'),false);
          const before=await cdp.eval('localStorage.getItem("sobrano:diploma:1")');
          let failures=0;
          cdp.onEvent=m=>{
            if(m.method==='Fetch.requestPaused') {
              const bad=m.params.request.url.includes('/api/configuration'); if(bad) failures++;
              cdp.send(bad?'Fetch.fulfillRequest':'Fetch.continueRequest',bad?{requestId:m.params.requestId,responseCode:503,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({error:'Test API failure'})).toString('base64')}:{requestId:m.params.requestId}).catch(()=>{});
            }
          };
          await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*/api/*'}]});
          await select('#slot-gpu','');
          assert.equal(failures,1);
          assert.equal(await cdp.eval('document.querySelector("#slot-gpu").value'),'85');
          assert.equal(await cdp.eval('localStorage.getItem("sobrano:diploma:1")'),before);
          assert.ok((await cdp.eval('document.querySelector("#toast").innerText')).includes('Состав оставлен без изменений'));
          await cdp.send('Fetch.disable'); cdp.onEvent=null;
          for(const route of ['catalog','products','builds','configuration'])
            assert.ok(cdp.requestURLs.some(url=>url.includes('/api/'+route)),'missing API '+route);
        } else assert.equal(cdp.requestURLs.filter(url=>url.includes('/api/')).length,0);
      });
      await check(mode+' invalid category URL recovers to full catalog',async()=>{
        await go(base+'catalog.html?cat=obsolete&sort=bogus&compat=all');
        assert.ok((await cdp.eval('document.querySelector("#found").innerText')).includes('190'));
      });
      await check(mode+' invalid price interval explains correction',async()=>{
        await go(base+'catalog.html');
        await cdp.eval('document.querySelector("#min").value="90000";document.querySelector("#max").value="100";document.querySelector("#max").dispatchEvent(new Event("input",{bubbles:true}))');
        await delay(400);
        assert.equal(await cdp.eval('document.querySelector("#max").validity.customError'),true);
        assert.ok(!(await cdp.eval('document.querySelector("#found").innerText')).includes('недоступен'));
      });
      await check(mode+' clearing storage in another tab synchronizes selection',async()=>{
        await go(base+'builder.html?parts=,,,,,,,');
        await select('#slot-gpu','85');
        await cdp.eval('localStorage.clear();window.dispatchEvent(new StorageEvent("storage",{key:null,newValue:null}))');
        await settled();
        assert.equal(await cdp.eval('document.querySelector("#slot-gpu").value'),'');
      });
      await check(mode+' mobile navigation and layout',async()=>{
        await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
        for(const page of ['index.html','catalog.html','builder.html','product.html?id=p0','compare.html','favorites.html','builds.html','build.html?id=b0','about.html','account.html']) {
          await go(base+page);
          assert.ok(await cdp.eval('document.documentElement.scrollWidth<=window.innerWidth+1'),'overflow '+page);
          const firstTheme=await cdp.eval('document.documentElement.dataset.theme');
          await click('#theme-toggle');
          assert.notEqual(await cdp.eval('document.documentElement.dataset.theme'),firstTheme);
          assert.ok(await cdp.eval('document.documentElement.scrollWidth<=window.innerWidth+1'),'theme overflow '+page);
          await click('#theme-toggle');
        }
        await click('#menu-toggle'); assert.equal(await cdp.eval('document.querySelector("#menu-toggle").getAttribute("aria-expanded")'),'true');
        await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
      });
      if(mode==='server') await check('server SQL save, reopen, update, copy, other device and delete',async()=>{
        await go(base+'builder.html?parts=,,,,,,,');
        await select('#slot-cpu','0');
        async function submitName(name,copy=false) {
          await click('[data-action=server-save]');
          await cdp.eval('document.querySelector("#saved-name").value='+JSON.stringify(name)+';if(document.querySelector("#saved-as-copy"))document.querySelector("#saved-as-copy").checked='+JSON.stringify(copy)+';document.querySelector("#server-save-form").requestSubmit()');
          await until(()=>cdp.eval('Boolean(document.querySelector("#share-link")?.value.includes("saved="))'),'saved confirmation');
          return cdp.eval('document.querySelector("#share-link").value');
        }
        const first=await submitName('Учебная сборка');
        const id=new URL(first).searchParams.get('saved');
        await click('[data-action=close-dialog]');
        await go(first);
        assert.equal(await cdp.eval('document.querySelector("#slot-cpu").value'),'0');
        await select('#slot-gpu','85');
        await click('[data-action=share]');
        assert.ok(new URL(await cdp.eval('document.querySelector("#share-link").value')).searchParams.has('parts'));
        await click('[data-action=close-dialog]');
        const updated=await submitName('Учебная сборка — обновлена');
        assert.equal(new URL(updated).searchParams.get('saved'),id);
        const saved=await cdp.eval('fetch('+JSON.stringify(base+'api/saved-builds/'+id)+').then(r=>r.json())');
        assert.equal(saved.version,2);assert.equal(saved.parts.gpu,85);assert.equal(saved.canEdit,true);
        await click('[data-action=close-dialog]');
        const copied=await submitName('Учебная сборка — обновлена',true);
        const copyId=new URL(copied).searchParams.get('saved');
        assert.notEqual(copyId,id,'new copy must create another database row');
        await click('[data-action=close-dialog]');
        await click('[data-action=server-my-builds]');
        await until(()=>cdp.eval('document.querySelectorAll(".server-build-list li").length===2'),'two owned records');
        await click('[data-action=close-dialog]');

        // Другая изолированная сессия Chromium имитирует открытие ссылки с другого устройства.
        const author=cdp;
        const browser=await CDP.open((await(await fetch('http://127.0.0.1:'+port+'/json/version')).json()).webSocketDebuggerUrl);
        const context=await browser.send('Target.createBrowserContext');
        let visitor;
        try {
          const target=await browser.send('Target.createTarget',{url:'about:blank',browserContextId:context.browserContextId});
          const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
          visitor=await CDP.open(targets.find(t=>t.id===target.targetId).webSocketDebuggerUrl);
          await visitor.send('Runtime.enable');await visitor.send('Page.enable');await visitor.send('Network.enable');
          await visitor.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
          cdp=visitor;
          await go(first);
          assert.equal(await cdp.eval('document.querySelector("#slot-gpu").value'),'85');
          assert.ok(await cdp.eval('document.documentElement.scrollWidth<=innerWidth+1'));
          const guest=await cdp.eval('fetch('+JSON.stringify(base+'api/saved-builds/'+id)+').then(r=>r.json())');
          assert.equal(guest.canEdit,false);assert.equal(Object.hasOwn(guest,'ownerId'),false);
          const guestLink=await submitName('Копия с другого устройства');
          assert.notEqual(new URL(guestLink).searchParams.get('saved'),id);
        } finally {
          cdp=author;
          if(visitor)visitor.ws.close();
          await browser.send('Target.disposeBrowserContext',{browserContextId:context.browserContextId});browser.ws.close();
        }
        await click('[data-action=server-my-builds]');
        await until(()=>cdp.eval('document.querySelectorAll(".server-build-list li").length===2'),'original author owns only two records');
        await click('[data-action=server-delete][data-id="'+copyId+'"]');
        await click('[data-action=server-delete-confirm]');
        await until(()=>cdp.eval('document.querySelectorAll(".server-build-list li").length===1'),'record deleted from list');
        assert.equal(await cdp.eval('fetch('+JSON.stringify(base+'api/saved-builds/'+copyId)+').then(r=>r.status)'),404);
        await click('[data-action=close-dialog]');
        assert.equal(await cdp.eval('document.querySelector("#slot-gpu").value'),'85');
      });
      if(mode==='server') await check('server failed SQL save preserves selection and retry',async()=>{
        const before=await cdp.eval('localStorage.getItem("sobrano:diploma:1")');
        cdp.onEvent=m=>{
          if(m.method==='Fetch.requestPaused') {
            const failed=m.params.request.method==='POST'&&new URL(m.params.request.url).pathname==='/api/saved-builds';
            cdp.send(failed?'Fetch.fulfillRequest':'Fetch.continueRequest',failed?{requestId:m.params.requestId,responseCode:503,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({error:'Проверка отказа сохранения'})).toString('base64')}:{requestId:m.params.requestId}).catch(()=>{});
          }
        };
        await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*/api/*'}]});
        await click('[data-action=server-save]');
        await cdp.eval('document.querySelector("#server-save-form").requestSubmit()');
        await until(()=>cdp.eval('document.querySelector("#server-form-error")?.innerText.includes("Проверка отказа")'),'save failure feedback');
        assert.equal(await cdp.eval('localStorage.getItem("sobrano:diploma:1")'),before);
        assert.equal(await cdp.eval('document.querySelector("#slot-gpu").value'),'85');
        await cdp.send('Fetch.disable');cdp.onEvent=null;
        await cdp.eval('document.querySelector("#server-save-form").requestSubmit()');
        await until(()=>cdp.eval('Boolean(document.querySelector("#share-link"))'),'successful save after retry');
        await click('[data-action=close-dialog]');
      });
      if(mode==='server') await check('server real account registration, login, logout and cross-browser ownership',async()=>{
        const username='defense_'+Date.now();
        const password='Practice_2026_Browser!';
        const owned=await cdp.eval('fetch("api/saved-builds").then(r=>r.json()).then(v=>v.items)');
        assert.ok(owned.length>0,'guest has actual saved SQL records before registration');
        async function credentials(mode,name,pass) {
          await until(()=>cdp.eval('Boolean(document.querySelector("[data-action=account-mode]"))'),'account form available');
          await click('[data-action=account-mode][data-mode="'+mode+'"]');
          await cdp.eval('(()=>{document.querySelector("#account-username").value='+JSON.stringify(name)+';document.querySelector("#account-password").value='+JSON.stringify(pass)+';if(document.querySelector("#account-display-name"))document.querySelector("#account-display-name").value="Студент";document.querySelector('+JSON.stringify('#account-'+mode+'-form')+').requestSubmit();})()');
        }
        async function loggedIn(name) {
          await until(()=>cdp.eval('Boolean(document.querySelector(".account-profile") && SobranoBackend.auth.user?.username==='+JSON.stringify(name)+')'),'account profile '+name);
          await until(()=>cdp.eval('Boolean(document.querySelector("#account-builds"))'),'account saved builds');
        }
        await go(base+'account.html');
        await until(()=>cdp.eval('Boolean(document.querySelector("#account-login-form"))'),'login form before focus');
        await cdp.eval('(()=>{document.querySelector("#account-username").value="typed_login";document.querySelector("#account-password").value="NotYetSubmitted_2026!";window.focusRefreshDone=false;const original=SobranoBackend.auth.me.bind(SobranoBackend.auth);SobranoBackend.auth.me=async(...args)=>{try{return await original(...args);}finally{window.focusRefreshDone=true;}};window.dispatchEvent(new Event("focus"));})()');
        await until(()=>cdp.eval('window.focusRefreshDone'),'account session re-read on window focus');
        await settled();
        assert.equal(await cdp.eval('document.querySelector("#account-username").value'),'typed_login','focus preserves typed login');
        assert.equal(await cdp.eval('document.querySelector("#account-password").value'),'NotYetSubmitted_2026!','focus preserves password manager input');
        await credentials('register',username,password);
        await loggedIn(username);
        assert.deepEqual(await cdp.eval('fetch("api/saved-builds").then(r=>r.json()).then(v=>v.items.map(i=>i.id).sort())'),owned.map(i=>i.id).sort(),'register imports only current guest records');
        await go(base+'account.html'); await loggedIn(username);
        await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
        assert.ok(await cdp.eval('document.documentElement.scrollWidth<=innerWidth+1'),'account mobile profile fits');
        await click('[data-action=account-logout]');
        await until(()=>cdp.eval('Boolean(document.querySelector("#account-login-form"))'),'logout shows login');
        assert.equal(await cdp.eval('SobranoBackend.auth.user'),null);
        assert.ok(await cdp.eval('document.documentElement.scrollWidth<=innerWidth+1'),'account mobile form fits');
        await credentials('login',username,'Wrong_Password_2026!');
        await until(()=>cdp.eval('Boolean(document.querySelector("#account-form-error")?.innerText.trim())'),'wrong password feedback');
        assert.equal(await cdp.eval('SobranoBackend.auth.user'),null);
        await credentials('login',username,password); await loggedIn(username);
        const author=cdp;
        const browser=await CDP.open((await(await fetch('http://127.0.0.1:'+port+'/json/version')).json()).webSocketDebuggerUrl);
        const context=await browser.send('Target.createBrowserContext');
        let visitor;
        try {
          const target=await browser.send('Target.createTarget',{url:'about:blank',browserContextId:context.browserContextId});
          const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
          visitor=await CDP.open(targets.find(t=>t.id===target.targetId).webSocketDebuggerUrl);
          await visitor.send('Runtime.enable');await visitor.send('Page.enable');await visitor.send('Network.enable');
          await visitor.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
          cdp=visitor;
          await go(base+'account.html');
          await credentials('login',username,password); await loggedIn(username);
          assert.deepEqual(await cdp.eval('fetch("api/saved-builds").then(r=>r.json()).then(v=>v.items.map(i=>i.id).sort())'),owned.map(i=>i.id).sort(),'same account sees builds in independent browser context');
          await click('[data-action=account-logout]');
          await credentials('register',username+'_other',password); await loggedIn(username+'_other');
          assert.deepEqual(await cdp.eval('fetch("api/saved-builds").then(r=>r.json()).then(v=>v.items)'),[],'new account cannot inherit preceding signed-in account records');
          assert.equal(await cdp.eval('fetch('+JSON.stringify('api/saved-builds/'+owned[0].id)+').then(r=>r.json()).then(v=>v.canEdit)'),false);
        } finally {
          cdp=author;
          if(visitor)visitor.ws.close();
          await browser.send('Target.disposeBrowserContext',{browserContextId:context.browserContextId});browser.ws.close();
        }
        await go(base+'account.html');await loggedIn(username);
        await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
      });
    }
    if(process.env.SOBRANO_SCREENSHOTS==='1') {
      const {writeFileSync,mkdirSync}=require('node:fs');
      const screenshotDir=process.env.SOBRANO_SCREENSHOT_DIR || path.join(root,'outputs/screenshots');
      mkdirSync(screenshotDir,{recursive:true});
      const base=publicURL || 'http://127.0.0.1:18082/';
      for(const [page,file,width,height] of [
        ['index.html','home-desktop.png',1440,1000],
        ['catalog.html','catalog-mobile.png',390,844],
        ['product.html?id=p0','product-mobile.png',390,844]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<500});
        await go(base+page); await delay(1200);
        const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        writeFileSync(path.join(screenshotDir,file),Buffer.from(shot.data,'base64'));
        console.log('MEDIA '+file+' '+JSON.stringify(await cdp.eval('({loaded:[...document.images].filter(i=>i.naturalWidth>0).length,pending:[...document.images].filter(i=>!i.complete).length,placeholders:document.querySelectorAll(".media-placeholder").length})')));
      }
    }
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  } finally {
    if(cdp) cdp.ws.close();
    for(const child of children.reverse()) child.kill();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
