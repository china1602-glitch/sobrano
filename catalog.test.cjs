const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const context = vm.createContext({ window: {} });
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "../js/data.js"), "utf8"),
  context,
);
const { products } = require("../js/core.js").create(
  context.window.SOBRANO_DATA,
);
const catalog = require("../js/catalog-ui.js");
test("RAM фильтруется по реальным DDR, объёму, комплекту и скорости", () => {
  const rows = catalog.filter(
    products,
    new URLSearchParams({
      type: "DDR5",
      capacity: "32",
      modules: "2",
      speed: "6000",
    }),
    "ram",
  );
  assert(rows.length > 0);
  assert(
    rows.every(
      (p) =>
        p.v[0] === "DDR5" &&
        p.v[1] === "32" &&
        p.v[2] === "2" &&
        p.v[3] === "6000",
    ),
  );
});
test("Видеокарты фильтруются по семейству и видеопамяти", () => {
  const rows = catalog.filter(
    products,
    new URLSearchParams({ family: "radeon", vram: "16" }),
    "gpu",
  );
  assert(rows.length > 0);
  assert(rows.every((p) => p.name.includes("Radeon") && p.v[3] === "16"));
});
test("Поиск учитывает все слова и оставляет точный вариант", () => {
  const rows = catalog.filter(
    products,
    new URLSearchParams({ search: "Ryzen 7600X" }),
    "cpu",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "AMD Ryzen 5 7600X");
});
test("Фильтры и сортировка используют ту же отображаемую цену", () => {
  const rows = catalog.filter(
    [
      { ...products[0], displayPrice: 999999 },
      { ...products[2], displayPrice: 100 },
    ],
    new URLSearchParams({ max: "500", sort: "asc" }),
    "cpu",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].i, 2);
});
test("Некорректная категория не обращается к прототипу объекта", () => {
  assert.equal(catalog.facets("__proto__", products).length, 0);
  assert.equal(
    catalog.filter(products, new URLSearchParams(), "constructor").length,
    190,
  );
});
test("HTML формы экранирует ввод, ссылки сохраняют подпапку", () => {
  const html = catalog.filterPanel({
    category: "cpu",
    params: new URLSearchParams({ search: '"><script>alert(1)</script>' }),
    products,
  });
  assert(!html.includes("<script>"));
  assert(html.includes("&lt;script&gt;"));
  assert.equal(catalog.itemURL(products[2]), "product.html?id=p2");
  assert.equal(catalog.categoryURL("ram"), "catalog.html?cat=ram");
});
