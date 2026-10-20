const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/catalog.json"), "utf8"));
const offers = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/offers.json"), "utf8"));
const source = fs.readFileSync(path.join(__dirname, "../js/bootstrap.js"), "utf8");

async function boot({ runtime = { backend: "static" }, apiData, apiStatus = 200, failedScript, appReady, onAppLoad } = {}) {
  const requests = [];
  const scripts = [];
  const elements = [];
  const window = { location: { reload() {} } };
  const container = {
    setAttribute() {},
    replaceChildren(...children) { elements.push(...children); },
  };
  const exports = {
    "core.js": "SobranoCore",
    "product-images.js": "SOBRANO_PRODUCT_IMAGES",
    "pricing.js": "SobranoPricing",
    "catalog-ui.js": "SobranoCatalog",
    "compatibility.js": "SobranoCompatibility",
    "media.js": "SobranoMedia",
    "backend-client.js": "SobranoBackend",
  };
  const document = {
    currentScript: { src: "https://example.test/sobrano/js/bootstrap.js" },
    body: container,
    getElementById: () => container,
    createElement: (tag) => ({ tag, addEventListener() {} }),
    head: {
      append(script) {
        const filename = new URL(script.src).pathname.split("/").pop();
        scripts.push(filename);
        assert.match(script.src, /^https:\/\/example\.test\/sobrano\/js\//);
        Promise.resolve().then(() => {
          if (filename === failedScript) return script.onerror();
          if (filename === "compatibility.js") assert(window.SobranoCore);
          if (filename === "media.js") assert(window.SOBRANO_PRODUCT_IMAGES);
          if (filename === "backend-client.js") {
            for (const name of ["SobranoCore", "SobranoPricing", "SobranoMedia", "SobranoCatalog", "SobranoCompatibility"]) assert(window[name]);
          }
          if (filename === "app.js") {
            assert(window.SobranoBackend);
            if (appReady !== undefined) window.SOBRANO_APP_READY = appReady;
            if (onAppLoad) onAppLoad(window);
          }
          if (exports[filename]) window[exports[filename]] = {};
          script.onload();
        });
      },
    },
  };
  const context = vm.createContext({
    window, document, URL, AbortController, setTimeout, clearTimeout,
    console: { error() {} },
    fetch: async (url) => {
      const pathname = new URL(url).pathname;
      requests.push(pathname);
      const bodies = {
        "/sobrano/runtime.json": runtime,
        "/sobrano/data/catalog.json": catalog,
        "/sobrano/data/offers.json": offers,
        "/sobrano/api/catalog": apiData,
      };
      const status = pathname === "/sobrano/api/catalog" ? apiStatus : 200;
      return { ok: status === 200, status, json: async () => bodies[pathname] };
    },
  });
  vm.runInContext(source, context);
  const success = await window.SOBRANO_READY;
  return { success, window, requests, scripts, elements };
}

test("GitHub Pages загружает канонические JSON относительно подпапки проекта", async () => {
  const result = await boot();
  assert.equal(result.success, true);
  assert.equal(result.window.SOBRANO_RUNTIME.backend, "static");
  assert.equal(result.window.SOBRANO_RUNTIME.baseURL, "https://example.test/sobrano/");
  assert.equal(result.window.SOBRANO_SERVER_DATA, null);
  assert.equal(result.window.SOBRANO_DATA.products.length, 190);
  assert.equal(result.window.SOBRANO_DATA.builds.length, 22);
  assert.deepEqual(result.window.SOBRANO_OFFERS, offers);
  assert.deepEqual(result.requests, ["/sobrano/runtime.json", "/sobrano/data/catalog.json", "/sobrano/data/offers.json"]);
  assert.equal(result.scripts.at(-2), "backend-client.js");
  assert.equal(result.scripts.at(-1), "app.js");
});

test("Python-режим использует ответ API с серверными результатами", async () => {
  const apiData = { ...catalog, offers, prices: { p0: { value: 55000 } }, buildResults: { b0: {} } };
  const result = await boot({ runtime: { backend: "python", apiBase: "api/" }, apiData });
  assert.equal(result.success, true);
  assert.equal(result.window.SOBRANO_SERVER_DATA, apiData);
  assert.equal(result.window.SOBRANO_DATA.products, apiData.products);
  assert.equal(result.window.SOBRANO_OFFERS, offers);
  assert.deepEqual(result.requests, ["/sobrano/runtime.json", "/sobrano/api/catalog"]);
});

test("отказ Python API показывает ошибку и не переключается на статические расчёты", async () => {
  const result = await boot({ runtime: { backend: "python", apiBase: "api/" }, apiStatus: 503 });
  assert.equal(result.success, false);
  assert.match(result.window.SOBRANO_BOOT_ERROR, /Python API: HTTP 503/);
  assert(result.elements.some((element) => element.textContent.includes("Python-сервер")));
  assert(result.elements.some((element) => element.tag === "button"));
  assert.deepEqual(result.requests, ["/sobrano/runtime.json", "/sobrano/api/catalog"]);
  assert.deepEqual(result.scripts, []);
});

test("неполный ответ Python и чужой адрес API отклоняются", async () => {
  const incomplete = await boot({ runtime: { backend: "python" }, apiData: { ...catalog, offers } });
  assert.equal(incomplete.success, false);
  assert.match(incomplete.window.SOBRANO_BOOT_ERROR, /неполные данные/);
  const external = await boot({ runtime: { backend: "python", apiBase: "https://other.test/api/" } });
  assert.equal(external.success, false);
  assert.match(external.window.SOBRANO_BOOT_ERROR, /на том же сервере/);
  assert.deepEqual(external.requests, ["/sobrano/runtime.json"]);
});

test("ошибка модуля останавливает запуск приложения", async () => {
  const result = await boot({ failedScript: "pricing.js" });
  assert.equal(result.success, false);
  assert.match(result.window.SOBRANO_BOOT_ERROR, /pricing\.js/);
  assert(!result.scripts.includes("app.js"));
});

test("готовность сайта ожидает серверную инициализацию и отрисовку приложения", async () => {
  let finishApp;
  let appLoaded;
  const appReady = new Promise((resolve) => { finishApp = resolve; });
  const loaded = new Promise((resolve) => { appLoaded = resolve; });
  let settled = false;
  const running = boot({ appReady, onAppLoad: appLoaded });
  running.then(() => { settled = true; });
  await loaded;
  await new Promise(setImmediate);
  assert.equal(settled, false);
  finishApp(true);
  const result = await running;
  assert.equal(result.success, true);
});

test("неудачная инициализация приложения оставляет явную ошибку загрузки", async () => {
  const result = await boot({ appReady: Promise.resolve(false) });
  assert.equal(result.success, false);
  assert.match(result.window.SOBRANO_BOOT_ERROR, /Не удалось завершить загрузку приложения/);
  assert(result.elements.some((element) => element.textContent === "Не удалось загрузить сайт"));
});

test("все девять страниц запускаются через единственный bootstrap", () => {
  const root = path.resolve(__dirname, "..");
  const pages = fs.readdirSync(root).filter((name) => name.endsWith(".html"));
  assert.equal(pages.length, 9);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), "utf8");
    const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(scripts, ["js/bootstrap.js"], page);
  }
});
