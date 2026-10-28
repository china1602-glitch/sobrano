/* HTTP-клиент онлайн и локального API. Статический режим работает отдельно. */
(function (root) {
  "use strict";
  const Core = root.SobranoCore;
  const runtime = root.SOBRANO_RUNTIME || {};
  const enabled = runtime.backend === "python" || runtime.backend === "server";
  const savedAvailable = enabled && runtime.features?.savedBuilds === true;
  const accountsAvailable = savedAvailable && runtime.features?.accounts === true;
  let sessionPromise = null;
  let currentUser = null;
  let authLoaded = false;
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

  if (!apiBase.pathname.endsWith("/")) apiBase.pathname += "/";

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer =
      runtime.requestTimeoutMs === 0
        ? null
        : setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(new URL(path, apiBase), {
        ...options,
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error("Сервер вернул некорректный ответ.");
      }
      if (!response.ok) {
        const error = new Error(body.error || "Ошибка серверного API: " + response.status);
        error.status = response.status;
        throw error;
      }
      return body;
    } catch (error) {
      if (error.name === "AbortError" || error instanceof TypeError)
        throw new Error(
          runtime.backend === "python"
            ? "Python-сервер недоступен. Проверьте терминал VS Code и повторите действие."
            : "Сервер недоступен. Проверьте подключение и повторите действие.",
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
      throw new Error("Серверное API вернул неполный результат проверки.");
    }
    snapshots.set(key(result.parts), result);
    return result;
  }
  function snapshot(parts) {
    const result = snapshots.get(key(parts)) || buildResults.get(key(parts));
    if (!result)
      throw new Error("Для этого состава ещё нет ответа Серверное API.");
    return result;
  }
  function assess(product, parts) {
    const p = typeof product === "number" ? Core.products[product] : product;
    const result = snapshots.get(key(parts))?.assessments[p?.id];
    if (!result)
      throw new Error("Для этого кандидата ещё нет ответа Серверное API.");
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
      throw new Error("Серверное API вернул некорректный каталог.");
    return result;
  }
  async function builds(task, max) {
    const query = new URLSearchParams();
    if (task) query.set("task", task);
    if (max !== null && max !== undefined && max !== "") {
      const limit = Number(max);
      if (!Number.isSafeInteger(limit) || limit < 0)
        throw new Error("Введите корректный неотрицательный бюджет в целых тенге.");
      query.set("budget", limit);
    }
    const result = await request("builds?" + query);
    if (
      !Array.isArray(result.ids) ||
      result.ids.some(
        (id) => !/^b\d+$/.test(id) || !Core.builds[Number(id.slice(1))],
      )
    )
      throw new Error("Серверное API вернул некорректный список сборок.");
    return result.ids.map((id) => Number(id.slice(1)));
  }

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function savedId(id) {
    if (typeof id !== "string" || !uuidPattern.test(id))
      throw new Error("Некорректный идентификатор сохранённой сборки.");
    return encodeURIComponent(id);
  }
  function savedRecord(value) {
    if (!value || typeof value !== "object" || !uuidPattern.test(value.id) ||
        typeof value.name !== "string" || !value.name.trim() || value.name.length > 80 ||
        !Number.isSafeInteger(value.version) || value.version < 1 ||
        !value.parts || typeof value.parts !== "object" || Array.isArray(value.parts) ||
        !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt)) ||
        Object.entries(value.parts).some(([category, index]) =>
          !Number.isInteger(index) || !Core.products[index] || Core.products[index].c !== category))
      throw new Error("Сервер вернул некорректную сохранённую сборку.");
    return value;
  }
  function requireSaved() {
    if (!savedAvailable) throw new Error("Сохранение в базу доступно только на сайте с онлайн-сервером.");
  }
  async function session() {
    requireSaved();
    if (!sessionPromise) sessionPromise = request("session").then(value => {
      if (!value || typeof value.csrfToken !== "string" || !value.csrfToken)
        throw new Error("Не удалось подготовить защищённое сохранение сборки.");
      if (accountsAvailable) acceptUser(value);
      return value;
    }).catch(error => { sessionPromise = null; throw error; });
    return sessionPromise;
  }
  function acceptUser(value) {
    const user = value?.user;
    if (user !== null && (!user || typeof user.id !== "string" || !user.id ||
        typeof user.username !== "string" || !/^[a-z0-9_]{3,32}$/.test(user.username) ||
        typeof user.displayName !== "string" || user.displayName.length > 60))
      throw new Error("Сервер вернул некорректные данные аккаунта.");
    currentUser = user ? Object.freeze({ id: user.id, username: user.username, displayName: user.displayName }) : null;
    authLoaded = true;
    return currentUser;
  }
  function acceptAuth(value) {
    if (!value || typeof value.csrfToken !== "string" || !value.csrfToken)
      throw new Error("Сервер не подтвердил защищённую сессию аккаунта.");
    acceptUser(value);
    sessionPromise = Promise.resolve(value);
    return value;
  }
  function requireAccounts() {
    if (!accountsAvailable) throw new Error("Вход в аккаунт доступен при запуске сервера Node.js. Откройте проект в VS Code и запустите node online/server.mjs.");
  }
  const auth = {
    get user() { return currentUser; },
    get loaded() { return authLoaded; },
    async me() {
      requireAccounts();
      try { return acceptAuth(await request("auth/me")); }
      catch (error) { sessionPromise = null; throw error; }
    },
    async register(username, password, displayName) {
      requireAccounts();
      return acceptAuth(await savedWrite("auth/register", "POST", { username, password, displayName }));
    },
    async login(username, password) {
      requireAccounts();
      return acceptAuth(await savedWrite("auth/login", "POST", { username, password }));
    },
    async logout() {
      requireAccounts();
      const value = await savedWrite("auth/logout", "POST", {});
      if (!value || value.user !== null || value.csrfToken !== null)
        throw new Error("Сервер не подтвердил выход из аккаунта.");
      currentUser = null;
      authLoaded = true;
      sessionPromise = null;
      return value;
    },
  };
  async function savedWrite(path, method, body) {
    const current = await session();
    try {
      return await request(path, {
        method,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": current.csrfToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error.status === 401 || error.status === 403) sessionPromise = null;
      throw error;
    }
  }
  const saved = {
    async list() {
      await session();
      const result = await request("saved-builds");
      if (!result || !Array.isArray(result.items))
        throw new Error("Сервер вернул некорректный список сохранённых сборок.");
      return result.items.map(value => ({ ...savedRecord(value), canEdit: true }));
    },
    async load(id) {
      requireSaved();
      return savedRecord(await request("saved-builds/" + savedId(id)));
    },
    async create(name, parts, requestId) {
      if (typeof requestId !== "string" || !uuidPattern.test(requestId))
        throw new Error("Не удалось подготовить идентификатор сохранения.");
      return savedRecord(await savedWrite("saved-builds", "POST", { name, parts, requestId }));
    },
    async update(id, name, parts, version) {
      return savedRecord(await savedWrite("saved-builds/" + savedId(id), "PUT", { name, parts, version }));
    },
    async remove(id) {
      return savedWrite("saved-builds/" + savedId(id), "DELETE");
    },
  };

  const pricing = {
    offers: data.offers || [],
    offersFor: (product) =>
      (data.offers || []).filter((offer) => offer.productId === product.id),
    price(product) {
      const result = data.prices?.[product.id];
      if (!result) throw new Error("Серверное API не вернул цену модели.");
      return result;
    },
    budget: (parts) => snapshot(parts).budget,
  };
  root.SobranoBackend = {
    enabled,
    savedAvailable,
    accountsAvailable,
    auth,
    saved,
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
