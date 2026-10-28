'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const raw = JSON.parse(fs.readFileSync(path.join(root, 'data/catalog.json'), 'utf8'));
const offers = JSON.parse(fs.readFileSync(path.join(root, 'data/offers.json'), 'utf8'));
const now = Date.parse('2026-10-28T12:00:00Z');
const moduleReady = import('../online/domain.mjs');
async function domain(data = raw, prices = offers, moment = now) {
  const { createDomain } = await moduleReady;
  return createDomain(data, prices, moment);
}

test('Online API preserves raw catalog IDs, all prices and all build contracts', async () => {
  const api = await domain();
  const result = api.catalogPayload();
  assert.deepEqual(result.products, raw.products);
  assert.deepEqual(result.builds, raw.builds);
  assert.equal(Object.keys(result.prices).length, 190);
  assert.equal(Object.keys(result.buildResults).length, 22);
  result.products[0][1] = 'mutated consumer';
  result.buildResults.b0.parts.cpu = 999;
  assert.deepEqual(api.catalogPayload().products, raw.products);
  assert.notEqual(api.catalogPayload().buildResults.b0.parts.cpu, 999);
});

test('API rejects malformed parts rather than silently sanitizing them, and keeps p0', async () => {
  const api = await domain();
  for (const bad of [null, [], '0', { cpu: false }, { cpu: '0' }, { cpu: -1 }, { cpu: 0.1 },
      { cpu: 99999 }, { gpu: 0 }, { surprise: 0 }, JSON.parse('{"__proto__":0}')]) {
    assert.throws(() => api.configurationPayload(bad), error => error.status === 400);
  }
  const first = api.configurationPayload({cpu: 0});
  assert.deepEqual(first.parts, {cpu: 0});
  assert.equal(first.budget.value, raw.products[0][2]);
  assert.equal(Object.keys(first.assessments).length, 190);
  assert.deepEqual(api.configurationPayload({}).parts, {});
});

test('GPU-first and PSU-first filtering retain symmetric compatibility and unknown data', async () => {
  const api = await domain();
  const gpu = raw.products.findIndex(row => row[1] === 'NVIDIA GeForce RTX 4090');
  const weak = raw.products.findIndex(row => row[1] === 'DeepCool PK550D');
  assert.ok(gpu >= 0 && weak >= 0);
  assert.equal(api.configurationPayload({gpu}).assessments['p' + weak].allowed, false);
  assert.equal(api.configurationPayload({psu: weak}).assessments['p' + gpu].allowed, false);
  const gpuFirst = api.productsPayload(new URLSearchParams({cat:'psu', parts:[null,gpu,null,null,null,null,null,null].join(',')}));
  assert.ok(!gpuFirst.ids.includes('p' + weak));
  const all = api.productsPayload(new URLSearchParams({cat:'psu', parts:[null,gpu,null,null,null,null,null,null].join(','), compat:'all'}));
  assert.ok(all.ids.includes('p' + weak));
  const arc = raw.products.findIndex(row => row[1].includes('Arc A750'));
  const result = api.configurationPayload({gpu: arc});
  assert.equal(result.assessments['p' + arc].allowed, true);
  assert.ok(result.check.unknown.length > 0);
});

test('Search, facets and sorting use server snapshot prices rather than educational estimates', async () => {
  const api = await domain();
  const exact = api.productsPayload(new URLSearchParams({cat:'storage',min:'78990',max:'78990',compat:'all'}));
  assert.ok(exact.ids.includes('p30'));
  const cpu = api.productsPayload(new URLSearchParams({cat:'cpu',search:'Ryzen 5 7600',socket:'AM5',brand:'AMD',sort:'asc',compat:'all'}));
  assert.ok(cpu.ids.length > 0);
  assert.ok(cpu.ids.every(id => raw.products[Number(id.slice(1))][1].includes('7600')));
  const ram = api.productsPayload(new URLSearchParams({cat:'ram',type:'DDR5',capacity:'32',modules:'2',compat:'all'}));
  assert.ok(ram.ids.length > 0);
  assert.ok(ram.ids.every(id => {
    const values = raw.products[Number(id.slice(1))][3];
    return values[0] === 'DDR5' && values[1] === '32' && values[2] === '2';
  }));
});

test('Query validation rejects duplicates, malformed bounds and invalid IDs/CSV', async () => {
  const api = await domain();
  const badQueries = ['cat=cpu&cat=gpu','cat=__proto__','sort=wrong','compat=wrong','min=NaN',
    'max=Infinity','min=-1','min=0x10','min=%20','min=10&max=1','ids=p01','ids=p99999','ids=0',
    'parts=','parts=0','parts=0%2C%2C%2C%2C%2C%2C%2C0','parts=00%2C%2C%2C%2C%2C%2C%2C',
    'parts=1.5%2C%2C%2C%2C%2C%2C%2C','parts=%2C0%2C%2C%2C%2C%2C%2C'];
  for (const query of badQueries) {
    assert.throws(() => api.productsPayload(new URLSearchParams(query)), error => error.status === 400, query);
  }
  assert.deepEqual(api.productsPayload(new URLSearchParams('ids=')).ids, []);
  assert.deepEqual(api.productsPayload(new URLSearchParams('ids=p0,p0&compat=all')).ids, ['p0']);
  assert.deepEqual(api.configurationPayload({cpu:0}).parts, {cpu:0});
});

test('Build budget distinguishes empty and zero and rejects invalid values', async () => {
  const api = await domain();
  assert.equal(api.buildsPayload(new URLSearchParams()).ids.length, 22);
  assert.equal(api.buildsPayload(new URLSearchParams('budget=')).ids.length, 22);
  assert.deepEqual(api.buildsPayload(new URLSearchParams('budget=0')).ids, []);
  for (const value of ['-1','0.5','NaN','Infinity','9007199254740992','0x10',' '])
    assert.throws(() => api.buildsPayload(new URLSearchParams({budget:value})), error => error.status === 400, value);
  assert.throws(() => api.buildsPayload(new URLSearchParams('task=a&task=b')), error => error.status === 400);
  const result = api.buildsPayload(new URLSearchParams({task:raw.builds[0][1],budget:'227000'}));
  assert.ok(result.ids.every(id => raw.builds[Number(id.slice(1))][1] === raw.builds[0][1]));
});

test('Concurrent catalog factories use separate offers and never change global data', async () => {
  const beforeData = globalThis.SOBRANO_DATA;
  const beforeOffers = globalThis.SOBRANO_OFFERS;
  const cheap = {...offers[0],productId:'p0',price:1,checkedAt:'2026-10-28T12:00:00Z'};
  const expensive = {...cheap,price:999};
  const first = await domain(raw,[cheap]);
  const second = await domain(raw,[expensive]);
  cheap.price = 500;
  assert.equal(first.catalogPayload().prices.p0.value,1);
  assert.equal(second.catalogPayload().prices.p0.value,999);
  assert.equal(first.configurationPayload({cpu:0}).budget.value,1);
  assert.equal(globalThis.SOBRANO_DATA,beforeData);
  assert.equal(globalThis.SOBRANO_OFFERS,beforeOffers);
  const stale = await domain(raw,[expensive],now+31*86400000);
  assert.equal(stale.catalogPayload().prices.p0.kind,'estimate');
});

test('All 22 existing builds and prices match the independent Python backend at a fixed time', async (t) => {
  const api = await domain();
  const script = `import json\nfrom datetime import datetime\nfrom backend import catalog,pricing\nfrom server import SobranoHandler\nraw=catalog.load_catalog()\nproducts=catalog.normalize_products(raw['products'])\nprices=pricing.prices_for(products,raw['offers'],datetime.fromisoformat('2026-10-28T12:00:00+00:00'))\nprint(json.dumps({'prices':prices,'buildResults':SobranoHandler.build_results(raw,products,prices)},ensure_ascii=False))`;
  const commands = process.env.PYTHON ? [[process.env.PYTHON,[]]] :
    process.platform === 'win32' ? [['py',['-3']],['python',[]]] : [['python',[]],['python3',[]]];
  const command = commands.find(([executable,args]) =>
    spawnSync(executable,[...args,'-c','import sys;sys.exit(0 if sys.version_info.major == 3 else 1)'],{cwd:root,encoding:'utf8'}).status === 0);
  if (!command) { t.skip('Optional Python reference backend is unavailable'); return; }
  const python = spawnSync(command[0],[...command[1],'-B','-c',script],{cwd:root,encoding:'utf8'});
  assert.equal(python.status,0,python.stderr || 'Python command failed');
  const expected = JSON.parse(python.stdout);
  const actual = api.catalogPayload();
  assert.deepEqual(actual.prices,expected.prices);
  for (let i=0;i<raw.builds.length;i++) {
    assert.deepEqual(actual.buildResults['b'+i],expected.buildResults['b'+i],raw.builds[i][0]);
    assert.deepEqual(api.configurationPayload(actual.buildResults['b'+i].parts).check,expected.buildResults['b'+i].check);
  }
});
