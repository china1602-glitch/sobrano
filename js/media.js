// Фотографии сопоставляются с моделью, а не с категорией.
// Для фотографий из Commons сохранены авторы и лицензии; для остальных — источник.
(function (root) {
  "use strict";

  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  const key = (value) =>
    String(typeof value === "string" ? value : value?.name || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(AMD Ryzen|Intel Core)(.+)\s+(OEM|BOX)$/i, "$1$2")
      .toLowerCase();
  const models = new Map();

  function httpsURL(value) {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }

  function register(model, photo) {
    if (!key(model) || models.has(key(model))) return;
    if (!httpsURL(photo?.src) || !httpsURL(photo?.source)) return;
    if (!photo.sourceName && !photo.author) return;
    if (photo.fallback && !httpsURL(photo.fallback)) return;
    if (photo.license || photo.licenseURL) {
      if (!photo.license || !httpsURL(photo.licenseURL)) return;
    }
    if (photo.kind && photo.kind !== "exact" && photo.kind !== "family") return;
    const kind = photo.kind === "family" ? "family" : "exact";
    if (kind === "family" && !photo.note) return;
    models.set(
      key(model),
      Object.freeze({ ...photo, kind, model, title: model }),
    );
  }

  // Уже проверенные фотографии из исходного набора используются только
  // для совпадающих моделей. Например, фото NV2 не подходит для NV3.
  const old = root.SOBRANO_DATA?.photos || {};
  register("AMD Ryzen 5 7600", old.cpu);
  register("MSI MAG B550 TOMAHAWK", old.motherboard);
  register("DeepCool AK400", old.cooling);

  const rows = [
    [
      "AMD Ryzen 5 5600X",
      "a/a2/AMD_Ryzen_5_5600X.jpg",
      "Phiarc",
      "by-sa",
      "4.0",
    ],
    [
      "AMD Ryzen 7 5700X",
      "a/a7/AMD_Ryzen_7_5700X_1.jpg",
      "Qurren",
      "by-sa",
      "4.0",
    ],
    [
      "AMD Ryzen 7 5800X",
      "c/c7/AMD_Ryzen_7_5800X_19339.jpg",
      "Michael Wolf, Penig",
      "by-sa",
      "3.0",
    ],
    [
      "AMD Ryzen 7 7800X3D",
      "b/bc/Ryzen_7_7800_X3D%2C_unlocked.jpg",
      "Thomas Vogt",
      "by",
      "2.0",
    ],
    [
      "Intel Core i7-13700K",
      "0/0c/Intel_Core_i7_13700K.jpg",
      "4300streetcar",
      "by",
      "4.0",
    ],
    [
      "Noctua NH-D15",
      "3/38/NH-D15_with_classic_fans.jpg",
      "Kaleb Kloppe",
      "by",
      "2.0",
    ],
    [
      "Samsung 980 PRO 1 ТБ",
      "7/75/Samsung_980_PRO_PCIe_4.0_NVMe_SSD_1TB-top_PNr%C2%B00915.jpg",
      "D-Kuru/Wikimedia Commons",
      "by-sa",
      "4.0",
    ],
    [
      "Samsung 970 EVO Plus 250 ГБ",
      "6/6a/2023_Nap%C4%99d_Samsung_970_EVO_Plus_250GB_%281%29.jpg",
      "Jacek Halicki",
      "by-sa",
      "4.0",
    ],
  ];

  for (const [model, path, author, kind, version] of rows) {
    const filename = path.split("/").pop();
    register(model, {
      src:
        "https://thumb.wikimedia.org/wikipedia/commons/thumb/" +
        path +
        "/960px-" +
        filename,
      fallback: "https://upload.wikimedia.org/wikipedia/commons/" + path,
      source: "https://commons.wikimedia.org/wiki/File:" + filename,
      author,
      license: "CC " + kind.toUpperCase() + " " + version,
      licenseURL:
        "https://creativecommons.org/licenses/" + kind + "/" + version + "/",
      checkedAt: "2026-10-20",
    });
  }

  // Исходный TIFF этого корпуса весит 40 МБ. Обе ссылки ведут
  // на JPEG-превью; браузер не загружает большой TIFF при ошибке.
  const casePhotos = [
    {
      model: "Corsair 4000D AIRFLOW",
      author: "PJ",
      license: "CC BY-SA 4.0",
      licenseURL: "https://creativecommons.org/licenses/by-sa/4.0/",
      source:
        "https://commons.wikimedia.org/wiki/File:Corsair_4000D_Airflow_mid-tower_ATX_case.tif",
      src: "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/85/Corsair_4000D_Airflow_mid-tower_ATX_case.tif/lossy-page1-500px-Corsair_4000D_Airflow_mid-tower_ATX_case.tif.jpg",
      fallback:
        "https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Corsair_4000D_Airflow_mid-tower_ATX_case.tif/lossy-page1-500px-Corsair_4000D_Airflow_mid-tower_ATX_case.tif.jpg",
      checkedAt: "2026-10-20",
    },
  ];
  for (const photo of casePhotos) register(photo.model, photo);

  // Только строка семейства NVIDIA: конкретные MSI/ASUS/Sapphire
  // по этому ключу не совпадут с референсной платой.
  register("NVIDIA GeForce RTX 3090", {
    src: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/48/RTX_3090_Founders_Edition.jpg/960px-RTX_3090_Founders_Edition.jpg",
    fallback:
      "https://upload.wikimedia.org/wikipedia/commons/4/48/RTX_3090_Founders_Edition.jpg",
    source:
      "https://commons.wikimedia.org/wiki/File:RTX_3090_Founders_Edition.jpg",
    author: "Adam Kapetanakis",
    license: "CC BY-SA 4.0",
    licenseURL: "https://creativecommons.org/licenses/by-sa/4.0/",
    note: "Референсная версия (Founders Edition)",
    kind: "family",
    checkedAt: "2026-10-20",
  });

  // Совпадение модели требуется и для нового набора. Ранее проверенные
  // свободные фотографии выше имеют приоритет перед дополнительными ссылками.
  for (const photo of root.SOBRANO_PRODUCT_IMAGES || []) {
    if (!Array.isArray(photo.models)) continue;
    for (const model of photo.models) register(model, photo);
  }

  const labels = {
    cpu: "Процессор",
    gpu: "Видеокарта",
    motherboard: "Материнская плата",
    ram: "Оперативная память",
    storage: "Накопитель",
    psu: "Блок питания",
    case: "Корпус",
    cooling: "Охлаждение",
  };
  const shapes = {
    cpu: '<rect x="17" y="17" width="30" height="30" rx="3"/><rect x="23" y="23" width="18" height="18" rx="1"/><path d="M22 9v8m10-8v8m10-8v8M22 47v8m10-8v8m10-8v8M9 22h8m-8 10h8m-8 10h8m30-20h8m-8 10h8m-8 10h8"/>',
    gpu: '<rect x="9" y="17" width="46" height="29" rx="2"/><circle cx="25" cy="31" r="9"/><circle cx="45" cy="31" r="7"/><path d="M5 13v38m4-4h17m-9-1v6m6-6v6M25 22v18m-9-9h18m11-7v14m-7-7h14"/>',
    motherboard:
      '<rect x="12" y="9" width="40" height="46" rx="2"/><rect x="20" y="17" width="16" height="16" rx="1"/><path d="M42 16v25m5-25v25M19 41h16m-16 7h24M17 9v7m14 17v8m5-8h7"/>',
    ram: '<rect x="7" y="19" width="50" height="24" rx="2"/><path d="M13 26h8v9h-8zm15 0h8v9h-8zm15 0h8v9h-8zM12 43v5m7-5v5m7-5v5m12-5v5m7-5v5m7-5v5"/>',
    storage:
      '<rect x="8" y="21" width="48" height="22" rx="2"/><rect x="18" y="26" width="12" height="12" rx="1"/><rect x="36" y="26" width="10" height="12" rx="1"/><path d="M52 21v22M8 28h5m-5 8h5"/>',
    psu: '<path d="M13 16h34l8 8v29H13zM13 16l-4 8v29h46M47 16v8h8"/><circle cx="34" cy="38" r="10"/><path d="M34 30v16m-8-8h16"/>',
    case: '<rect x="17" y="7" width="31" height="49" rx="2"/><path d="M39 7v49M22 15h11m-11 6h11m-10 29h22"/><circle cx="43" cy="14" r="1"/><circle cx="29" cy="36" r="8"/>',
    cooling:
      '<path d="M18 15h28v35H18zm0 7h28m-28 7h28m-28 7h28m-28 7h28M24 50v7m16-7v7M24 7v8m16-8v8"/><circle cx="32" cy="32" r="9"/>',
  };

  function get(product) {
    return models.get(key(product)) || null;
  }

  function sourceHTML(photo) {
    if (!photo || !httpsURL(photo.source)) return "";
    const name = photo.author || photo.sourceName;
    if (!name) return "";
    const label = photo.author ? name : "Источник: " + name;
    const source = `<a href="${esc(photo.source)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
    if (!photo.license || !httpsURL(photo.licenseURL)) return source;
    return `${source} · <a href="${esc(photo.licenseURL)}" target="_blank" rel="noopener noreferrer">${esc(photo.license)}</a>`;
  }

  function placeholder(product = {}, { className = "", large = false } = {}) {
    const category = product.c || product.category || "cpu";
    return `<figure class="product-media media-placeholder ${large ? "media-large" : ""} ${esc(className)}"
      data-media-category="${esc(category)}" data-media-model="${esc(product.name || "")}"
      aria-label="${esc(labels[category] || "Комплектующее")}: фото модели не добавлено">
      <svg class="media-symbol" viewBox="0 0 64 64" width="56" height="56" fill="none"
        stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
        ${shapes[category] || shapes.cpu}
      </svg>
      <span class="media-label">Фото не добавлено</span>
    </figure>`;
  }

  function render(product, options = {}) {
    const photo = get(product);
    if (!photo) return placeholder(product, options);
    const { className = "", large = false } = options;
    const size = large ? 480 : 160;
    const packaging =
      /\bBOX\b/i.test(photo.note || "") && /\bOEM\b/i.test(photo.note || "");
    const captions = [];
    if (photo.kind === "family") captions.push("Изображение линейки");
    if (packaging)
      captions.push("На фото BOX; OEM может быть без коробки и кулера");
    if (photo.note?.includes("Founders Edition"))
      captions.push("Founders Edition");
    if (large && photo.note) captions.push(photo.note);
    const description =
      (photo.kind === "family" ? "Изображение линейки для " : "") +
      product.name;
    return `<figure class="product-media ${large ? "media-large" : ""} ${esc(className)}"
      data-media-category="${esc(product.c || "")}" data-media-model="${esc(product.name)}" data-media-kind="${photo.kind}">
      <img src="${esc(photo.src)}" data-fallback="${esc(photo.fallback || photo.src)}"
        alt="${esc(description + (photo.note ? "; " + photo.note : ""))}" width="${size}" height="${size}"
        loading="lazy" decoding="async" referrerpolicy="no-referrer">
      <figcaption class="media-credit">
        ${captions.map((caption) => `<span class="media-note">${esc(caption)}</span><br>`).join("")}
        ${sourceHTML(photo)}
      </figcaption>
    </figure>`;
  }

  function credits() {
    const sources = new Map();
    for (const photo of models.values()) {
      const id = photo.source + "\n" + photo.src;
      if (!sources.has(id)) sources.set(id, { ...photo, models: [] });
      sources.get(id).models.push(photo.model);
    }
    return [...sources.values()];
  }

  function coverage(products = root.SOBRANO_DATA?.products || []) {
    let exact = 0;
    let family = 0;
    for (const product of products) {
      const photo = get(Array.isArray(product) ? product[1] : product);
      if (photo?.kind === "exact") exact++;
      if (photo?.kind === "family") family++;
    }
    return {
      total: products.length,
      withPhoto: exact + family,
      withoutPhoto: products.length - exact - family,
      exact,
      family,
      sources: credits().length,
    };
  }

  const api = { get, render, credits, placeholder, sourceHTML, coverage };
  root.SobranoMedia = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
