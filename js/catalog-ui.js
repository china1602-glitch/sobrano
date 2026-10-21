/* Фильтры каталога. Данные, расчёты и обработчики страницы находятся отдельно. */
(function (root) {
  "use strict";

  const escapeHTML = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (symbol) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[symbol],
    );
  const collator = new Intl.Collator("ru", {
    numeric: true,
    sensitivity: "base",
  });
  const number = (value) =>
    new Intl.NumberFormat("ru-KZ").format(Number(value));
  const valueAt = (product, index) => String(product.v?.[index] ?? "").trim();
  const splitAt = (product, index) =>
    valueAt(product, index).split(":").filter(Boolean);
  const one = (value) => (value === "" ? [] : [value]);
  const displayPrice = (product) =>
    Number(product.displayPrice ?? product.price);

  function gpuFamily(product) {
    if (/\b(?:GeForce|NVIDIA)\b/i.test(product.name)) return ["nvidia"];
    if (/\bRadeon\b/i.test(product.name)) return ["radeon"];
    if (/\bArc\b/i.test(product.name)) return ["arc"];
    return [];
  }

  // Каждый фильтр читает соответствующее поле исходного набора данных.
  // Неизвестные значения не превращаются в нули и не попадают в список вариантов.
  const definitions = {
    cpu: [
      { key: "socket", label: "Сокет", values: (p) => one(valueAt(p, 0)) },
      {
        key: "cores",
        label: "Количество ядер",
        values: (p) => one(valueAt(p, 5)),
      },
      {
        key: "graphics",
        label: "Встроенная графика",
        values: (p) => one(valueAt(p, 3)),
        format: (value) =>
          value === "1" ? "Есть" : value === "0" ? "Нет" : value,
      },
      {
        key: "type",
        label: "Поддерживаемая память",
        values: (p) => splitAt(p, 1),
      },
    ],
    gpu: [
      {
        key: "family",
        label: "Семейство GPU",
        values: gpuFamily,
        format: (value) =>
          ({
            nvidia: "NVIDIA GeForce",
            radeon: "AMD Radeon",
            arc: "Intel Arc",
          })[value] || value,
      },
      {
        key: "vram",
        label: "Видеопамять",
        values: (p) => one(valueAt(p, 3)),
        format: (value) => number(value) + " ГБ",
      },
    ],
    motherboard: [
      { key: "socket", label: "Сокет", values: (p) => one(valueAt(p, 0)) },
      { key: "type", label: "Тип памяти", values: (p) => one(valueAt(p, 1)) },
      {
        key: "format",
        label: "Форм-фактор",
        values: (p) => one(valueAt(p, 2)),
      },
    ],
    ram: [
      { key: "type", label: "Тип памяти", values: (p) => one(valueAt(p, 0)) },
      {
        key: "capacity",
        label: "Общий объём комплекта",
        values: (p) => one(valueAt(p, 1)),
        format: (value) => number(value) + " ГБ",
      },
      {
        key: "modules",
        label: "Модулей в комплекте",
        values: (p) => one(valueAt(p, 2)),
        format: (value) => number(value),
      },
      {
        key: "speed",
        label: "Скорость памяти",
        values: (p) => one(valueAt(p, 3)),
        format: (value) => number(value) + " MT/s",
      },
    ],
    storage: [
      {
        key: "interface",
        label: "Интерфейс",
        values: (p) => one(valueAt(p, 0)),
      },
      {
        key: "capacity",
        label: "Объём накопителя",
        values: (p) => one(valueAt(p, 1)),
        format: (value) => number(value) + " ГБ",
      },
    ],
    psu: [
      {
        key: "watts",
        label: "Мощность",
        values: (p) => one(valueAt(p, 0)),
        format: (value) => number(value) + " Вт",
      },
    ],
    case: [
      {
        key: "format",
        label: "Поддерживаемые платы",
        values: (p) => splitAt(p, 0),
      },
    ],
    cooling: [
      {
        key: "socket",
        label: "Поддерживаемый сокет",
        values: (p) => splitAt(p, 0),
      },
    ],
  };

  const hasCategory = (category) =>
    Object.prototype.hasOwnProperty.call(definitions, category);
  const categoryDefinitions = (category) =>
    hasCategory(category) ? definitions[category] : [];

  function asParams(params) {
    return params instanceof URLSearchParams
      ? params
      : new URLSearchParams(params || "");
  }

  function facets(category, products = []) {
    const rows = products.filter((product) => product.c === category);
    return categoryDefinitions(category)
      .map((definition) => {
        const values = [
          ...new Set(
            rows.flatMap(definition.values).filter((value) => value !== ""),
          ),
        ];
        values.sort(collator.compare);
        return {
          key: definition.key,
          label: definition.label,
          options: values.map((value) => ({
            value,
            label: definition.format ? definition.format(value) : value,
          })),
        };
      })
      .filter((facet) => facet.options.length > 0);
  }

  function priceLimit(params, key) {
    const text = params.get(key);
    if (text === null || text.trim() === "") return null;
    const value = Number(text);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function filter(products, params, category = "") {
    params = asParams(params);
    const tokens = (params.get("search") || "")
      .toLocaleLowerCase("ru")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const brand = params.get("brand") || "";
    const min = priceLimit(params, "min");
    const max = priceLimit(params, "max");
    category = hasCategory(category) ? category : "";
    const active = categoryDefinitions(category).filter((definition) =>
      params.get(definition.key),
    );
    const rows = products.filter((product) => {
      if (category && product.c !== category) return false;
      const productBrand = product.brand || product.name.split(" ")[0];
      if (brand && productBrand !== brand) return false;
      if (min !== null && displayPrice(product) < min) return false;
      if (max !== null && displayPrice(product) > max) return false;
      const text = [product.name, productBrand, ...(product.v || [])]
        .join(" ")
        .toLocaleLowerCase("ru");
      if (!tokens.every((token) => text.includes(token))) return false;
      return active.every((definition) =>
        definition.values(product).includes(params.get(definition.key)),
      );
    });
    const byName = (a, b) => collator.compare(a.name, b.name);
    const sort = params.get("sort");
    rows.sort(
      sort === "asc"
        ? (a, b) => displayPrice(a) - displayPrice(b) || byName(a, b)
        : sort === "desc"
          ? (a, b) => displayPrice(b) - displayPrice(a) || byName(a, b)
          : byName,
    );
    return rows;
  }

  function categoryURL(category) {
    const params = new URLSearchParams();
    if (hasCategory(category)) params.set("cat", category);
    return "catalog.html" + (params.size ? "?" + params : "");
  }

  function itemURL(product) {
    const id =
      product?.id || (Number.isInteger(product?.i) ? "p" + product.i : "");
    return "product.html?" + new URLSearchParams({ id });
  }

  function selectField(
    name,
    label,
    options,
    selected,
    emptyLabel = "Все варианты",
  ) {
    return `<label class="filter-field" for="${name}">
      <span>${escapeHTML(label)}</span>
      <select id="${name}" name="${name}">
        <option value="">${escapeHTML(emptyLabel)}</option>
        ${options.map((option) => `<option value="${escapeHTML(option.value)}"${String(selected) === String(option.value) ? " selected" : ""}>${escapeHTML(option.label)}</option>`).join("")}
      </select>
    </label>`;
  }

  function filterPanel({
    category = "",
    params = new URLSearchParams(),
    products = [],
    action = "catalog.html",
  } = {}) {
    params = asParams(params);
    category = hasCategory(category) ? category : "";
    const rows = products.filter(
      (product) => !category || product.c === category,
    );
    const brands = [
      ...new Set(
        rows.map((product) => product.brand || product.name.split(" ")[0]),
      ),
    ].sort(collator.compare);
    const categoryField = category
      ? `<input type="hidden" name="cat" value="${escapeHTML(category)}">`
      : "";
    return `<form id="catalog-filters" class="filter-form" method="get" action="${escapeHTML(action)}">
      ${categoryField}
      <label class="filter-field" for="search">
        <span>Поиск по каталогу</span>
        <input id="search" name="search" type="search" value="${escapeHTML(params.get("search") || "")}"
          placeholder="Название модели или характеристика" autocomplete="off">
      </label>
      ${selectField(
        "brand",
        "Бренд",
        brands.map((value) => ({ value, label: value })),
        params.get("brand"),
        "Все бренды",
      )}
      <fieldset class="price-fields">
        <legend>Цена, ₸</legend>
        <label for="min"><span>От</span><input id="min" name="min" type="number" min="0" step="1" inputmode="numeric" placeholder="0" value="${escapeHTML(params.get("min") || "")}"></label>
        <label for="max"><span>До</span><input id="max" name="max" type="number" min="0" step="1" inputmode="numeric" placeholder="Без лимита" value="${escapeHTML(params.get("max") || "")}"></label>
      </fieldset>
      <p id="price-error" class="bad caption" role="status" aria-live="polite"></p>
      ${facets(category, products)
        .map((facet) =>
          selectField(
            facet.key,
            facet.label,
            facet.options,
            params.get(facet.key),
          ),
        )
        .join("")}
      <div class="filter-actions">
        <button class="btn" type="submit">Показать товары</button>
        <a class="link filter-reset" href="${escapeHTML(action === "favorites.html" ? "favorites.html" + (category ? "?" + new URLSearchParams({ cat: category }) : "") : categoryURL(category))}">Сбросить фильтры</a>
      </div>
    </form>`;
  }

  const api = Object.freeze({
    facets,
    filter,
    filterPanel,
    categoryURL,
    itemURL,
  });
  root.SobranoCatalog = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
