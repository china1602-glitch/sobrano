/* Связь интерфейса с Python API. В статическом режиме этот модуль не считает правила. */
(function (root) {
  "use strict";
  const Core = root.SobranoCore;
  const runtime = root.SOBRANO_RUNTIME || {};
  const enabled = runtime.backend === "python";
  const data = root.SOBRANO_SERVER_DATA || {};
  const snapshots = new Map();
  const buildResults = new Map();
  const key = (parts) => Core.partsString(Core.validateParts(parts));
  for (const result of Object.values(data.buildResults || {})) {
    buildResults.set(key(result.parts), result);
  }
  const apiBase = new URL(
    runtime.apiBase || "api/",
    runtime.baseURL || location.href,
  );

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer =
      runtime.requestTimeoutMs === 0
        ? null
        : setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(new URL(path, apiBase), {
        ...options,
        cache: "no-store",
        signal: controller.signal,
      });
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error("Python-сервер вернул некорректный ответ.");
      }
      if (!response.ok)
        throw new Error(body.error || "Ошибка Python API: " + response.status);
      return body;
    } catch (error) {
      if (error.name === "AbortError" || error instanceof TypeError)
        throw new Error(
          "Python-сервер недоступен. Проверьте терминал VS Code и повторите действие.",
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function prepare(parts) {
    if (!enabled) return { parts: Core.validateParts(parts) };
    const result = await request("configuration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts }),
    });
    if (
      !result.parts ||
      !result.check ||
      !result.budget ||
      !result.assessments ||
      Core.products.some((p) => !result.assessments[p.id])
    ) {
      throw new Error("Python API вернул неполный результат проверки.");
    }
    snapshots.set(key(result.parts), result);
    return result;
  }
  function snapshot(parts) {
    const result = snapshots.get(key(parts)) || buildResults.get(key(parts));
    if (!result)
      throw new Error("Для этого состава ещё нет ответа Python API.");
    return result;
  }
  function assess(product, parts) {
    const p = typeof product === "number" ? Core.products[product] : product;
    const result = snapshots.get(key(parts))?.assessments[p?.id];
    if (!result)
      throw new Error("Для этого кандидата ещё нет ответа Python API.");
    return result;
  }
  async function catalogue(params, parts, ids) {
    const query = new URLSearchParams(params);
    query.set("parts", key(parts));
    if (Array.isArray(ids)) query.set("ids", ids.map((i) => "p" + i).join(","));
    const result = await request("products?" + query);
    if (
      !Array.isArray(result.ids) ||
      result.ids.some(
        (id) => !/^p\d+$/.test(id) || !Core.products[Number(id.slice(1))],
      )
    )
      throw new Error("Python API вернул некорректный каталог.");
    return result;
  }
  async function builds(task, max) {
    const query = new URLSearchParams();
    if (task) query.set("task", task);
    if (max) query.set("budget", max);
    const result = await request("builds?" + query);
    if (
      !Array.isArray(result.ids) ||
      result.ids.some(
        (id) => !/^b\d+$/.test(id) || !Core.builds[Number(id.slice(1))],
      )
    )
      throw new Error("Python API вернул некорректный список сборок.");
    return result.ids.map((id) => Number(id.slice(1)));
  }
  const pricing = {
    offers: data.offers || [],
    offersFor: (product) =>
      (data.offers || []).filter((offer) => offer.productId === product.id),
    price(product) {
      const result = data.prices?.[product.id];
      if (!result) throw new Error("Python API не вернул цену модели.");
      return result;
    },
    budget: (parts) => snapshot(parts).budget,
  };
  root.SobranoBackend = {
    enabled,
    prepare,
    catalogue,
    builds,
    pricing,
    check: (parts) => snapshot(parts).check,
    compatibility: {
      assess,
      filter: (products, parts) =>
        products.filter((p) => assess(p, parts).allowed),
    },
  };
})(window);
