const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load(extraPhotos) {
  const context = vm.createContext({ window: {}, URL });
  for (const name of ["data", "product-images"]) {
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "../js/" + name + ".js"), "utf8"),
      context,
    );
  }
  if (extraPhotos) context.window.SOBRANO_PRODUCT_IMAGES = extraPhotos;
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../js/media.js"), "utf8"),
    context,
  );
  return {
    media: context.window.SobranoMedia,
    data: context.window.SOBRANO_DATA,
    photos: context.window.SOBRANO_PRODUCT_IMAGES,
  };
}

const { media, data, photos } = load();

test("OEM/BOX совпадают с тем же CPU, а разные модели и производители — нет", () => {
  assert.equal(
    media.get("  AMD Ryzen 5 7600 OEM   "),
    media.get("AMD Ryzen 5 7600"),
  );
  assert.equal(
    media.get("Intel Core i5-13400 BOX"),
    media.get("Intel Core i5-13400 OEM"),
  );
  assert.notEqual(
    media.get("AMD Ryzen 5 5600").src,
    media.get("AMD Ryzen 5 5600X").src,
  );
  assert.notEqual(
    media.get("Intel Core i5-12400").src,
    media.get("Intel Core i5-12400F").src,
  );
  assert.equal(media.get("AMD Ryzen 7 5700X3D OEM"), null);
  assert.equal(media.get("Неизвестная видеокарта"), null);
  assert.equal(
    media.get("MSI GeForce RTX 4060 VENTUS 2X BLACK 8G OC OEM"),
    null,
  );
});

test("ранее проверенные свободные фотографии имеют приоритет", () => {
  const competing = {
    models: ["AMD Ryzen 5 7600 OEM", "Corsair 4000D AIRFLOW"],
    src: "https://example.com/manufacturer.jpg",
    source: "https://example.com/product",
    sourceName: "Производитель",
    kind: "exact",
  };
  const { media: priority } = load([competing]);
  assert.match(
    priority.get("AMD Ryzen 5 7600").source,
    /commons\.wikimedia\.org/,
  );
  assert.match(priority.get("Corsair 4000D AIRFLOW").src, /lossy-page1-500px/);
  assert.equal(priority.get("AMD Ryzen 5 7600").license, "Free Art License");
  assert.equal(media.credits().filter((photo) => photo.license).length, 13);
});

test("изображение исполнения явно отличается от точной фотографии товара", () => {
  const family = { name: "NVIDIA GeForce RTX 5070", c: "gpu" };
  const exact = {
    name: "MSI GeForce RTX 4060 VENTUS 2X BLACK 8G OC",
    c: "gpu",
  };
  assert.equal(media.get(family).kind, "family");
  assert.match(media.render(family), /Изображение линейки/);
  assert.match(media.render(family), /alt="Изображение линейки для NVIDIA/);
  assert.match(
    media.render(family, { large: true }),
    /Вид и размеры других исполнений могут отличаться/,
  );
  assert.equal(media.get(exact).kind, "exact");
  assert.doesNotMatch(media.render(exact), /Изображение линейки/);
  assert.notEqual(
    media.get(exact).src,
    media.get("NVIDIA GeForce RTX 3090").src,
  );
  assert.match(
    media.render({ name: "NVIDIA GeForce RTX 3090", c: "gpu" }),
    /Founders Edition/,
  );
});

test("коробочная фотография OEM-процессора имеет видимую подпись", () => {
  const html = media.render({ name: "AMD Ryzen 5 5500 OEM", c: "cpu" });
  assert.match(
    html,
    /<figcaption[\s\S]*На фото BOX; OEM может быть без коробки и кулера/,
  );
  assert.match(html, /Источник: Newegg/);
  assert.doesNotMatch(html, /creativecommons|CC BY|undefined/);
});

test("производителям не приписываются автор и свободная лицензия", () => {
  assert(photos.length > 100);
  for (const photo of photos) {
    assert.equal(new URL(photo.src).protocol, "https:");
    assert.equal(new URL(photo.source).protocol, "https:");
    assert(photo.sourceName);
    assert(!photo.license && !photo.licenseURL && !photo.author);
  }
  const manufacturer = media.get("MSI GeForce RTX 4070 VENTUS 2X 12G OC");
  assert.match(media.sourceHTML(manufacturer), /Источник: MSI/);
  assert.doesNotMatch(
    media.sourceHTML(manufacturer),
    /creativecommons|CC BY|undefined/,
  );
  assert.match(
    media.sourceHTML(media.get("AMD Ryzen 5 5600X")),
    /Phiarc[\s\S]*CC BY-SA 4\.0/,
  );
});

test("небезопасные ссылки и семейство без пояснения не попадают в реестр", () => {
  const photo = {
    src: "https://example.com/photo.jpg",
    source: "https://example.com/model",
    sourceName: "Производитель",
    kind: "exact",
  };
  const { media: checked } = load([
    { ...photo, models: ["Допустимая модель"] },
    { ...photo, models: ["HTTP"], src: "http://example.com/photo.jpg" },
    { ...photo, models: ["Скрипт"], source: "javascript:alert(1)" },
    {
      ...photo,
      models: ["Пароль в URL"],
      src: "https://user:pass@example.com/photo.jpg",
    },
    {
      ...photo,
      models: ["Небезопасный fallback"],
      fallback: "javascript:alert(1)",
    },
    { ...photo, models: ["Без пояснения"], kind: "family" },
    { ...photo, models: ["Неизвестный тип"], kind: "пример" },
    { ...photo, models: ["Неполная лицензия"], license: "CC BY 4.0" },
  ]);
  assert(checked.get("Допустимая модель"));
  for (const model of [
    "HTTP",
    "Скрипт",
    "Пароль в URL",
    "Небезопасный fallback",
    "Без пояснения",
    "Неизвестный тип",
    "Неполная лицензия",
  ]) {
    assert.equal(checked.get(model), null);
  }
  assert.equal(
    checked.sourceHTML({ source: "javascript:alert(1)", sourceName: "X" }),
    "",
  );
  const html = checked.sourceHTML({
    ...photo,
    sourceName: '<img src=x onerror="alert(1)">',
  });
  assert(!html.includes("<img"));
  assert.match(html, /&lt;img/);
});

test("покрытие считается по действующим товарам и не скрывает отсутствующие фото", () => {
  const coverage = media.coverage();
  const available = data.products.filter((row) => media.get(row[1]));
  assert.equal(coverage.total, data.products.length);
  assert.equal(coverage.withPhoto, available.length);
  assert.equal(coverage.exact + coverage.family, coverage.withPhoto);
  assert.equal(coverage.withoutPhoto + coverage.withPhoto, coverage.total);
  assert.equal(coverage.withPhoto, 189);
  assert.equal(coverage.withoutPhoto, 1);
  assert.deepEqual(
    Array.from(
      data.products.filter((row) => !media.get(row[1])),
      (row) => row[1],
    ),
    ["AMD Ryzen 7 5700X3D OEM"],
  );
  assert(
    data.products
      .filter((row) => row[0] === "gpu")
      .every((row) => media.get(row[1])),
  );
  const placeholder = media.render({
    name: "Неизвестный компонент",
    c: "motherboard",
  });
  assert.match(placeholder, /Фото не добавлено/);
  assert(!placeholder.includes("<img"));
});

test("единый источник линейки сохраняет список вариантов без дублирования кредита", () => {
  const family = media
    .credits()
    .find((photo) =>
      photo.models.includes("Kingston FURY Beast 16 ГБ (1×16) DDR4-3600"),
    );
  assert(family && family.models.length >= 5);
  assert.equal(family.kind, "family");
  assert.equal(
    media
      .credits()
      .filter(
        (photo) => photo.source === family.source && photo.src === family.src,
      ).length,
    1,
  );
});
