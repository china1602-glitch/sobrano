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
const { create: createCore } = require("../js/core.js");
const { create: createCompatibility } = require("../js/compatibility.js");
const core = createCore(data);
const compatibility = createCompatibility(core);
const find = (name) => {
  const product = core.products.find((p) => p.name === name);
  assert(product, name);
  return product;
};
const gpu = find("NVIDIA GeForce RTX 4090");
const psu550 = core.products.find(
  (p) => p.c === "psu" && Number(p.v[0]) === 550,
);
const psu1000 = core.products.find(
  (p) => p.c === "psu" && Number(p.v[0]) === 1000,
);
const am4 = find("AMD Ryzen 5 5600");
const am5 = find("AMD Ryzen 5 7600");
const ddr4 = core.products.find((p) => p.c === "ram" && p.v[0] === "DDR4");
const ddr5 = core.products.find((p) => p.c === "ram" && p.v[0] === "DDR5");
const boardAM4 = find("MSI B550M PRO-VDH WIFI");
const boardAM5 = find("MSI PRO B650M-P");
const box = find("DeepCool MATREXX 40");
const cooler = find("DeepCool AG400");

function fixture(change) {
  const copy = structuredClone(data);
  change(copy);
  const nextCore = createCore(copy);
  return { core: nextCore, compatibility: createCompatibility(nextCore) };
}

test("GPU выбрана первой: заведомо слабые БП исключаются без выбранного CPU", () => {
  assert.equal(compatibility.assess(psu550, { gpu: gpu.i }).allowed, false);
  const result = compatibility.assess(psu1000, { gpu: gpu.i });
  assert.equal(result.allowed, true);
  assert.equal(result.status, "compatible");
  const filtered = compatibility.filter(
    core.products.filter((p) => p.c === "psu"),
    { gpu: gpu.i },
  );
  assert(filtered.length > 0);
  assert(filtered.every((p) => Number(p.v[0]) >= Number(gpu.v[1])));
});

test("БП выбран первым: подбор видеокарт симметричен порядку выбора", () => {
  assert.equal(compatibility.assess(gpu, { psu: psu550.i }).allowed, false);
  assert.equal(compatibility.assess(gpu, { psu: psu1000.i }).allowed, true);
  for (const card of core.products.filter((p) => p.c === "gpu")) {
    for (const power of core.products.filter((p) => p.c === "psu")) {
      assert.equal(
        compatibility.assess(card, { psu: power.i }).allowed,
        compatibility.assess(power, { gpu: card.i }).allowed,
        card.name + " / " + power.name,
      );
    }
  }
});

test("Рекомендация БП остаётся нижней границей при неизвестном потреблении GPU", () => {
  const sample = fixture((copy) => {
    copy.products[gpu.i][3][0] = "";
  });
  const failed = sample.compatibility.assess(sample.core.products[psu550.i], {
    gpu: gpu.i,
  });
  assert.equal(failed.allowed, false);
  assert(failed.unknown.some((text) => text.includes("потребление")));
  const allowed = sample.compatibility.assess(sample.core.products[psu1000.i], {
    gpu: gpu.i,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.status, "unknown");
});

test("Известная нагрузка CPU даёт нижнюю границу мощности без видеокарты", () => {
  const cpu = find("AMD Ryzen 9 9950X");
  const sample = fixture((copy) => {
    copy.products[psu550.i][3][0] = "300";
  });
  const tooWeak = sample.core.products[psu550.i];
  assert.equal(
    sample.compatibility.assess(tooWeak, { cpu: cpu.i }).allowed,
    false,
  );
  assert.equal(
    sample.compatibility.assess(sample.core.products[cpu.i], { psu: tooWeak.i })
      .allowed,
    false,
  );
});

test("Известная сумма CPU и GPU учитывается при замене любого из них", () => {
  const cpu = find("AMD Ryzen 9 9950X");
  const card = find("MSI GeForce RTX 4060 VENTUS 2X BLACK 8G OC");
  // 170×1.5 + 120 + 75, с запасом 25% и округлением до 50 Вт: 600 Вт.
  assert.equal(
    compatibility.assess(psu550, { cpu: cpu.i, gpu: card.i }).allowed,
    false,
  );
  assert.equal(
    compatibility.assess(cpu, { psu: psu550.i, gpu: card.i }).allowed,
    false,
  );
  assert.equal(
    compatibility.assess(card, { cpu: cpu.i, psu: psu550.i }).allowed,
    false,
  );
});

test("Корпус и длина GPU проверяются в обе стороны, старый компонент заменяется", () => {
  const card = find("Sapphire PULSE Radeon RX 7800 XT");
  const sample = fixture((copy) => {
    copy.products[card.i][3][2] = "350";
  });
  assert.equal(
    sample.compatibility.assess(sample.core.products[card.i], { case: box.i })
      .allowed,
    false,
  );
  assert.equal(
    sample.compatibility.assess(sample.core.products[box.i], { gpu: card.i })
      .allowed,
    false,
  );
  const larger = sample.core.products.find(
    (p) => p.c === "case" && Number(p.v[1]) >= 350,
  );
  assert.equal(
    sample.compatibility.assess(larger, { case: box.i, gpu: card.i }).allowed,
    true,
  );
});

test("CPU и RAM проверяются ещё до выбора материнской платы", () => {
  assert.equal(compatibility.assess(ddr4, { cpu: am5.i }).allowed, false);
  assert.equal(compatibility.assess(am5, { ram: ddr4.i }).allowed, false);
  assert.equal(compatibility.assess(ddr5, { cpu: am5.i }).allowed, true);
  assert.equal(compatibility.assess(ddr4, { cpu: am4.i }).allowed, true);
  const intel = find("Intel Core i5-12400");
  assert.equal(compatibility.assess(ddr4, { cpu: intel.i }).allowed, true);
  assert.equal(compatibility.assess(ddr5, { cpu: intel.i }).allowed, true);
});

test("Замена CPU или платы исправляет старый конфликт и не сравнивается со старым CPU", () => {
  const conflicted = { cpu: am5.i, motherboard: boardAM4.i };
  assert.equal(compatibility.assess(am4, conflicted).allowed, true);
  assert.equal(compatibility.assess(boardAM5, conflicted).allowed, true);
  assert.equal(
    compatibility.assess(am5, { cpu: am4.i, motherboard: boardAM4.i }).allowed,
    false,
  );
});

test("RAM и плата проверяют тип, ёмкость и число модулей независимо от порядка", () => {
  const sample = fixture((copy) => {
    copy.products[boardAM4.i][3][3] = "1";
    copy.products[boardAM4.i][3][4] = "8";
    copy.products[ddr4.i][3][1] = "32";
    copy.products[ddr4.i][3][2] = "2";
  });
  const result = sample.compatibility.assess(sample.core.products[ddr4.i], {
    motherboard: boardAM4.i,
  });
  assert.equal(result.allowed, false);
  assert(result.conflicts.some((text) => text.includes("Объём")));
  assert(result.conflicts.some((text) => text.includes("слотов")));
  assert.equal(
    sample.compatibility.assess(sample.core.products[boardAM4.i], {
      ram: ddr4.i,
    }).allowed,
    false,
  );
  assert.equal(
    compatibility.assess(ddr5, { motherboard: boardAM4.i }).allowed,
    false,
  );
});

test("Формат платы, высота кулера и длина БП исключают неподходящий корпус", () => {
  const sample = fixture((copy) => {
    copy.products[boardAM4.i][3][2] = "ATX";
    copy.products[cooler.i][3][1] = "999";
    copy.products[psu550.i][3][2] = "999";
  });
  const result = sample.compatibility.assess(sample.core.products[box.i], {
    motherboard: boardAM4.i,
    cooling: cooler.i,
    psu: psu550.i,
  });
  assert.equal(result.allowed, false);
  assert(result.conflicts.some((text) => text.includes("формату")));
  assert(result.conflicts.some((text) => text.includes("Кулер")));
  assert(
    result.conflicts.some((text) => text.includes("Блок питания длиннее")),
  );
  assert.equal(
    sample.compatibility.assess(sample.core.products[boardAM4.i], {
      case: box.i,
    }).allowed,
    false,
  );
  assert.equal(
    sample.compatibility.assess(sample.core.products[cooler.i], { case: box.i })
      .allowed,
    false,
  );
  assert.equal(
    sample.compatibility.assess(sample.core.products[psu550.i], { case: box.i })
      .allowed,
    false,
  );
});

test("Крепление кулера связано с CPU и не требует сначала выбрать CPU", () => {
  assert.equal(compatibility.assess(cooler, {}).allowed, true);
  const sample = fixture((copy) => {
    copy.products[cooler.i][3][0] = "LGA1700";
  });
  assert.equal(
    sample.compatibility.assess(sample.core.products[cooler.i], { cpu: am4.i })
      .allowed,
    false,
  );
  assert.equal(
    sample.compatibility.assess(sample.core.products[am4.i], {
      cooling: cooler.i,
    }).allowed,
    false,
  );
});

test("Чужой конфликт CPU/платы или GPU/БП не скрывает SSD и платы", () => {
  const parts = {
    cpu: am5.i,
    motherboard: boardAM4.i,
    gpu: gpu.i,
    psu: psu550.i,
  };
  const drives = core.products.filter((p) => p.c === "storage");
  assert.equal(compatibility.filter(drives, parts).length, drives.length);
  assert.equal(compatibility.assess(boardAM5, parts).allowed, true);
  assert.equal(
    compatibility.assess(cooler, { ...parts, cpu: am4.i }).allowed,
    true,
  );
});

test("Arc A750 с неизвестными параметрами остаётся видимой с предупреждением", () => {
  const card = find("ASRock Intel Arc A750 Challenger D 8GB OC");
  const parts = { case: box.i, psu: psu550.i };
  const result = compatibility.assess(card, parts);
  assert.equal(result.allowed, true);
  assert.equal(result.status, "unknown");
  assert(result.unknown.some((text) => text.includes("длина")));
  assert(result.unknown.some((text) => text.includes("потребление")));
  assert(compatibility.filter([card], parts).includes(card));
  const full = core.buildParts(
    data.builds.find((b) => b[0] === "Игры в Full HD"),
  );
  assert.equal(core.check({ ...full, gpu: card.i }).need, null);
});

test("Неизвестное поле без соответствующей пары не блокирует частичный состав", () => {
  const card = find("ASRock Intel Arc A750 Challenger D 8GB OC");
  assert.equal(compatibility.assess(card, {}).status, "compatible");
  assert.equal(
    compatibility.assess(cooler, { storage: 29 }).status,
    "compatible",
  );
});

test("Проверка не меняет состав, товары, порядок и количество моделей", () => {
  const parts = { cpu: am4.i, motherboard: boardAM4.i, ram: ddr4.i };
  const before = JSON.stringify(parts);
  const beforeProducts = JSON.stringify(core.products);
  assert.equal(core.products.length, 190);
  assert.equal(compatibility.filter(core.products, {}).length, 190);
  for (const product of core.products) compatibility.assess(product, parts);
  assert.equal(JSON.stringify(parts), before);
  assert.equal(JSON.stringify(core.products), beforeProducts);
  assert.equal(compatibility.assess(undefined, parts).allowed, false);
  assert.equal(
    compatibility.assess({ i: am4.i, c: "gpu" }, parts).allowed,
    false,
  );
});
