'use strict';
// Проверка настоящего Chrome через DevTools Protocol, без npm-зависимостей.
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const publicURL = process.env.SOBRANO_PUBLIC_URL;
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
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
    if (!publicURL) for (const [port,args] of [[18080,['-B','server.py','--port','18080']], [18081,['-B','-m','http.server','18081','--bind','127.0.0.1','--directory',path.dirname(root)]]]) {
      const p = spawn('python', args, {cwd:root, windowsHide:true, stdio:'ignore'});
      children.push(p);
      await until(async () => (await fetch('http://127.0.0.1:'+port+'/')).ok, 'server '+port);
    }
    const profile = mkdtempSync(path.join(tmpdir(), 'sobrano-browser-'));
    const chrome = spawn(chromePath, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'], {windowsHide:true,stdio:'ignore'});
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
    const modes = publicURL
      ? [['static', new URL(publicURL).href]]
      : [['static','http://127.0.0.1:18081/'+path.basename(root)+'/'], ['python','http://127.0.0.1:18080/']];
    for (const [mode,base] of modes) {
      const downloadDir=mkdtempSync(path.join(tmpdir(),'sobrano-txt-'+mode+'-'));
      await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDir});
      cdp.requestURLs = [];
      await go(base); await cdp.eval('localStorage.clear()');
      for (const page of ['index.html','catalog.html','builds.html','builder.html','compare.html','favorites.html','about.html','product.html?id=p0','build.html?id=b0']) {
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
        if(mode==='python') {
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
        for(const page of ['index.html','catalog.html','builder.html','product.html?id=p0','compare.html','favorites.html','builds.html','build.html?id=b0','about.html']) {
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
    }
    if(process.env.SOBRANO_SCREENSHOTS==='1') {
      const {writeFileSync}=require('node:fs');
      const base='http://127.0.0.1:18080/';
      for(const [page,file,width,height] of [
        ['index.html','home-desktop.png',1440,1000],
        ['catalog.html','catalog-mobile.png',390,844],
        ['product.html?id=p0','product-mobile.png',390,844]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<500});
        await go(base+page); await delay(1200);
        const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        writeFileSync(path.join(root,'docs/screenshots',file),Buffer.from(shot.data,'base64'));
        console.log('MEDIA '+file+' '+JSON.stringify(await cdp.eval('({loaded:[...document.images].filter(i=>i.naturalWidth>0).length,pending:[...document.images].filter(i=>!i.complete).length,placeholders:document.querySelectorAll(".media-placeholder").length})')));
      }
    }
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  } finally {
    if(cdp) cdp.ws.close();
    for(const child of children.reverse()) child.kill();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
