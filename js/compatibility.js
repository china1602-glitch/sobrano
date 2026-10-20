/* Отбор компонентов для текущего состава. Это проверка кандидата, а не всей сборки. */
(function (root, create) {
  "use strict";
  const api = root.SobranoCore ? create(root.SobranoCore) : {};
  api.create = create;
  root.SobranoCompatibility = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(
  typeof window === "object" ? window : globalThis,
  function createCompatibility(core) {
    "use strict";
    if (
      !core ||
      !Array.isArray(core.products) ||
      typeof core.validateParts !== "function"
    ) {
      throw new TypeError("Для отбора компонентов требуется SobranoCore.");
    }

    const present = (value) =>
      value !== null && value !== undefined && String(value).trim() !== "";
    const positive = (value) =>
      present(value) && Number.isFinite(Number(value)) && Number(value) > 0;
    const normalized = (value) =>
      String(value ?? "")
        .trim()
        .toUpperCase();
    const list = (value) => String(value).split(":").map(normalized);
    const format = (value) =>
      normalized(value)
        .replace(/[^A-Z0-9]/g, "")
        .replace(/^MICROATX$/, "MATX");
    const maxPowerFlag = (value) =>
      ["0", "1"].includes(String(value)) ? Number(value) : null;

    function assess(product, parts) {
      const index = typeof product === "number" ? product : product?.i;
      const candidate = core.products[index];
      if (
        !Number.isInteger(index) ||
        !candidate ||
        (typeof product === "object" && product?.c !== candidate.c)
      ) {
        return {
          allowed: false,
          status: "conflict",
          conflicts: ["Компонент отсутствует в каталоге."],
          unknown: [],
        };
      }

      // Временная замена позволяет предлагать исправление уже конфликтного состава.
      const selected = {
        ...core.validateParts(parts),
        [candidate.c]: candidate.i,
      };
      const get = (category) =>
        Object.hasOwn(selected, category)
          ? core.products[selected[category]]
          : null;
      const cpu = get("cpu");
      const board = get("motherboard");
      const ram = get("ram");
      const gpu = get("gpu");
      const psu = get("psu");
      const box = get("case");
      const cooler = get("cooling");
      const conflicts = [];
      const unknown = [];
      const conflict = (message) => {
        if (!conflicts.includes(message)) conflicts.push(message);
      };
      const unsure = (message) => {
        if (!unknown.includes(message)) unknown.push(message);
      };
      const involves = (...categories) => categories.includes(candidate.c);

      if (cpu && board && involves("cpu", "motherboard")) {
        if (!present(cpu.v[0]) || !present(board.v[0]))
          unsure("Не указан сокет процессора или платы.");
        else if (normalized(cpu.v[0]) !== normalized(board.v[0]))
          conflict(
            "Сокет процессора не совпадает с сокетом материнской платы.",
          );
      }

      if (cpu && ram && involves("cpu", "ram")) {
        if (!present(cpu.v[1]) || !present(ram.v[0]))
          unsure("Не указан поддерживаемый процессором тип памяти.");
        else if (!list(cpu.v[1]).includes(normalized(ram.v[0])))
          conflict("Процессор не поддерживает выбранный тип памяти.");
      }

      if (board && ram && involves("motherboard", "ram")) {
        if (!present(board.v[1]) || !present(ram.v[0]))
          unsure("Не указан тип памяти платы или модулей.");
        else if (normalized(board.v[1]) !== normalized(ram.v[0]))
          conflict("Тип памяти не поддерживается материнской платой.");
        if (!positive(board.v[4]) || !positive(ram.v[1]))
          unsure("Не указан объём памяти или допустимый объём для платы.");
        else if (Number(ram.v[1]) > Number(board.v[4]))
          conflict("Объём памяти превышает предел материнской платы.");
        if (!positive(board.v[3]) || !positive(ram.v[2]))
          unsure("Не указано количество слотов платы или модулей памяти.");
        else if (Number(ram.v[2]) > Number(board.v[3]))
          conflict("Для выбранных модулей недостаточно слотов памяти.");
      }

      if (board && box && involves("motherboard", "case")) {
        if (!present(board.v[2]) || !present(box.v[0]))
          unsure("Не указан формат платы или поддерживаемые корпусом форматы.");
        else if (
          !String(box.v[0]).split(":").map(format).includes(format(board.v[2]))
        )
          conflict("Материнская плата не подходит по формату к корпусу.");
      }

      if (cpu && cooler && involves("cpu", "cooling")) {
        if (!present(cpu.v[0]) || !present(cooler.v[0]))
          unsure("Не указаны сокет CPU или крепления кулера.");
        else if (!list(cooler.v[0]).includes(normalized(cpu.v[0])))
          conflict("Для кулера не заявлено крепление к сокету процессора.");
      }

      if (cooler && box && involves("cooling", "case")) {
        if (!positive(cooler.v[1]) || !positive(box.v[2]))
          unsure("Не указана высота кулера или допустимая высота для корпуса.");
        else if (Number(cooler.v[1]) > Number(box.v[2]))
          conflict("Кулер выше допустимого размера для корпуса.");
      }

      if (gpu && box && involves("gpu", "case")) {
        if (!positive(gpu.v[2]) || !positive(box.v[1]))
          unsure(
            "Не указана длина видеокарты или предел корпуса: проверьте размеры.",
          );
        else if (Number(gpu.v[2]) > Number(box.v[1]))
          conflict("Видеокарта длиннее допустимого размера для корпуса.");
      }

      if (psu && box && involves("psu", "case")) {
        if (!positive(psu.v[2]) || !positive(box.v[3]))
          unsure("Не указана длина блока питания или предел корпуса.");
        else if (Number(psu.v[2]) > Number(box.v[3]))
          conflict("Блок питания длиннее допустимого размера для корпуса.");
      }

      if (psu && (cpu || gpu) && involves("cpu", "gpu", "psu")) {
        const psuKnown = positive(psu.v[0]);
        if (!psuKnown) unsure("Не указана мощность выбранного блока питания.");
        let knownLoad = 0;
        let hasKnownLoad = false;
        let gpuRecommendation = 0;

        if (cpu) {
          const flag = maxPowerFlag(cpu.v[7]);
          if (positive(cpu.v[2]) && flag !== null) {
            knownLoad += Number(cpu.v[2]) * (flag === 1 ? 1 : 1.5);
            hasKnownLoad = true;
          } else
            unsure(
              "Недостаточно данных о мощности процессора для проверки блока питания.",
            );
        }
        if (gpu) {
          if (positive(gpu.v[0])) {
            knownLoad += Number(gpu.v[0]);
            hasKnownLoad = true;
          } else
            unsure(
              "Не указано потребление видеокарты: окончательный подбор БП требует проверки.",
            );
          if (positive(gpu.v[1])) gpuRecommendation = Number(gpu.v[1]);
          else
            unsure(
              "Не указан рекомендованный производителем видеокарты блок питания.",
            );
        }

        // Нижняя граница нужна только для исключения заведомо слабых БП.
        // Неизвестные нагрузки не считаются нулём: они остаются предупреждениями,
        // а полный расчёт всей конфигурации выполняет core.check().
        const loadBound = hasKnownLoad
          ? Math.ceil(((knownLoad + 75) * 1.25) / 50) * 50
          : 0;
        const lowerBound = Math.max(gpuRecommendation, loadBound);
        if (psuKnown && lowerBound > 0 && Number(psu.v[0]) < lowerBound) {
          conflict(
            "Мощность БП ниже расчётного порога или рекомендации видеокарты: " +
              lowerBound +
              " Вт.",
          );
        }
      }

      return {
        allowed: conflicts.length === 0,
        status: conflicts.length
          ? "conflict"
          : unknown.length
            ? "unknown"
            : "compatible",
        conflicts,
        unknown,
      };
    }

    function filter(products, parts) {
      return (Array.isArray(products) ? products : []).filter(
        (product) => assess(product, parts).allowed,
      );
    }

    return { assess, filter };
  },
);
