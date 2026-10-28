/* Серверные контракты каталога. Общие правила импортируются без копирования. */
import Core from "../js/core.js";
import Compatibility from "../js/compatibility.js";
import Catalog from "../js/catalog-ui.js";
import Pricing from "../js/pricing.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

const CATEGORIES = Object.freeze([
  "cpu", "gpu", "motherboard", "ram", "storage", "psu", "case", "cooling",
]);
const plainObject = (value) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const decimal = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const clone = (value) => structuredClone(value);

/** В отличие от восстановления localStorage API отклоняет неверный состав. */
export function validateParts(parts, products) {
  if (!plainObject(parts)) throw new HttpError(400, "Состав должен быть объектом категорий и номеров товаров.");
  for (const [category, index] of Object.entries(parts)) {
    if (!CATEGORIES.includes(category)) throw new HttpError(400, "Неизвестная категория компонента: " + category);
    if (!Number.isSafeInteger(index) || index < 0 || !products[index])
      throw new HttpError(400, "Неверный номер компонента в категории " + category);
    if (products[index].c !== category)
      throw new HttpError(400, "Компонент не принадлежит категории " + category);
  }
  return Object.fromEntries(CATEGORIES.filter(category => Object.hasOwn(parts, category)).map(category => [category, parts[category]]));
}

function queryParams(input) {
  const params = input instanceof URLSearchParams ? new URLSearchParams(input) : new URLSearchParams(input || "");
  if (params.toString().length > 8192) throw new HttpError(400, "Слишком длинная строка параметров");
  const keys = new Set();
  let count = 0;
  for (const [key] of params) {
    if (++count > 40) throw new HttpError(400, "Слишком много параметров запроса");
    if (keys.has(key)) throw new HttpError(400, `Параметр ${key} не должен повторяться`);
    keys.add(key);
  }
  return params;
}

function numberParam(params, key, integer = false) {
  const value = params.get(key);
  if (value === null || value === "") return null;
  const text = value.trim();
  const number = decimal.test(text) ? Number(text) : NaN;
  if (!Number.isFinite(number) || number < 0)
    throw new HttpError(400, `Параметр ${key} должен быть конечным неотрицательным числом`);
  if (integer && !Number.isSafeInteger(number))
    throw new HttpError(400, "Бюджет должен быть неотрицательным целым числом тенге");
  return number;
}

function parseQueryParts(text, products) {
  if (text.length > 256) throw new HttpError(400, "В parts должно быть восемь позиций через запятую");
  const tokens = text.split(",");
  if (tokens.length !== CATEGORIES.length)
    throw new HttpError(400, "В parts должно быть восемь позиций через запятую");
  const parts = {};
  for (const [position, token] of tokens.entries()) {
    if (token === "") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(token)) throw new HttpError(400, "parts содержит недопустимый индекс товара");
    parts[CATEGORIES[position]] = Number(token);
  }
  return validateParts(parts, products);
}

export function createDomain(raw, offers = [], now = Date.now()) {
  if (!plainObject(raw) || !Array.isArray(raw.products) || !Array.isArray(raw.builds) ||
      raw.products.some(row => !Array.isArray(row) || row.length !== 4 || !CATEGORIES.includes(row[0]) ||
        typeof row[1] !== "string" || !row[1].trim() || !Array.isArray(row[3]) ||
        (row[2] !== null && (!Number.isFinite(row[2]) || row[2] < 0))))
    throw new TypeError("Некорректные данные каталога");
  if (!Array.isArray(offers) || !Number.isFinite(now)) throw new TypeError("Некорректные данные цен или времени");
  const data = clone({products: raw.products, builds: raw.builds, photos: plainObject(raw.photos) ? raw.photos : {}});
  const core = Core.create(data);
  const compatibility = Compatibility.create(core);
  const pricing = Pricing.create(offers);
  const products = core.products;
  const prices = Object.fromEntries(products.map(product => [product.id, pricing.price(product, now)]));
  const budget = parts => pricing.budget(parts, products, now);
  const buildResults = {};
  data.builds.forEach((build, index) => {
    if (!Array.isArray(build) || build.length !== 4 || !Array.isArray(build[3]) || build[3].length !== CATEGORIES.length)
      throw new TypeError("Некорректная готовая сборка");
    const parts = validateParts(Object.fromEntries(CATEGORIES.flatMap((category, i) =>
      build[3][i] === null ? [] : [[category, build[3][i]]])), products);
    buildResults["b" + index] = {parts, check: core.check(parts), budget: budget(parts)};
  });

  function catalogPayload() {
    return clone({...data, offers: pricing.offers, prices, buildResults});
  }

  function configurationPayload(input) {
    const parts = validateParts(input, products);
    return {
      parts,
      check: core.check(parts),
      budget: budget(parts),
      assessments: Object.fromEntries(products.map(product => [product.id, compatibility.assess(product, parts)])),
    };
  }

  function productsPayload(input) {
    const params = queryParams(input);
    const category = params.get("cat") || "";
    if (category && !CATEGORIES.includes(category)) throw new HttpError(400, "Неизвестная категория товара");
    if (!["", "name", "asc", "desc"].includes(params.get("sort") || "")) throw new HttpError(400, "Неизвестный порядок сортировки");
    if (!["", "all"].includes(params.get("compat") || "")) throw new HttpError(400, "Параметр compat допускает только значение all");
    const minimum = numberParam(params, "min");
    const maximum = numberParam(params, "max");
    if (minimum !== null && maximum !== null && minimum > maximum) throw new HttpError(400, "Минимальная цена не может быть больше максимальной");
    const parts = params.has("parts") ? parseQueryParts(params.get("parts"), products) : {};
    let candidates = products;
    if (params.has("ids")) {
      const ids = params.get("ids") ? params.get("ids").split(",") : [];
      if (ids.length > products.length || ids.some(id => !/^p(?:0|[1-9][0-9]*)$/.test(id)))
        throw new HttpError(400, "ids должен содержать идентификаторы товаров через запятую");
      const selected = new Set(ids);
      if ([...selected].some(id => !products[Number(id.slice(1))])) throw new HttpError(400, "В ids указан несуществующий товар");
      candidates = products.filter(product => selected.has(product.id));
    }
    const withPrices = candidates.map(product => ({...product, displayPrice: prices[product.id].value}));
    const filtered = Catalog.filter(withPrices, params, category);
    const rows = params.get("compat") === "all" ? filtered : filtered.filter(product => compatibility.assess(product, parts).allowed);
    return {ids: rows.map(product => product.id), total: candidates.length, filteredTotal: filtered.length, hidden: filtered.length - rows.length};
  }

  function buildsPayload(input) {
    const params = queryParams(input);
    const maximum = numberParam(params, "budget", true);
    const task = params.get("task") || "";
    return {ids: data.builds.flatMap((build, index) =>
      (!task || build[1] === task) && (maximum === null || buildResults["b" + index].budget.value <= maximum) ? ["b" + index] : [])};
  }

  return {catalogPayload, configurationPayload, productsPayload, buildsPayload};
}
