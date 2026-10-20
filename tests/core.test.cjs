const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const context = { window: {} };
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "../js/data.js"), "utf8"),
  context,
);
const data = JSON.parse(JSON.stringify(context.window.SOBRANO_DATA));
const { create } = require("../js/core.js");
const core = create(data);
const find = (name) => core.products.find((product) => product.name === name);

function fullHD() {
  return core.buildParts(
    data.builds.find((build) => build[0] === "Игры в Full HD"),
  );
}

test("Каталог и номера компонентов всех 22 сборок сохраняются", () => {
  assert.equal(core.products.length, 190);
  assert.equal(core.builds.length, 22);
  for (const product of core.products) {
    assert.equal(product.id, "p" + product.i);
    assert.equal(product.name, data.products[product.i][1]);
    assert.equal(product.price, data.products[product.i][2]);
  }
  for (const build of core.builds) {
    const parts = core.buildParts(build);
    const check = core.check(parts);
    assert.deepEqual(check.bad, [], build[0]);
    assert.deepEqual(check.missing, [], build[0]);
    assert.equal(
      core.total(parts),
      build[3].reduce(
        (sum, i) => sum + (i === null ? 0 : data.products[i][2]),
        0,
      ),
    );
  }
});

test("Полная сборка из известных моделей проходит только базовые проверки", () => {
  const result = core.check(fullHD());
  assert.equal(result.status, "ok");
  assert.equal(result.need, 550);
  assert.deepEqual(result.unknown, []);
});

test("Arc A750 с неизвестной мощностью и длиной не получает зелёный статус и 250 Вт", () => {
  const parts = {
    ...fullHD(),
    gpu: find("ASRock Intel Arc A750 Challenger D 8GB OC").i,
  };
  const result = core.check(parts);
  assert.deepEqual(result.bad, []);
  assert.deepEqual(result.missing, []);
  assert.equal(result.status, "unknown");
  assert.equal(result.need, null);
  assert(result.unknown.some((message) => message.includes("длина")));
  assert(result.unknown.some((message) => message.includes("потребление")));
  assert(result.unknown.some((message) => message.includes("рекомендованный")));
});

test("Неизвестная длина даёт предупреждение даже при известных ваттах", () => {
  const parts = { ...fullHD(), gpu: find("NVIDIA GeForce RTX 2060").i };
  const result = core.check(parts);
  assert.equal(result.status, "unknown");
  assert.equal(result.need, 500);
  assert(result.unknown.some((message) => message.includes("длина")));
});

test("Неизвестные предел корпуса и высота кулера не подменяются нулями", () => {
  const fixture = structuredClone(data);
  const parts = fullHD();
  fixture.products[parts.case][3][1] = "";
  fixture.products[parts.cooling][3][1] = "";
  const result = create(fixture).check(parts);
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.bad, []);
  assert(
    result.unknown.some((message) => message.includes("длина видеокарты")),
  );
  assert(result.unknown.some((message) => message.includes("высота кулера")));
});

test("Несовпадение сокета и памяти остаётся конфликтом при других неизвестных данных", () => {
  const parts = {
    ...fullHD(),
    cpu: find("AMD Ryzen 5 7600").i,
    gpu: find("ASRock Intel Arc A750 Challenger D 8GB OC").i,
  };
  const result = core.check(parts);
  assert.equal(result.status, "conflict");
  assert(result.bad.some((message) => message.includes("Сокеты")));
  assert(result.bad.some((message) => message.includes("процессором")));
  assert(result.unknown.length > 0);
});

test("Конфигурация без дискретной графики требует GPU, если CPU без iGPU", () => {
  const parts = fullHD();
  delete parts.gpu;
  const result = core.check(parts);
  assert.equal(result.status, "incomplete");
  assert(result.missing.includes("gpu"));
  assert.equal(result.need, null);
});

test("Размеры, память, мощность БП и крепления проверяются независимо", () => {
  const fixture = structuredClone(data);
  const parts = fullHD();
  fixture.products[parts.gpu][3][2] = "999";
  fixture.products[parts.psu][3][0] = "100";
  fixture.products[parts.ram][3][1] = "999";
  fixture.products[parts.ram][3][2] = "99";
  fixture.products[parts.cooling][3][0] = "LGA1700";
  const result = create(fixture).check(parts);
  assert.equal(result.status, "conflict");
  for (const text of [
    "Видеокарта длиннее",
    "Мощность блока",
    "Объём памяти",
    "слотов памяти",
    "крепление",
  ]) {
    assert(
      result.bad.some((message) => message.includes(text)),
      text,
    );
  }
});

test("Передача состава сохраняет пустые GPU/кулер и индекс ноль", () => {
  const parts = core.buildParts(data.builds[2]);
  const encoded = core.partsString(parts);
  assert.equal(encoded.split(",").length, 8);
  assert.deepEqual(core.parseParts(encoded), parts);
  assert.deepEqual(core.parseParts(core.partsString({ cpu: 0 })), { cpu: 0 });
});

test("Ошибочные URL-поля и категории очищаются без подстановки CPU 0", () => {
  assert.deepEqual(core.parseParts(""), {});
  assert.deepEqual(core.parseParts(",,,,,,,"), {});
  assert.deepEqual(core.parseParts("2e0,,0xE,+26,30.0,-1,999999,"), {});
  assert.deepEqual(core.parseParts("2,,,,,,,,extra"), {});
  assert.deepEqual(core.parseParts(null), {});
  assert.deepEqual(core.parseParts("0,,13,24,29,40,48,46"), {
    cpu: 0,
    motherboard: 13,
    ram: 24,
    storage: 29,
    psu: 40,
    case: 48,
    cooling: 46,
  });
  assert.deepEqual(
    core.validateParts({
      cpu: 13,
      gpu: -1,
      motherboard: "13",
      ram: 24,
      extra: 1,
    }),
    { ram: 24 },
  );
});

test("Пользовательские подписи содержат единицы и приоритетные характеристики", () => {
  const gpu = find("MSI GeForce RTX 4060 VENTUS 2X BLACK 8G OC");
  const cpu = find("Intel Core i5-12400");
  const ram = find("Kingston FURY Beast 32 ГБ (2 × 16) DDR5-6000");
  assert.equal(core.spec(gpu, 3), "8 ГБ");
  assert.equal(core.spec(gpu, 0), "120 Вт");
  assert.equal(core.spec(gpu, 2), "199 мм");
  assert.equal(core.spec(cpu, 2), "117 Вт (максимум)");
  assert.equal(core.spec(find("AMD Ryzen 5 7600"), 2), "65 Вт (TDP)");
  assert(core.brief(gpu).some((text) => text === "Видеопамять: 8 ГБ"));
  assert(core.brief(cpu).some((text) => text === "Ядра / потоки: 6 / 12"));
  assert(core.brief(ram).some((text) => text.includes("MT/s")));
  assert.equal(
    core.spec(find("ASRock Intel Arc A750 Challenger D 8GB OC"), 0),
    "Не указано",
  );
});
