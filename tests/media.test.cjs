const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load(extraPhotos, localPhotos) {
  const context = vm.createContext({
    window: {
      SOBRANO_DATA: JSON.parse(
        fs.readFileSync(path.join(__dirname, "../data/catalog.json"), "utf8"),
      ),
    },
    URL,
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../js/product-images.js"), "utf8"),
    context,
  );
  if (extraPhotos) context.window.SOBRANO_PRODUCT_IMAGES = extraPhotos;
  if (localPhotos) context.window.SOBRANO_LOCAL_IMAGES = localPhotos;
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

test("локальный кеш сохраняет источник, подпись модели и запасную HTTPS-ссылку", () => {
  const model = "AMD Ryzen 5 5600";
  const photo = media.get(model);
  const local = "assets/products/amd-ryzen-5-5600-1234567890abcdef.jpg";
  const { media: cached } = load(null, { [photo.src]: local });
  assert.equal(cached.get(model).localSrc, local);
  assert.equal(cached.get(model).src, photo.src);
  const html = cached.render({ name: model, c: "cpu" });
  assert(html.includes('src="' + local + '"'));
  assert(html.includes('data-fallback="' + photo.src + '"'));
  assert.match(html, /Источник: Newegg/);
  for (const bad of ["../outside.jpg", "assets/products/../../outside.jpg", "https://unknown.example/photo.jpg", "assets/products/a.svg", "assets/products/a.jpg?bad=1"]) {
    const { media: safe } = load(null, { [photo.src]: bad });
    assert.equal(safe.get(model).localSrc, null);
    assert(safe.render({ name: model, c: "cpu" }).includes('src="' + photo.src + '"'));
  }
});

test("манифест кеша соответствует фотографиям действующего каталога", () => {
  const sources = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/photo-cache-sources.json"), "utf8"));
  const byURL = new Map(sources.map((record) => [record.src, record]));
  assert.equal(byURL.size, sources.length);
  let mapped = 0;
  for (const row of data.products) {
    const photo = media.get(row[1]);
    if (!photo) continue;
    const source = byURL.get(photo.src);
    assert(source, row[1]);
    assert.equal(source.source, photo.source);
    assert.equal(source.fallback, photo.fallback);
    assert(source.models.includes(row[1]));
    mapped++;
  }
  assert.equal(mapped, media.coverage().withPhoto);
});

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
