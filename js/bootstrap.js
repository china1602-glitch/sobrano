/* Выбор режима и загрузка данных: Python API локально, JSON на GitHub Pages. */
(function (root) {
  "use strict";

  const siteURL = new URL("../", document.currentScript.src);
  let selectedBackend = "";

  async function readJSON(url, label) {
    const controller = new AbortController();
    const timeout =
      root.SOBRANO_RUNTIME?.requestTimeoutMs === 0
        ? null
        : setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`${label}: HTTP ${response.status}.`);
      }
      try {
        return await response.json();
      } catch {
        throw new Error(`${label}: сервер вернул некорректный JSON.`);
      }
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`${label}: сервер не ответил за 15 секунд.`);
      }
      if (error instanceof TypeError) {
        throw new Error(`${label}: не удалось подключиться к серверу.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function validateCatalog(data) {
    if (
      !object(data) ||
      !Array.isArray(data.products) ||
      !Array.isArray(data.builds) ||
      !object(data.photos) ||
      !data.products.every((row) => Array.isArray(row) && row.length === 4) ||
      !data.builds.every((row) => Array.isArray(row) && row.length === 4)
    ) {
      throw new Error("Данные каталога имеют неверный формат.");
    }
  }

  function loadScript(filename) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("js/" + filename, siteURL).href;
      script.async = true;
      script.onload = resolve;
      script.onerror = () =>
        reject(new Error(`Не удалось загрузить модуль ${filename}.`));
      document.head.append(script);
    });
  }

  async function start() {
    if (siteURL.protocol === "file:") {
      throw new Error(
        "Откройте сайт через локальный сервер, а не двойным щелчком по HTML-файлу.",
      );
    }
    const runtime = await readJSON(
      new URL("runtime.json", siteURL),
      "Режим сайта",
    );
    if (!object(runtime) || !["static", "python"].includes(runtime.backend)) {
      throw new Error("Режим сайта не настроен: ожидается static или python.");
    }
    selectedBackend = runtime.backend;
    root.SOBRANO_RUNTIME = Object.freeze({ ...runtime, baseURL: siteURL.href });

    let catalog;
    let offers;
    if (runtime.backend === "python") {
      const apiBase = new URL(runtime.apiBase || "api/", siteURL);
      if (
        apiBase.origin !== siteURL.origin ||
        !["http:", "https:"].includes(apiBase.protocol)
      ) {
        throw new Error(
          "Адрес API должен находиться на том же сервере, что и сайт.",
        );
      }
      if (!apiBase.pathname.endsWith("/")) apiBase.pathname += "/";
      const data = await readJSON(
        new URL("catalog", apiBase),
        "Каталог Python API",
      );
      validateCatalog(data);
      if (
        !Array.isArray(data.offers) ||
        !object(data.prices) ||
        !object(data.buildResults)
      ) {
        throw new Error("Python API вернул неполные данные цен или сборок.");
      }
      catalog = {
        products: data.products,
        builds: data.builds,
        photos: data.photos,
      };
      offers = data.offers;
      root.SOBRANO_SERVER_DATA = data;
    } else {
      [catalog, offers] = await Promise.all([
        readJSON(new URL("data/catalog.json", siteURL), "Каталог"),
        readJSON(new URL("data/offers.json", siteURL), "Предложения магазинов"),
      ]);
      validateCatalog(catalog);
      if (!Array.isArray(offers))
        throw new Error("Предложения магазинов имеют неверный формат.");
      root.SOBRANO_SERVER_DATA = null;
    }
    root.SOBRANO_DATA = catalog;
    root.SOBRANO_OFFERS = offers;

    // Эти библиотеки независимы друг от друга после загрузки данных.
    await Promise.all([
      loadScript("core.js"),
      loadScript("product-images.js"),
      loadScript("pricing.js"),
      loadScript("catalog-ui.js"),
    ]);
    await Promise.all([loadScript("compatibility.js"), loadScript("media.js")]);
    await loadScript("backend-client.js");
    await loadScript("app.js");
    if (
      root.SOBRANO_APP_READY &&
      typeof root.SOBRANO_APP_READY.then === "function"
    ) {
      const initialized = await root.SOBRANO_APP_READY;
      if (initialized === false) {
        throw new Error("Не удалось завершить загрузку приложения.");
      }
    }
  }

  function showError(error) {
    root.SOBRANO_BOOT_ERROR = error.message;
    console.error("СОБРАНО: ошибка запуска", error);
    const container = document.getElementById("app") || document.body;
    const heading = document.createElement("h1");
    heading.textContent = "Не удалось загрузить сайт";
    const message = document.createElement("p");
    message.textContent = error.message;
    const help = document.createElement("p");
    help.textContent =
      selectedBackend === "python"
        ? "Проверьте, что Python-сервер запущен, затем повторите загрузку."
        : "Проверьте подключение и доступность файлов сайта, затем повторите загрузку.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Повторить загрузку";
    retry.addEventListener("click", () => root.location.reload());
    container.setAttribute("role", "alert");
    container.replaceChildren(heading, message, help, retry);
  }

  // Промис также позволяет проверкам дождаться завершения начальной загрузки.
  root.SOBRANO_READY = start().then(
    () => true,
    (error) => {
      showError(error);
      return false;
    },
  );
})(window);
