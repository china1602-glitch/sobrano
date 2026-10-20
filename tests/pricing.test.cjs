const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
function load(offers) {
  const context = vm.createContext({
    window: {
      SOBRANO_DATA: JSON.parse(
        fs.readFileSync(path.join(root, "data/catalog.json"), "utf8"),
      ),
      SOBRANO_OFFERS: JSON.parse(
        fs.readFileSync(path.join(root, "data/offers.json"), "utf8"),
      ),
    },
    Date,
    URL,
    URLSearchParams,
  });
  if (offers) context.window.SOBRANO_OFFERS = offers;
  vm.runInContext(
    fs.readFileSync(path.join(root, "js/pricing.js"), "utf8"),
    context,
  );
  return {
    pricing: context.window.SobranoPricing,
    products: require("../js/core.js").create(context.window.SOBRANO_DATA)
      .products,
  };
}
const captureTime = Date.parse("2026-10-20T12:42:30+05:00");
test("NV3 1 ТБ имеет два источника, бюджет использует меньшую зафиксированную цену", () => {
  const { pricing, products } = load();
  assert.equal(pricing.offersFor(products[30]).length, 2);
  const result = pricing.price(products[30], captureTime);
  assert.equal(result.value, 78990);
  assert.equal(result.kind, "snapshot");
  assert.equal(result.offer.store, "Sulpak");
});
test("Цена без источника остаётся расчётной", () => {
  const { pricing, products } = load();
  assert.equal(pricing.price(products[0], captureTime).kind, "estimate");
  assert.equal(
    pricing.price(products[0], captureTime).value,
    products[0].price,
  );
});
test("Снимки старше 30 дней не участвуют в бюджете, история источников остаётся", () => {
  const { pricing, products } = load();
  assert.equal(
    pricing.price(products[30], captureTime + 31 * 86400000).kind,
    "estimate",
  );
  assert.equal(
    pricing.price(products[30], captureTime + 31 * 86400000).value,
    products[30].price,
  );
  assert.equal(pricing.offersFor(products[30]).length, 2);
});
test("Снимок из будущего не подставляется в бюджет", () => {
  const { pricing, products } = load();
  assert.equal(
    pricing.price(products[30], captureTime - 86400000).kind,
    "estimate",
  );
});
test("Известное отсутствие товара исключает цену из бюджета", () => {
  const { pricing, products } = load([
    {
      productId: "p30",
      store: "Example",
      price: 1,
      url: "https://example.org/product",
      currency: "KZT",
      checkedAt: "2026-10-20T12:42:30+05:00",
      availability: "out-of-stock",
    },
  ]);
  assert.equal(pricing.price(products[30], captureTime).kind, "estimate");
});
test("Смешанный бюджет считает каждую цену один раз и отмечает расчётные значения", () => {
  const { pricing, products } = load();
  const cost = pricing.budget(
    { cpu: 0, storage: 30, psu: 49 },
    products,
    captureTime,
  );
  assert.equal(cost.value, 55000 + 78990 + 23990);
  assert.equal(cost.snapshots, 2);
  assert.equal(cost.estimates, 1);
});
test("Неверные валюты, нули и небезопасные адреса источников исключены", () => {
  const base = {
    productId: "p30",
    store: "Example",
    price: 1,
    url: "https://example.org/product",
    currency: "KZT",
    checkedAt: "2026-10-20T12:42:30+05:00",
  };
  const { pricing } = load([
    { ...base, currency: "USD" },
    { ...base, price: 0 },
    { ...base, url: "javascript:alert(1)" },
  ]);
  assert.equal(pricing.offers.length, 0);
});
