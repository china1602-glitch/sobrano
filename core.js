/* Данные каталога, подписи характеристик и базовые проверки конфигурации. */
(function (root, create) {
  "use strict";
  const api = create(root.SOBRANO_DATA || { products: [], builds: [] });
  api.create = create;
  root.SobranoCore = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window === "object" ? window : globalThis, function createCore(data) {
  "use strict";

  const categories = Object.freeze({
    cpu: "Процессоры",
    gpu: "Видеокарты",
    motherboard: "Материнские платы",
    ram: "Оперативная память",
    storage: "SSD и HDD",
    psu: "Блоки питания",
    case: "Корпуса",
    cooling: "Охлаждение",
  });
  const cats = Object.keys(categories);
  const fields = {
    cpu: [
      "Сокет",
      "Тип памяти",
      "Мощность CPU",
      "Встроенная графика",
      "Кулер в комплекте",
      "Ядра",
      "Потоки",
    ],
    gpu: ["Потребление", "Рекомендованный БП", "Длина", "Видеопамять"],
    motherboard: [
      "Сокет",
      "Тип памяти",
      "Форм-фактор",
      "Слоты памяти",
      "Максимум памяти",
    ],
    ram: ["Тип памяти", "Общий объём", "Число модулей", "Скорость"],
    storage: ["Интерфейс", "Объём", "Формат M.2", "Чтение до"],
    psu: ["Мощность", "Форм-фактор", "Длина"],
    case: ["Форматы плат", "Видеокарта до", "Кулер до", "Блок питания до"],
    cooling: ["Поддерживаемые сокеты", "Высота"],
  };
  const products = (Array.isArray(data.products) ? data.products : []).map(
    (row, i) => ({
      i,
      id: "p" + i,
      c: row[0],
      name: String(row[1]),
      price:
        Number.isFinite(Number(row[2])) && Number(row[2]) >= 0
          ? Number(row[2])
          : null,
      v: Array.isArray(row[3]) ? row[3].slice() : [],
      brand: String(row[1]).split(" ")[0],
    }),
  );
  const builds = Array.isArray(data.builds) ? data.builds : [];
  const numberFormat = new Intl.NumberFormat("ru-KZ");
  const present = (value) =>
    value !== null && value !== undefined && String(value).trim() !== "";
  const positive = (value) =>
    present(value) && Number.isFinite(Number(value)) && Number(value) > 0;
  const bool = (value) =>
    ["0", "1"].includes(String(value)) ? Number(value) : null;
  const valid = (index) =>
    Number.isInteger(index) && index >= 0 && !!products[index];
  const normalized = (value) =>
    String(value ?? "")
      .trim()
      .toUpperCase();
  const formatNumber = (value) => numberFormat.format(Number(value));
  const capacity = (value) =>
    Number(value) >= 1000 && Number(value) % 1000 === 0
      ? formatNumber(Number(value) / 1000) + " ТБ"
      : formatNumber(value) + " ГБ";

  function spec(product, index) {
    if (!product || !present(product.v?.[index])) return "Не указано";
    const value = product.v[index];
    if (product.c === "cpu" && (index === 3 || index === 4)) {
      const flag = bool(value);
      return flag === null ? "Не указано" : flag ? "Да" : "Нет";
    }
    if (product.c === "cpu" && index === 2) {
      if (!positive(value)) return "Не указано";
      const kind = bool(product.v[7]);
      return (
        formatNumber(value) +
        " Вт" +
        (kind === 1 ? " (максимум)" : kind === 0 ? " (TDP)" : "")
      );
    }
    if (
      (product.c === "gpu" && [0, 1].includes(index)) ||
      (product.c === "psu" && index === 0)
    ) {
      return positive(value) ? formatNumber(value) + " Вт" : "Не указано";
    }
    if (
      (product.c === "gpu" && index === 2) ||
      (product.c === "psu" && index === 2) ||
      (product.c === "case" && index > 0) ||
      (product.c === "cooling" && index === 1)
    ) {
      return positive(value) ? formatNumber(value) + " мм" : "Не указано";
    }
    if (
      (product.c === "ram" && index === 1) ||
      (product.c === "storage" && index === 1) ||
      (product.c === "motherboard" && index === 4) ||
      (product.c === "gpu" && index === 3)
    ) {
      return positive(value) ? capacity(value) : "Не указано";
    }
    if (product.c === "ram" && index === 3) {
      return positive(value) ? formatNumber(value) + " MT/s" : "Не указано";
    }
    if (product.c === "storage" && index === 3) {
      return positive(value) ? formatNumber(value) + " МБ/с" : "Не указано";
    }
    return String(value).replaceAll(":", " / ");
  }

  function brief(product) {
    if (!product || !fields[product.c]) return [];
    const value = (index) => spec(product, index);
    switch (product.c) {
      case "cpu":
        return [
          "Ядра / потоки: " + value(5) + " / " + value(6),
          "Сокет: " + value(0),
          "Память: " + value(1),
          "Встроенная графика: " + value(3),
        ];
      case "gpu":
        return [
          "Видеопамять: " + value(3),
          "Потребление: " + value(0),
          "Длина: " + value(2),
        ];
      case "motherboard":
        return [
          "Сокет: " + value(0),
          "Память: " + value(1),
          "Формат: " + value(2),
          "Слоты RAM: " + value(3),
        ];
      case "ram":
        return [
          "Объём: " + value(1),
          "Тип: " + value(0),
          "Модули: " + value(2),
          "Скорость: " + value(3),
        ];
      case "storage":
        return [
          "Объём: " + value(1),
          "Интерфейс: " + value(0),
          "Чтение до: " + value(3),
        ];
      case "psu":
        return [
          "Мощность: " + value(0),
          "Формат: " + value(1),
          "Длина: " + value(2),
        ];
      case "case":
        return [
          "Платы: " + value(0),
          "Видеокарта до: " + value(1),
          "Кулер до: " + value(2),
        ];
      case "cooling":
        return ["Сокеты: " + value(0), "Высота: " + value(1)];
      default:
        return [];
    }
  }

  function validateParts(parts) {
    if (!parts || typeof parts !== "object" || Array.isArray(parts)) return {};
    return Object.fromEntries(
      cats
        .filter(
          (category) =>
            valid(parts[category]) && products[parts[category]].c === category,
        )
        .map((category) => [category, parts[category]]),
    );
  }

  function parseParts(text) {
    if (typeof text !== "string" || text.length > 256) return {};
    const tokens = text.split(",");
    if (tokens.length > cats.length) return {};
    const parts = {};
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i].trim();
      if (!token) continue;
      if (!/^(0|[1-9]\d*)$/.test(token)) continue;
      const index = Number(token);
      if (valid(index) && products[index].c === cats[i]) parts[cats[i]] = index;
    }
    return parts;
  }

  function partsString(parts) {
    const safe = validateParts(parts);
    return cats.map((category) => safe[category] ?? "").join(",");
  }

  function total(parts) {
    return Object.values(validateParts(parts)).reduce(
      (sum, index) => sum + (products[index].price ?? 0),
      0,
    );
  }

  function buildParts(build) {
    if (!Array.isArray(build?.[3])) return {};
    return validateParts(
      Object.fromEntries(
        cats.map((category, index) => [category, build[3][index]]),
      ),
    );
  }

  function check(parts) {
    const safe = validateParts(parts);
    const get = (category) =>
      Object.hasOwn(safe, category) ? products[safe[category]] : null;
    const cpu = get("cpu");
    const board = get("motherboard");
    const ram = get("ram");
    const gpu = get("gpu");
    const psu = get("psu");
    const box = get("case");
    const cooler = get("cooling");
    const bad = [];
    const unknown = [];
    const missing = [
      "cpu",
      "motherboard",
      "ram",
      "storage",
      "psu",
      "case",
    ].filter((category) => !get(category));
    const uncertain = (message) => {
      if (!unknown.includes(message)) unknown.push(message);
    };
    const cpuGraphics = cpu ? bool(cpu.v[3]) : null;
    const cpuCooler = cpu ? bool(cpu.v[4]) : null;
    if (cpu && !gpu) {
      if (cpuGraphics === 0) missing.push("gpu");
      else if (cpuGraphics === null)
        uncertain("Не указано, есть ли у процессора встроенная графика.");
    }
    if (cpu && !cooler) {
      if (cpuCooler === 0) missing.push("cooling");
      else if (cpuCooler === null)
        uncertain("Не указано, входит ли кулер в комплект процессора.");
    }

    if (cpu && board) {
      if (!present(cpu.v[0]) || !present(board.v[0]))
        uncertain("Не указан сокет процессора или материнской платы.");
      else if (normalized(cpu.v[0]) !== normalized(board.v[0]))
        bad.push("Сокеты процессора и материнской платы отличаются.");
    }
    if (board && ram) {
      if (!present(board.v[1]) || !present(ram.v[0]))
        uncertain("Не указан тип памяти платы или выбранных модулей.");
      else if (normalized(board.v[1]) !== normalized(ram.v[0]))
        bad.push("Тип памяти не поддерживается материнской платой.");
      if (!positive(ram.v[1]) || !positive(board.v[4]))
        uncertain("Не указан объём памяти или максимальный объём для платы.");
      else if (Number(ram.v[1]) > Number(board.v[4]))
        bad.push("Объём памяти превышает максимум материнской платы.");
      if (!positive(ram.v[2]) || !positive(board.v[3]))
        uncertain("Не указано число модулей памяти или слотов платы.");
      else if (Number(ram.v[2]) > Number(board.v[3]))
        bad.push("На материнской плате недостаточно слотов памяти.");
    }
    if (cpu && ram) {
      if (!present(cpu.v[1]) || !present(ram.v[0]))
        uncertain("Не указан поддерживаемый процессором тип памяти.");
      else if (
        !String(cpu.v[1])
          .split(":")
          .map(normalized)
          .includes(normalized(ram.v[0]))
      )
        bad.push("Тип памяти не поддерживается процессором.");
    }
    if (cpu && cooler) {
      if (!present(cpu.v[0]) || !present(cooler.v[0]))
        uncertain("Не указан сокет CPU или крепления кулера.");
      else if (
        !String(cooler.v[0])
          .split(":")
          .map(normalized)
          .includes(normalized(cpu.v[0]))
      )
        bad.push("Для кулера не заявлено крепление к выбранному сокету CPU.");
    }
    if (board && box) {
      const format = (value) =>
        normalized(value)
          .replace(/[^A-Z0-9]/g, "")
          .replace(/^MICROATX$/, "MATX");
      if (!present(board.v[2]) || !present(box.v[0]))
        uncertain(
          "Не указан формат платы или поддерживаемые корпусом форматы.",
        );
      else if (
        !String(box.v[0]).split(":").map(format).includes(format(board.v[2]))
      )
        bad.push(
          "Корпус не поддерживает форм-фактор выбранной материнской платы.",
        );
    }
    if (gpu && box) {
      if (!positive(gpu.v[2]) || !positive(box.v[1]))
        uncertain(
          "Не указана длина видеокарты или допустимая длина для корпуса.",
        );
      else if (Number(gpu.v[2]) > Number(box.v[1]))
        bad.push("Видеокарта длиннее допустимого размера для корпуса.");
    }
    if (cooler && box) {
      if (!positive(cooler.v[1]) || !positive(box.v[2]))
        uncertain(
          "Не указана высота кулера или допустимая высота для корпуса.",
        );
      else if (Number(cooler.v[1]) > Number(box.v[2]))
        bad.push("Кулер выше допустимого размера для корпуса.");
    }
    if (psu && box) {
      if (!positive(psu.v[2]) || !positive(box.v[3]))
        uncertain(
          "Не указана длина блока питания или допустимая длина для корпуса.",
        );
      else if (Number(psu.v[2]) > Number(box.v[3]))
        bad.push("Блок питания длиннее допустимого размера для корпуса.");
    }
    if (psu && !positive(psu.v[0]))
      uncertain("Не указана мощность выбранного блока питания.");

    let need = null;
    let powerKnown = !!cpu;
    const powerKind = cpu ? bool(cpu.v[7]) : null;
    if (cpu && (!positive(cpu.v[2]) || powerKind === null)) {
      uncertain(
        "Недостаточно данных о мощности CPU для расчёта блока питания.",
      );
      powerKnown = false;
    }
    if (gpu) {
      if (!positive(gpu.v[0])) {
        uncertain(
          "Не указано потребление видеокарты: расчёт блока питания недоступен.",
        );
        powerKnown = false;
      }
      if (!positive(gpu.v[1])) {
        uncertain(
          "Не указан рекомендованный производителем видеокарты блок питания.",
        );
        powerKnown = false;
      }
    } else if (!cpu || cpuGraphics !== 1) powerKnown = false;

    if (powerKnown) {
      const cpuPower = Number(cpu.v[2]) * (powerKind === 1 ? 1 : 1.5);
      const gpuPower = gpu ? Number(gpu.v[0]) : 0;
      const recommendation = gpu ? Number(gpu.v[1]) : 0;
      need =
        Math.ceil(
          Math.max((cpuPower + gpuPower + 75) * 1.25, recommendation) / 50,
        ) * 50;
      if (psu && positive(psu.v[0]) && Number(psu.v[0]) < need)
        bad.push(
          "Мощность блока питания ниже расчётного минимума: " +
            formatNumber(need) +
            " Вт.",
        );
    }
    const status = bad.length
      ? "conflict"
      : missing.length
        ? "incomplete"
        : unknown.length
          ? "unknown"
          : "ok";
    return { bad, missing, unknown, need, status };
  }

  return {
    categories,
    fields,
    cats,
    products,
    builds,
    valid,
    spec,
    brief,
    total,
    buildParts,
    validateParts,
    parseParts,
    partsString,
    check,
  };
});
