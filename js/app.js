/* СОБРАНО: страницы, выбор пользователя и обработчики интерфейса.
   В онлайн и локальном серверном режиме расчёты приходят из HTTP API.
   На GitHub Pages используются клиентские модули статического режима. */
window.SOBRANO_APP_READY = (async function () {
  "use strict";
  const Core = window.SobranoCore;
  const Catalog = window.SobranoCatalog;
  const Media = window.SobranoMedia;
  const Backend = window.SobranoBackend;
  const Prices = Backend.enabled ? Backend.pricing : window.SobranoPricing;
  const Compatibility = Backend.enabled
    ? Backend.compatibility
    : window.SobranoCompatibility;
  const P = Core.products,
    B = Core.builds,
    cats = Core.cats,
    names = Core.categories;
  const app = document.getElementById("app");
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  const money = (value) => new Intl.NumberFormat("ru-KZ").format(value) + " ₸";
  const date = (value) =>
    new Intl.DateTimeFormat("ru-KZ", {
      timeZone: "Asia/Qyzylorda",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date(value));
  const symbols = {
    cpu: "CPU",
    gpu: "GPU",
    motherboard: "MB",
    ram: "RAM",
    storage: "SSD",
    psu: "PSU",
    case: "CASE",
    cooling: "FAN",
  };
  const KEY = "sobrano:diploma:1";
  const page = (location.pathname.split("/").pop() || "index.html").replace(
    /\.html$/,
    "",
  );
  let params = new URLSearchParams(location.search),
    visible = 12,
    storageOK = true,
    incomingError = false,
    incomingApply = false,
    catalogueRequest = 0,
    buildsRequest = 0,
    compositionVersion = 0,
    pendingChanges = 0,
    timer,
    searchTimer;
  // Устаревшая или отредактированная ссылка не должна ломать Python-каталог.
  if (page === "catalog" || page === "favorites") {
    if (!cats.includes(params.get("cat"))) params.delete("cat");
    if (!["name", "asc", "desc"].includes(params.get("sort"))) params.delete("sort");
    if (params.get("compat") !== "all") params.delete("compat");
    for (const key of ["min", "max"]) {
      const value = params.get(key);
      if (value !== null && (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0))
        params.delete(key);
    }
  }
  let S = { fav: [], cmp: [], parts: {} };
  let savedBuild = null,
    savedPartsKey = "",
    incomingSavedError = "",
    saveAttempt = null,
    serverBusy = false,
    serverDialogVersion = 0;
  const ownedBuilds = new Map();
  let accountMode = "login",
    accountBusy = false,
    accountError = "",
    accountMessage = "",
    accountRequest = 0;
  let startupStorageText = null,
    startupStorageChanged = false;
  const trackStartupStorage = (event) => {
    if (event.key === KEY || event.key === null) startupStorageChanged = true;
  };
  window.addEventListener("storage", trackStartupStorage);
  function sanitize(value) {
    const valid = (list) =>
      Array.isArray(list) ? [...new Set(list.filter(Core.valid))] : [];
    const state = value && typeof value === "object" ? value : {};
    const cmp = valid(state.cmp).slice(0, 4);
    return {
      fav: valid(state.fav),
      cmp: cmp.filter((i) => P[i].c === P[cmp[0]]?.c),
      parts: Core.validateParts(state.parts),
    };
  }
  try {
    startupStorageText = localStorage.getItem(KEY);
    S = sanitize(JSON.parse(startupStorageText || "{}"));
  } catch {
    storageOK = false;
  }
  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(S));
    } catch {
      storageOK = false;
    }
    $("#storage-note").hidden = storageOK;
    counters();
  }
  // Полученная по ссылке сборка становится текущей и переживает переходы между страницами.
  if (page === "builder" && !params.has("saved") && params.has("parts")) {
    const payload = params.get("parts");
    const tokens = payload.split(",");
    const validLink =
      payload.length <= 256 &&
      tokens.length === cats.length &&
      tokens.every(
        (token, position) =>
          token === "" ||
          (/^(0|[1-9]\d*)$/.test(token) &&
            Core.valid(Number(token)) &&
            P[Number(token)].c === cats[position]),
      );
    if (validLink) {
      S.parts = Core.parseParts(payload);
      incomingApply = true;
    } else incomingError = true;
  }
  if (page === "builder" && params.has("saved")) {
    try {
      if (!Backend.savedAvailable)
        throw new Error("Эта ссылка открывает запись из онлайн-базы. Откройте её на сайте с сервером; в статическом и локальном Python-режимах такой базы нет.");
      const record = await Backend.saved.load(params.get("saved"));
      savedBuild = { ...record, canEdit: record.canEdit === true };
      savedPartsKey = Core.partsString(record.parts);
      S.parts = { ...record.parts };
      incomingApply = true;
    } catch (error) {
      incomingSavedError = error.message + " Ваш текущий состав оставлен без изменений.";
    }
  }
  try {
    // Пока первый HTTP-запрос выполняется, другая вкладка может изменить состав.
    // Перед показом интерфейса подготавливаем именно последнюю сохранённую версию.
    while (true) {
      await Backend.prepare(S.parts);
      if (!storageOK) break;
      let latest;
      try {
        latest = localStorage.getItem(KEY);
      } catch {
        storageOK = false;
        break;
      }
      if (!startupStorageChanged && latest === startupStorageText) break;
      startupStorageChanged = false;
      startupStorageText = latest;
      let next;
      try {
        next = sanitize(JSON.parse(latest || "{}"));
      } catch {
        storageOK = false;
        break;
      }
      if (!incomingApply && JSON.stringify(next) === JSON.stringify(S)) break;
      S = next;
      incomingApply = false;
    }
  } finally {
    window.removeEventListener("storage", trackStartupStorage);
  }
  if (incomingApply) persist();
  syncBuilderURL();

  let lockedControls = [],
    previousFocus;
  function lockComposition(active) {
    pendingChanges += active ? 1 : -1;
    if (active && pendingChanges === 1) {
      previousFocus = document.activeElement;
      lockedControls = [...app.querySelectorAll("button, input, select")].map(
        (node) => [node, node.disabled],
      );
      lockedControls.forEach(([node]) => {
        node.disabled = true;
      });
      app.setAttribute("aria-busy", "true");
    } else if (!active && pendingChanges === 0) {
      lockedControls.forEach(([node, disabled]) => {
        if (node.isConnected) node.disabled = disabled;
      });
      document
        .querySelectorAll('[data-action="remove-part"]')
        .forEach((node) => {
          node.disabled = S.parts[node.dataset.category] === undefined;
        });
      app.removeAttribute("aria-busy");
      if (previousFocus?.isConnected)
        previousFocus.focus({ preventScroll: true });
    }
  }
  async function changeComposition(parts, incomingState = null) {
    if (pendingChanges && !incomingState) return false;
    const version = ++compositionVersion;
    if (Backend.enabled) lockComposition(true);
    try {
      const result = await Backend.prepare(parts);
      if (version !== compositionVersion) return false;
      if (incomingState) S = incomingState;
      S.parts = result.parts;
      if (!incomingState) persist();
      syncBuilderURL();
      return true;
    } catch (error) {
      if (version === compositionVersion)
        toast(error.message + " Состав оставлен без изменений.");
      return false;
    } finally {
      if (Backend.enabled) lockComposition(false);
    }
  }
  function check(parts) {
    return Backend.enabled ? Backend.check(parts) : Core.check(parts);
  }
  function counters() {
    document.querySelectorAll("[data-count]").forEach((node) => {
      node.textContent = S[node.dataset.count].length;
    });
  }
  function toast(message) {
    $("#toast").textContent = message;
    clearTimeout(timer);
    timer = setTimeout(() => {
      $("#toast").textContent = "";
    }, 4200);
  }
  function itemURL(p) {
    return Catalog.itemURL(p);
  }
  function buildURL(index) {
    return "build.html?id=b" + index;
  }
  function configURL(parts = S.parts) {
    const url = new URL("builder.html", location.href);
    if (savedBuild && Core.partsString(parts) === savedPartsKey)
      url.searchParams.set("saved", savedBuild.id);
    else url.searchParams.set("parts", Core.partsString(parts));
    return url;
  }
  function savedURL(id) {
    const url = new URL("builder.html", location.href);
    url.searchParams.set("saved", id);
    return url;
  }
  function syncBuilderURL() {
    if (page === "builder") history.replaceState(null, "", configURL());
  }
  function budget(parts) {
    return Prices.budget(Core.validateParts(parts), P);
  }
  function priceLabel(info) {
    return info.kind === "snapshot"
      ? "Зафиксированная цена · " + date(info.offer.checkedAt)
      : "Расчётная цена";
  }
  function priceHTML(p) {
    const info = Prices.price(p);
    return (
      '<div class="price">' +
      money(info.value) +
      '</div><div class="price-kind">' +
      esc(priceLabel(info)) +
      "</div>"
    );
  }
  function crumb(items = []) {
    return (
      '<nav class="breadcrumb" aria-label="Хлебные крошки"><a href="index.html">Главная</a>' +
      items
        .map(
          ([text, href]) =>
            '<span aria-hidden="true">/</span>' +
            (href
              ? '<a href="' + esc(href) + '">' + esc(text) + "</a>"
              : '<span aria-current="page">' + esc(text) + "</span>"),
        )
        .join("") +
      "</nav>"
    );
  }
  function heading(title, description = "", crumbs = [[title]]) {
    return (
      crumb(crumbs) +
      '<div class="page-heading"><h1>' +
      esc(title) +
      "</h1>" +
      (description ? "<p>" + esc(description) + "</p>" : "") +
      "</div>"
    );
  }
  function empty(
    title,
    text,
    href = "catalog.html",
    action = "Перейти в каталог",
  ) {
    return (
      '<div class="empty"><h2>' +
      esc(title) +
      "</h2><p>" +
      esc(text) +
      '</p><a class="btn" href="' +
      esc(href) +
      '">' +
      esc(action) +
      "</a></div>"
    );
  }
  function productRow(p) {
    const info = Prices.price(p);
    return `<article class="product-row" data-product="${p.id}">
      ${Media.render(p)}
      <div class="product-info">
        <div class="product-category">${esc(names[p.c])}</div>
        <h2><a href="${itemURL(p)}">${esc(p.name)}</a></h2>
        <ul class="brief-list">${Core.brief(p)
          .map((text) => "<li>" + esc(text) + "</li>")
          .join("")}</ul>
      </div>
      <div class="product-price">
        ${priceHTML(p)}
        ${info.count ? '<a class="shop-count" href="' + itemURL(p) + '#offers">Предложения магазинов: ' + info.count + "</a>" : ""}
        <div class="product-utilities">
          <button type="button" class="icon-button" data-action="favorite" data-index="${p.i}" aria-label="В избранное: ${esc(p.name)}" aria-pressed="${S.fav.includes(p.i)}">${S.fav.includes(p.i) ? "♥" : "♡"}</button>
          <button type="button" class="icon-button" data-action="compare" data-index="${p.i}" aria-label="Сравнить: ${esc(p.name)}" aria-pressed="${S.cmp.includes(p.i)}">${S.cmp.includes(p.i) ? "✓" : "⇄"}</button>
        </div>
        ${addControl(p)}
      </div>
    </article>`;
  }
  function addControl(p, label = "В сборку") {
    const result = Compatibility.assess(p, S.parts);
    const note = !result.allowed ? result.conflicts.join(" ") : "";
    return `<button type="button" class="btn" data-action="add" data-index="${p.i}" ${result.allowed ? "" : "disabled"}>${S.parts[p.c] === p.i ? "В текущей сборке" : esc(label)}</button>${note ? '<p class="compatibility-hint ' + (result.allowed ? "" : "conflict") + '">' + esc(note) + "</p>" : ""}`;
  }
  function currentProducts(list = P) {
    return list.map((p) => ({ ...p, displayPrice: Prices.price(p).value }));
  }
  function categoryName() {
    const value = params.get("cat");
    return cats.includes(value) ? value : "";
  }
  function catalogue(favorites = false) {
    const category = categoryName();
    const list = favorites ? P.filter((p) => S.fav.includes(p.i)) : P;
    const action = favorites ? "favorites.html" : "catalog.html";
    const categoryHref = (c) => {
      const next = new URLSearchParams();
      if (c) next.set("cat", c);
      if (params.get("compat") === "all") next.set("compat", "all");
      return action + (next.size ? "?" + next : "");
    };
    const title = favorites
      ? "Избранные комплектующие"
      : category
        ? names[category]
        : "Каталог комплектующих";
    app.innerHTML =
      heading(
        title,
        favorites
          ? "Сохранённые модели доступны в этом браузере."
          : "Сравните характеристики и добавьте подходящие компоненты в сборку.",
        category
          ? [["Каталог", "catalog.html"], [names[category]]]
          : [[favorites ? "Избранное" : "Каталог"]],
      ) +
      `<div class="catalog-layout">
        <aside class="catalog-sidebar" aria-label="Категории и фильтры">
          <nav class="category-menu" aria-label="Категории комплектующих">
            <a href="${categoryHref("")}" class="${!category ? "active" : ""}">Все категории <small>${list.length}</small></a>
            ${cats.map((c) => '<a href="' + categoryHref(c) + '" class="' + (category === c ? "active" : "") + '">' + esc(names[c]) + "<small>" + list.filter((p) => p.c === c).length + "</small></a>").join("")}
          </nav>
          <label class="category-mobile" for="category-select">Категория
            <select id="category-select"><option value="">Все комплектующие</option>${cats.map((c) => '<option value="' + c + '"' + (c === category ? " selected" : "") + ">" + esc(names[c]) + "</option>").join("")}</select>
          </label>
          <details id="filters-panel" class="filter-disclosure" ${matchMedia("(min-width:901px)").matches ? "open" : ""}>
            <summary>Фильтры</summary>
            ${Catalog.filterPanel({ category, params, products: currentProducts(list), action })}
          </details>
        </aside>
        <section aria-label="Список комплектующих">
          <div class="compatibility-filter"><label for="compatible-only"><input id="compatible-only" type="checkbox" ${params.get("compat") === "all" ? "" : "checked"}>Подходят к моей сборке</label><a href="builder.html">Текущая сборка: <span id="catalog-selected-count">${Object.keys(S.parts).length}</span> из 8 →</a><p id="compatibility-note" class="caption" aria-live="polite"></p></div>
          <div class="catalog-toolbar">
            <p id="found" aria-live="polite"></p>
            <div class="row">
              <label class="sort-field" for="sort">Порядок
                <select id="sort" name="sort" form="catalog-filters">
                  <option value="name">По названию</option><option value="asc">Сначала дешевле</option><option value="desc">Сначала дороже</option>
                </select>
              </label>
              <div class="view-switch" role="group" aria-label="Вид каталога">
                <button type="button" data-action="view" data-view="list">Список</button>
                <button type="button" data-action="view" data-view="grid">Плитка</button>
              </div>
            </div>
          </div>
          <div id="results" class="catalog-results"></div>
          <div class="more-row"><button type="button" id="more" class="btn secondary" data-action="more">Показать ещё</button></div>
          <p class="caption">Зафиксированные цены имеют дату. Для остальных моделей показаны расчётные оценки. <a href="about.html#prices">Подробнее о ценах</a></p>
        </section>
      </div>`;
    $("#sort").value = ["asc", "desc"].includes(params.get("sort"))
      ? params.get("sort")
      : "name";
    return drawProducts();
  }
  async function drawProducts() {
    const target = $("#results");
    if (!target) return;
    const requestVersion = ++catalogueRequest;
    if (!validatePriceRange()) {
      $("#found").textContent = "Проверьте диапазон цены";
      target.innerHTML = empty("Исправьте границы цены", "Цена «От» не должна превышать цену «До».");
      $("#more").hidden = true;
      target.removeAttribute("aria-busy");
      return;
    }
    const list =
      page === "favorites" ? P.filter((p) => S.fav.includes(p.i)) : P;
    const enabled = params.get("compat") !== "all";
    let rows, hidden;
    target.setAttribute("aria-busy", "true");
    try {
      if (Backend.enabled) {
        const result = await Backend.catalogue(
          params,
          S.parts,
          page === "favorites" ? S.fav : undefined,
        );
        rows = result.ids.map((id) => P[Number(id.slice(1))]);
        hidden = result.hidden;
      } else {
        const filtered = Catalog.filter(
          currentProducts(list),
          params,
          categoryName(),
        );
        rows = enabled ? Compatibility.filter(filtered, S.parts) : filtered;
        hidden = filtered.length - rows.length;
      }
    } catch (error) {
      if (requestVersion === catalogueRequest && target.isConnected) {
        $("#found").textContent = "Каталог недоступен";
        target.innerHTML =
          '<p class="warn">' +
          esc(error.message) +
          '</p><button type="button" class="btn secondary" data-action="retry-catalog">Повторить загрузку</button>';
        $("#more").hidden = true;
      }
      return;
    } finally {
      if (requestVersion === catalogueRequest)
        target.removeAttribute("aria-busy");
    }
    if (requestVersion !== catalogueRequest || !target.isConnected) return;
    $("#catalog-selected-count").textContent = Object.keys(S.parts).length;
    $("#compatible-only").checked = enabled;
    document.querySelectorAll(".category-menu a").forEach((link) => {
      const url = new URL(link.href);
      if (enabled) url.searchParams.delete("compat");
      else url.searchParams.set("compat", "all");
      link.href = url.href;
    });
    $("#compatibility-note").textContent = Object.keys(S.parts).length
      ? enabled
        ? "Скрыто несовместимых моделей: " + hidden + "."
        : "Показаны все модели. Несовместимые детали нельзя добавить к текущему составу."
      : "Выберите первую деталь — остальные списки подстроятся под неё.";
    $("#found").textContent = "Найдено моделей: " + rows.length;
    $("#results").className =
      "catalog-results" +
      (params.get("view") === "grid" ? " catalog-grid" : "");
    $("#results").innerHTML = rows.length
      ? rows.slice(0, visible).map(productRow).join("")
      : empty(
          "Моделей не найдено",
          page === "favorites" && !list.length
            ? "Добавьте интересующие модели кнопкой с сердцем в каталоге."
            : "Попробуйте изменить параметры поиска или сбросить фильтры.",
        );
    $("#more").hidden = rows.length <= visible;
    document.querySelectorAll('[data-action="view"]').forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String((params.get("view") || "list") === button.dataset.view),
      );
    });
  }
  function validatePriceRange() {
    const form = $("#catalog-filters");
    if (!form) return true;
    const minimum = $("#min"), maximum = $("#max");
    const reversed = minimum.value !== "" && maximum.value !== "" &&
      Number(minimum.value) > Number(maximum.value);
    const message = reversed ? "Цена «От» не должна превышать цену «До»." : "";
    maximum.setCustomValidity(message);
    $("#price-error").textContent = message;
    return form.checkValidity();
  }
  function readFilters(close = false) {
    const form = $("#catalog-filters");
    if (!form || !validatePriceRange()) return;
    const next = new URLSearchParams();
    for (const [key, value] of new FormData(form))
      if (String(value).trim()) next.set(key, String(value).trim());
    if (params.get("view") === "grid") next.set("view", "grid");
    if (params.get("compat") === "all") next.set("compat", "all");
    params = next;
    visible = 12;
    history.replaceState(
      null,
      "",
      location.pathname + (params.size ? "?" + params : ""),
    );
    drawProducts();
    if (close && !matchMedia("(min-width:901px)").matches)
      $("#filters-panel").open = false;
  }
  function buildTitle(build) {
    const parts = Core.buildParts(build),
      cpu = P[parts.cpu];
    return (
      build[0] +
      (cpu
        ? " — " + cpu.name.replace(/^AMD |^Intel /, "").replace(/ OEM$/, "")
        : "")
    );
  }
  function buildSpecs(parts) {
    return [
      ["CPU", P[parts.cpu]?.name],
      ["GPU", P[parts.gpu]?.name || "Встроенная графика CPU"],
      [
        "RAM",
        P[parts.ram]
          ? Core.spec(P[parts.ram], 1) + " " + Core.spec(P[parts.ram], 0)
          : "Не выбрана",
      ],
      [
        "SSD",
        P[parts.storage]
          ? Core.spec(P[parts.storage], 1) +
            " · " +
            Core.spec(P[parts.storage], 0)
          : "Не выбран",
      ],
    ];
  }
  function buildCard(build, index = B.indexOf(build)) {
    const parts = Core.buildParts(build),
      cost = budget(parts);
    return `<article class="build-card">
      <div class="build-card-top">${P[parts.case] ? Media.render(P[parts.case]) : ""}<div><span class="badge">${esc(build[1])}</span><h2><a href="${buildURL(index)}">${esc(buildTitle(build))}</a></h2></div></div>
      <dl class="build-specs">${buildSpecs(parts)
        .map(
          ([key, value]) =>
            "<div><dt>" + key + "</dt><dd>" + esc(value) + "</dd></div>",
        )
        .join("")}</dl>
      <div class="build-card-bottom"><div class="price">${money(cost.value)}</div><div class="price-kind">Оценка бюджета компонентов</div><a class="btn secondary small" href="${buildURL(index)}">Состав сборки</a></div>
    </article>`;
  }
  function home() {
    const storeModels = new Set(Prices.offers.map((x) => x.productId)).size;
    app.innerHTML = `<section class="home-intro"><div><h1>Комплектующие и сборки ПК</h1><p>Характеристики, сравнение моделей и расчёт бюджета компьютера. Подберите компоненты под свою задачу.</p></div><p class="home-facts">${P.length} моделей · ${B.length} конфигурации · Казахстан</p></section>
      <section aria-labelledby="categories-heading"><div class="section-heading"><h2 id="categories-heading">Категории комплектующих</h2></div><div class="category-grid">${cats.map((c) => '<a class="category-tile" href="' + Catalog.categoryURL(c) + '"><span class="category-symbol" aria-hidden="true">' + symbols[c] + "</span><div><strong>" + esc(names[c]) + "</strong><small>" + P.filter((p) => p.c === c).length + " моделей</small></div></a>").join("")}</div></section>
      <div class="tools-strip"><a class="tool-link" href="builder.html"><strong>Собрать компьютер →</strong><span>Выбор компонентов и проверка основных ограничений.</span></a><a class="tool-link" href="builds.html"><strong>Выбрать готовую сборку →</strong><span>Состав, стоимость и возможность заменить детали.</span></a><a class="tool-link" href="compare.html"><strong>Сравнить модели →</strong><span>Характеристики до четырёх комплектующих рядом.</span></a></div>
      <section class="section"><div class="section-heading"><h2>Готовые конфигурации</h2><a href="builds.html">Все ${B.length} сборки →</a></div><div class="build-grid">${[B[0], B[3], B[1]].map((b) => buildCard(b)).join("")}</div></section>
      <section class="section"><div class="section-heading"><h2>Комплектующие в каталоге</h2><a href="catalog.html">Открыть каталог →</a></div><div class="catalog-results">${[P[2], P[16], P[28], P[30]].map(productRow).join("")}</div></section>
      <section class="section info-note">${storeModels ? "Для " + storeModels + " моделей есть снимки предложений магазинов с датой фиксации. " : ""}Остальные цены — расчётные оценки. Итог сборки помогает планировать бюджет и не является предложением о продаже. <a href="about.html#prices">Как устроены цены</a></section>`;
  }
  function builds() {
    app.innerHTML =
      heading(
        "Готовые сборки ПК",
        "Выберите состав под свою задачу и при необходимости замените компоненты.",
      ) +
      `<form id="build-filters" class="build-filters"><label for="task">Назначение<select id="task" name="task"><option value="">Все задачи</option>${[...new Set(B.map((b) => b[1]))].map((task) => "<option>" + esc(task) + "</option>").join("")}</select></label><label for="budget">Бюджет до, ₸<input id="budget" name="budget" type="number" min="0" max="9007199254740991" step="1" inputmode="numeric" placeholder="Без ограничения"></label><button type="submit" class="btn secondary">Подобрать</button></form>
      <p id="build-count" class="count-note" aria-live="polite"></p><div id="build-results" class="build-grid"></div>
      <p class="section info-note">Бюджет складывается из зафиксированных цен и расчётных оценок. Не включены периферия, операционная система, доставка и работа сборщика. Состав можно проверить и изменить в конфигураторе.</p>`;
    $("#task").value = params.get("task") || "";
    $("#budget").value = params.get("budget") || "";
    return drawBuilds();
  }
  async function drawBuilds() {
    const requestVersion = ++buildsRequest;
    const field = $("#budget");
    field.setCustomValidity("");
    const task = $("#task").value,
      raw = field.value.trim(),
      max = raw === "" ? null : Number(raw);
    if (!field.checkValidity() || (max !== null && (!Number.isSafeInteger(max) || max < 0))) {
      const message = "Введите корректный неотрицательный бюджет в целых тенге.";
      field.setCustomValidity(message);
      $("#build-count").textContent = "Проверьте бюджет";
      $("#build-results").innerHTML = '<p class="warn" role="alert">' + esc(message) + "</p>";
      return;
    }
    let rows;
    try {
      rows = Backend.enabled
        ? (await Backend.builds(task, max)).map((i) => B[i])
        : B.filter(
            (b) =>
              (!task || b[1] === task) &&
              (max === null || budget(Core.buildParts(b)).value <= max),
          );
    } catch (error) {
      if (requestVersion === buildsRequest) {
        $("#build-count").textContent = "Список сборок недоступен";
        $("#build-results").innerHTML =
          '<p class="warn">' +
          esc(error.message) +
          '</p><button class="btn secondary" type="button" data-action="retry-builds">Повторить загрузку</button>';
      }
      return;
    }
    if (requestVersion !== buildsRequest) return;
    $("#build-count").textContent = "Подходящих конфигураций: " + rows.length;
    $("#build-results").innerHTML = rows.length
      ? rows.map((b) => buildCard(b)).join("")
      : empty(
          "Сборок с такими параметрами нет",
          "Измените назначение или увеличьте бюджет.",
          "builder.html",
          "Собрать свой компьютер",
        );
  }
  function statusHTML(result) {
    const labels = {
      ok: "Базовые ограничения соблюдены",
      conflict: "Есть конфликт компонентов",
      incomplete: "Состав ещё не завершён",
      unknown: "Недостаточно данных для полной проверки",
    };
    return (
      '<div class="status-label ' +
      result.status +
      '">' +
      esc(labels[result.status]) +
      "</div>" +
      (result.bad.length
        ? '<ul class="bad">' +
          result.bad.map((x) => "<li>" + esc(x) + "</li>").join("") +
          "</ul>"
        : "") +
      (result.missing.length
        ? '<p class="caption" style="margin-top:12px">Ещё нужны: ' +
          result.missing.map((c) => names[c].toLowerCase()).join(", ") +
          ".</p>"
        : "") +
      (result.unknown.length
        ? '<ul class="muted">' +
          result.unknown.map((x) => "<li>" + esc(x) + "</li>").join("") +
          "</ul>"
        : "") +
      '<p class="caption" style="margin-top:12px">' +
      (result.need === null
        ? "Минимум мощности БП не рассчитан: недостаточно данных о питании."
        : "Расчётный минимум БП: " +
          money(result.need).replace(" ₸", " Вт") +
          ".") +
      "</p>"
    );
  }
  function budgetNote(cost) {
    if (cost.snapshots && cost.estimates)
      return "В сумме есть зафиксированные цены магазинов и расчётные оценки. Тип цены указан у каждого компонента.";
    if (cost.snapshots)
      return "Сумма по зафиксированным предложениям магазинов. Наличие и действующую цену уточняйте у продавца.";
    return "Сумма по учебным расчётным ценам. Это оценка бюджета, а не предложение магазина.";
  }
  function includedComponent(category, parts) {
    const cpu = P[parts.cpu];
    if (category === "gpu" && cpu?.v[3] === "1")
      return "Встроенная графика процессора";
    if (category === "cooling" && cpu?.v[4] === "1")
      return "Кулер в комплекте процессора";
    return "Не выбран отдельный компонент";
  }
  function composition(parts) {
    return (
      '<div class="table-wrap"><table class="composition"><thead><tr><th scope="col">Компонент</th><th scope="col">Модель</th><th scope="col">Цена для расчёта</th></tr></thead><tbody>' +
      cats
        .map((c) => {
          const p = P[parts[c]];
          return (
            '<tr><th scope="row">' +
            esc(names[c]) +
            "</th><td>" +
            (p
              ? '<a href="' + itemURL(p) + '">' + esc(p.name) + "</a>"
              : esc(includedComponent(c, parts))) +
            "</td><td>" +
            (p
              ? priceHTML(p)
              : '<span class="caption">' +
                (includedComponent(c, parts).startsWith("Не выбран")
                  ? "—"
                  : "В составе CPU") +
                "</span>") +
            "</td></tr>"
          );
        })
        .join("") +
      "</tbody></table></div>"
    );
  }
  function buildDetail() {
    const match = /^b(\d+)$/.exec(params.get("id") || "");
    const index = match ? Number(match[1]) : -1,
      b = B[index];
    if (!b) {
      app.innerHTML =
        heading("Сборка не найдена") +
        empty(
          "Такой конфигурации нет",
          "Выберите сборку из каталога.",
          "builds.html",
          "Готовые сборки",
        );
      return;
    }
    const parts = Core.buildParts(b),
      cost = budget(parts);
    document.title = b[0] + " — СОБРАНО";
    app.innerHTML =
      heading(buildTitle(b), b[2], [
        ["Готовые сборки", "builds.html"],
        [b[0]],
      ]) +
      '<div class="build-detail-layout"><section aria-label="Состав конфигурации">' +
      composition(parts) +
      '<p class="info-note section">' +
      esc(budgetNote(cost)) +
      ' Доставка, ОС, периферия и работа сборщика не включены.</p></section><aside class="build-overview">' +
      (P[parts.case] ? Media.render(P[parts.case]) : "") +
      '<div><div class="caption">Оценка бюджета</div><div class="price">' +
      money(cost.value) +
      '</div><p class="caption">Фото относится к указанному корпусу. Остальные детали могут отличаться по внешнему виду.</p></div><div class="stack"><button class="btn" data-action="load-build" data-index="' +
      index +
      '">Изменить в конфигураторе</button><a class="btn secondary" href="builds.html">Другие сборки</a></div></aside></div><section class="section panel"><h2>Проверка состава</h2>' +
      statusHTML(check(parts)) +
      '<p class="caption">Перед покупкой проверьте поддержку CPU в BIOS, QVL памяти, разъёмы питания, крепления и расположение деталей.</p></section>';
  }
  function offersHTML(p) {
    const offers = Prices.offersFor(p).sort((a, b) => a.price - b.price);
    if (!offers.length)
      return '<p class="info-note">Для этой модели пока нет проверяемого снимка предложения магазина. Показана учебная расчётная цена. Данные о продаже и наличии не добавлены.</p>';
    const availability = {
      "in-stock": "Был в наличии на снимке",
      "out-of-stock": "Не было в наличии",
      unknown: "Наличие не подтверждено",
    };
    return (
      '<p class="caption">Цены зафиксированы со страниц магазинов, в том числе из доступных поисковых снимков. Они не обновляются автоматически. Проверьте действующую цену, город и комплектацию перед покупкой.</p><div class="table-wrap"><table class="offer-table"><thead><tr><th scope="col">Магазин</th><th scope="col">Цена на снимке</th><th scope="col">Дата фиксации</th><th scope="col">Условия и источник</th></tr></thead><tbody>' +
      offers
        .map(
          (o) =>
            '<tr><th scope="row">' +
            esc(o.store) +
            '</th><td><span class="price">' +
            money(o.price) +
            "</span></td><td>" +
            date(o.checkedAt) +
            (Date.now() - Date.parse(o.checkedAt) > 30 * 86400000
              ? '<br><span class="badge">Архивный снимок</span>'
              : "") +
            '</td><td><div class="offer-note"><p>' +
            esc(availability[o.availability] || availability.unknown) +
            "</p>" +
            (o.note ? "<p>" + esc(o.note) + "</p>" : "") +
            '<a href="' +
            esc(o.url) +
            '" target="_blank" rel="noopener noreferrer">Страница товара ↗</a></div></td></tr>',
        )
        .join("") +
      "</tbody></table></div>"
    );
  }
  function productDetail() {
    const match = /^p(\d+)$/.exec(params.get("id") || "");
    const p = match ? P[Number(match[1])] : null;
    if (!p) {
      app.innerHTML =
        heading("Модель не найдена") +
        empty("Такой модели нет", "Откройте каталог и выберите комплектующее.");
      return;
    }
    document.title = p.name + " — характеристики и цены — СОБРАНО";
    document.querySelector('meta[name="description"]').content =
      p.name +
      ": " +
      Core.brief(p).join(". ") +
      ". Характеристики и оценка бюджета.";
    app.innerHTML =
      crumb([
        ["Каталог", "catalog.html"],
        [names[p.c], Catalog.categoryURL(p.c)],
        [p.name],
      ]) +
      `<div class="product-detail">${Media.render(p, { large: true })}<section><span class="eyebrow">${esc(names[p.c])}</span><h1>${esc(p.name)}</h1><ul class="brief-list">${Core.brief(
        p,
      )
        .map((x) => "<li>" + esc(x) + "</li>")
        .join(
          "",
        )}</ul><div class="detail-price">${priceHTML(p)}<div class="row">${addControl(p, "Добавить в сборку")}<button class="btn secondary" data-action="favorite" data-index="${p.i}" aria-pressed="${S.fav.includes(p.i)}">В избранное</button><button class="btn secondary" data-action="compare" data-index="${p.i}" aria-pressed="${S.cmp.includes(p.i)}">Сравнить</button></div></div><p class="detail-meta">Модель в каталоге: ${p.id}. <a href="builder.html">Открыть текущую сборку →</a></p></section></div>
      <section class="section" id="offers"><h2>Цены магазинов</h2>${offersHTML(p)}</section>
      <section class="section product-extra"><h2>Характеристики</h2><div class="table-wrap"><table class="spec-table"><tbody>${Core.fields[p.c].map((label, k) => '<tr><th scope="row">' + esc(label) + "</th><td>" + esc(Core.spec(p, k)) + "</td></tr>").join("")}</tbody></table></div><p class="caption section">Указаны основные характеристики. Пустые значения означают отсутствие подтверждённых данных. OEM/BOX, версия платы и региональная комплектация требуют проверки по артикулу.</p><a href="about.html#data">О характеристиках и ограничениях каталога</a></section>`;
  }
  function slotInfo(c) {
    const p = P[S.parts[c]];
    const result = p ? Compatibility.assess(p, S.parts) : null;
    const note =
      result && !result.allowed
        ? '<span class="compatibility-hint conflict">' +
          esc(result.conflicts.join(" ")) +
          "</span>"
        : "";
    return p
      ? '<a href="' +
          itemURL(p) +
          '">Характеристики модели →</a> ' +
          esc(Core.brief(p).slice(0, 2).join(" · ")) +
          "<br>" +
          money(Prices.price(p).value) +
          " · " +
          esc(priceLabel(Prices.price(p))) +
          note
      : c === "gpu"
        ? "Можно оставить пустым, если у выбранного CPU есть встроенная графика."
        : c === "cooling"
          ? "Можно оставить пустым, если кулер входит в комплект выбранного CPU."
          : "Выберите модель из списка.";
  }
  function slotOptions(c) {
    const ending =
      c === "motherboard" || c === "ram" ? "а" : c === "cooling" ? "о" : "";
    return (
      '<option value="">Не выбран' +
      ending +
      "</option>" +
      P.filter((p) => p.c === c)
        .map((p) => {
          const result = Compatibility.assess(p, S.parts);
          if (!result.allowed && S.parts[c] !== p.i) return "";
          const suffix = !result.allowed ? " · Конфликт: замените деталь" : "";
          return (
            '<option value="' +
            p.i +
            '"' +
            (S.parts[c] === p.i ? " selected" : "") +
            ">" +
            esc(p.name) +
            " — " +
            money(Prices.price(p).value) +
            esc(suffix) +
            "</option>"
          );
        })
        .join("")
    );
  }
  function refreshBuilderOptions() {
    cats.forEach((c) => {
      const select = $("#slot-" + c);
      if (!select) return;
      // Узлы select сохраняются: клавиатурный фокус остаётся на выбранном поле.
      select.innerHTML = slotOptions(c);
      updateSlot(c);
    });
    updateSummary();
  }
  function builder() {
    app.innerHTML =
      heading(
        "Конфигуратор ПК",
        Backend.savedAvailable
          ? "Выберите комплектующие и сохраните состав на сервере, чтобы открыть его по ссылке на другом устройстве."
          : "Выберите комплектующие. Состав сохраняется в браузере, а ссылкой можно поделиться.",
      ) +
      (incomingError
        ? '<p class="warn">Ссылка содержит некорректный состав. Ваша сохранённая сборка оставлена без изменений.</p>'
        : "") +
      (incomingSavedError ? '<p class="warn" role="alert">' + esc(incomingSavedError) + '</p>' : "") +
      (Backend.savedAvailable
        ? '<section class="server-build-tools" aria-label="Сохранение сборки"><div class="row"><button class="btn secondary" type="button" data-action="server-save">Сохранить на сервере</button><button class="btn secondary" type="button" data-action="server-my-builds">Мои сборки</button></div><p id="saved-state" class="caption" aria-live="polite"></p></section>'
        : "") +
      `<div class="builder-toolbar row"><a class="btn secondary small" href="builds.html">Начать с готовой сборки</a><span class="caption">Выбрано компонентов: <span id="selected-count">${Object.keys(S.parts).length}</span> из 8</span></div><div class="builder-layout"><div><div class="builder-list">${cats
        .map(
          (c) =>
            '<section class="builder-slot"><div class="slot-label"><label for="slot-' +
            c +
            '">' +
            esc(names[c]) +
            '</label><a href="' +
            Catalog.categoryURL(c) +
            '">Посмотреть в каталоге</a></div><div class="slot-controls"><select id="slot-' +
            c +
            '" data-slot="' +
            c +
            '" aria-describedby="info-' +
            c +
            '">' +
            slotOptions(c) +
            '</select><button type="button" class="slot-remove" data-action="remove-part" data-category="' +
            c +
            '" aria-label="Убрать: ' +
            esc(names[c]) +
            '"' +
            (S.parts[c] === undefined ? " disabled" : "") +
            '>×</button></div><p class="slot-info" id="info-' +
            c +
            '">' +
            slotInfo(c) +
            "</p></section>",
        )
        .join(
          "",
        )}</div><div class="builder-actions"><button type="button" class="btn secondary" data-action="export">Скачать состав TXT</button><button type="button" class="btn secondary danger" data-action="clear-parts">Очистить состав</button></div></div><aside class="summary" aria-label="Бюджет и проверка сборки" id="builder-summary"></aside></div>`;
    refreshBuilderOptions();
  }
  function updateSummary() {
    const node = $("#builder-summary");
    if (!node) return;
    const cost = budget(S.parts),
      result = check(S.parts);
    node.innerHTML =
      '<h2>Оценка бюджета</h2><div class="price">' +
      money(cost.value) +
      '</div><p class="caption">' +
      esc(budgetNote(cost)) +
      "</p><h3>Проверка компонентов</h3>" +
      statusHTML(result) +
      '<p class="caption section">Проверка ограничена известными параметрами. BIOS, QVL, разъёмы, крепления и достаточность охлаждения проверьте отдельно.</p><div class="stack"><button type="button" class="btn" data-action="share">Ссылка на сборку</button></div>';
    if ($("#selected-count"))
      $("#selected-count").textContent = Object.keys(S.parts).length;
    const savedState = $("#saved-state");
    if (savedState) {
      const dirty = savedBuild && Core.partsString(S.parts) !== savedPartsKey;
      savedState.textContent = savedBuild
        ? (savedBuild.canEdit ? "Ваша сборка «" : "Открыта сборка «") + savedBuild.name + "». " +
          (dirty ? "Текущие изменения ещё не сохранены в базе. " : "Этот состав сохранён на сервере. ") +
          (savedBuild.canEdit ? "Можно обновить запись или сохранить новую копию." : "Вы можете сохранить собственную копию.")
        : "Пока состав хранится в этом браузере. Нажмите «Сохранить на сервере», чтобы создать запись и постоянную ссылку.";
    }
  }
  function updateSlot(c) {
    const select = $("#slot-" + c);
    if (select) select.value = S.parts[c] ?? "";
    const info = $("#info-" + c);
    if (info) info.innerHTML = slotInfo(c);
    const remove = document.querySelector(
      '[data-action="remove-part"][data-category="' + c + '"]',
    );
    if (remove)
      remove.disabled = pendingChanges > 0 || S.parts[c] === undefined;
  }
  function compare() {
    const rows = S.cmp.map((i) => P[i]);
    app.innerHTML =
      heading(
        "Сравнение комплектующих",
        "До четырёх моделей одной категории. Отличающиеся значения выделены.",
      ) +
      (!rows.length
        ? empty(
            "В сравнении пока нет моделей",
            "Добавьте компоненты кнопкой «Сравнить» или ⇄ в каталоге.",
          )
        : '<div class="compare-toolbar"><label><input id="only-differences" type="checkbox">Только отличия</label><button class="btn secondary small" data-action="clear-compare">Очистить сравнение</button></div><div class="table-wrap"><table class="compare-table"><thead><tr><th scope="col">Характеристика</th>' +
          rows
            .map(
              (p) =>
                '<th scope="col"><a href="' +
                itemURL(p) +
                '">' +
                esc(p.name) +
                "</a>" +
                priceHTML(p) +
                '<button class="btn secondary small" data-action="compare" data-index="' +
                p.i +
                '">Убрать</button></th>',
            )
            .join("") +
          "</tr></thead><tbody>" +
          Core.fields[rows[0].c]
            .map((label, k) => {
              const different =
                new Set(rows.map((p) => Core.spec(p, k))).size > 1;
              return (
                '<tr class="' +
                (different ? "diff" : "same") +
                '"><th scope="row">' +
                esc(label) +
                "</th>" +
                rows
                  .map((p) => "<td>" + esc(Core.spec(p, k)) + "</td>")
                  .join("") +
                "</tr>"
              );
            })
            .join("") +
          "</tbody></table></div>");
  }
  function about() {
    const offers = Prices.offers;
    app.innerHTML =
      heading(
        "О проекте и данных",
        "СОБРАНО — независимый информационный каталог. Проект не продаёт товары и не принимает оплату.",
      ) +
      `<article class="prose"><div class="data-numbers">${P.length} моделей · ${B.length} готовые конфигурации · 8 категорий</div>
      <h2 id="prices">Как указаны цены</h2><p>В каталоге используются два вида цен. <strong>Зафиксированная цена</strong> — сумма из доступного снимка страницы конкретного магазина. Рядом указана дата фиксации, а в карточке модели есть источник и условия. Поисковый снимок страницы может отставать от магазина; наличие, город и действующую цену нужно уточнить у продавца.</p><p><strong>Расчётная цена</strong> — учебная оценка, записанная в наборе данных. Она не является предложением магазина. Новые магазинные цены не загружаются автоматически. Снимки старше 30 дней остаются в истории товара, но перестают участвовать в расчёте бюджета.</p><p>Оценка сборки — сумма цен её компонентов: снимков не старше 30 дней и расчётных оценок для остальных деталей. Цена без подтверждённого наличия остаётся снимком, а не обещанием продажи. В сумму не входят доставка, периферия, операционная система и услуги сборщика.</p>
      <h2>Зафиксированные предложения</h2><p>Сейчас сохранено ${offers.length} предложений для ${new Set(offers.map((o) => o.productId)).size} моделей. СОБРАНО не заявляет о партнёрстве с указанными магазинами.</p><ul>${offers.map((o) => '<li><a href="' + esc(o.url) + '" target="_blank" rel="noopener noreferrer">' + esc(o.store) + " — " + esc(P[Number(o.productId.slice(1))]?.name) + "</a>: " + money(o.price) + ", фиксация " + date(o.checkedAt) + ".</li>").join("")}</ul>
      <h2 id="data">Характеристики и совместимость</h2><p>Названия моделей реальны. Характеристики сокращены до основных параметров, часть значений пока не заполнена. Отсутствующее значение обозначается «Не указано». Для покупки проверяйте точный артикул и документацию производителя: разные исполнения одной модели могут отличаться.</p><p>Каталог и конфигуратор скрывают варианты, для которых обнаружен конфликт с выбранными деталями: сокеты, тип и объём памяти, число модулей, основные размеры и оценка мощности. Выбор работает в любом порядке. В каталоге можно отключить фильтр «Подходят к моей сборке», чтобы изучить все модели. Если части характеристик нет, вариант остаётся доступным. Недостающие данные указаны в общем результате проверки сборки, без повторяющихся пометок в списках и под деталями. В сохранённом составе конфликтная деталь остаётся видимой для замены. Проверка не заменяет сверку BIOS, QVL, разъёмов питания, креплений, достаточности охлаждения и геометрии.</p>
      <h2>Сохранение и ссылки</h2><p>Избранное, сравнение и текущий черновик сохраняются в браузере. При очистке данных браузера они удалятся. ${Backend.savedAvailable ? "Кнопка «Сохранить на сервере» создаёт запись в SQL-базе. Ссылку на неё можно открыть с другого устройства, когда доступен сервер." + (Backend.accountsAvailable ? " После входа записи принадлежат аккаунту: их можно изменять и удалять с любого браузера, где выполнен вход. Без входа доступ к редактированию связан с гостевой cookie этого браузера; при входе гостевые записи переходят в аккаунт." : " Доступ автора к редактированию связан с гостевой cookie этого браузера.") + " Общая ссылка открывает название и состав для чтения. Не указывайте личные данные в названии." : "В этом режиме сохранения в серверную базу нет; ссылка передаёт состав в адресе страницы."} TXT-файл позволяет сохранить состав отдельно.</p>
      <h2>Серверные режимы</h2><p>${window.SOBRANO_RUNTIME.backend === "server" ? "На этой версии поиск, подбор, совместимость и бюджет обрабатывает онлайн-сервер на JavaScript. Сохранённые составы хранятся в базе, а интерфейс получает результаты HTTP-запросами." : window.SOBRANO_RUNTIME.backend === "python" ? "В этом локальном режиме HTTP-запросы обрабатывает Python-сервер. Он читает каталог из JSON и рассчитывает результаты." : "Эта статическая версия загружает JSON, а расчёты выполняет JavaScript в браузере. GitHub Pages не запускает серверный код."} Оконная программа Python является отдельным приложением и не запускается внутри сайта.</p>
      <h2 id="photos">Фотографии и авторство</h2><p>Для точных моделей используются фотографии из указанных источников. Изображения линейки или исполнения другого производителя явно подписаны: объём памяти, число модулей, упаковка или внешний вид могут отличаться. Для референсной видеокарты есть пометка о версии. Если проверенного снимка нет, показан значок с подписью «Фото не добавлено». Фото корпуса в сборке показывает только корпус, а не собранный компьютер. Сохранённые в проекте фотографии доступны без Интернета. Остальные загружаются с внешних сайтов; при недоступности источника показано сообщение вместо фотографии.</p><ul class="credit-list">${Media.credits()
        .map(
          (x) =>
            "<li>" +
            esc(x.title || x.model) +
            " — " +
            Media.sourceHTML(x) +
            ". Показ с уменьшением, без изменения содержания.</li>",
        )
        .join(
          "",
        )}</ul><p>Шрифт Manrope используется по лицензии SIL Open Font License 1.1 и загружается из файлов проекта.</p></article>`;
  }
  function updateActions() {
    document
      .querySelectorAll('[data-action="favorite"], [data-action="compare"]')
      .forEach((button) => {
        const index = Number(button.dataset.index),
          key = button.dataset.action === "favorite" ? "fav" : "cmp";
        button.setAttribute("aria-pressed", String(S[key].includes(index)));
        if (button.classList.contains("icon-button"))
          button.textContent =
            key === "fav"
              ? S.fav.includes(index)
                ? "♥"
                : "♡"
              : S.cmp.includes(index)
                ? "✓"
                : "⇄";
      });
  }
  function showDialog(html) {
    $("#dialog-content").innerHTML =
      '<button class="btn secondary small dialog-close" type="button" data-action="close-dialog">Закрыть ×</button>' +
      html;
    $("#details").showModal();
  }
  function accountOwnershipNote() {
    return Backend.accountsAvailable && Backend.auth.user
      ? "Сборки сохраняются в вашем аккаунте. Войдите с тем же логином на другом устройстве, чтобы изменять их."
      : Backend.accountsAvailable
        ? 'Сейчас сборки принадлежат гостевой сессии этого браузера. <a href="account.html">Войдите или создайте аккаунт</a>, чтобы сохранить доступ с других устройств.'
        : "Записи вашей гостевой сессии в этом браузере. Ссылка позволяет открыть состав на другом устройстве.";
  }
  function accountNavigation() {
    let link = $("#account-nav-link");
    if (!link) {
      link = document.createElement("a");
      link.id = "account-nav-link";
      link.href = "account.html";
      $("#primary-nav").append(link);
    }
    link.textContent = Backend.accountsAvailable && Backend.auth.user ? "Личный кабинет" : "Аккаунт";
  }
  function clearAccountViews() {
    ownedBuilds.clear();
    saveAttempt = null;
    serverDialogVersion++;
    if ($("#details").open) $("#details").close();
    if (savedBuild) savedBuild.canEdit = false;
  }
  function accountFields() {
    const register = accountMode === "register";
    return '<form id="account-' + (register ? 'register' : 'login') + '-form" class="account-form">' +
      '<label for="account-username">Логин<input id="account-username" name="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_]{3,32}" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="account-username-help"></label>' +
      '<p id="account-username-help" class="caption">От 3 до 32 латинских букв, цифр или знаков подчёркивания. Почта не нужна.</p>' +
      (register ? '<label for="account-display-name">Имя для отображения <span class="caption">(необязательно)</span><input id="account-display-name" name="displayName" maxlength="60" autocomplete="nickname"></label>' : '') +
      '<label for="account-password">Пароль<input id="account-password" name="password" type="password" required minlength="10" maxlength="128" autocomplete="' + (register ? 'new-password' : 'current-password') + '" aria-describedby="account-password-help"></label>' +
      '<p id="account-password-help" class="caption">От 10 до 128 символов. ' + (register ? 'Используйте отдельный пароль и сохраните его в менеджере паролей. Восстановления через почту нет.' : 'Введите пароль, который указали при регистрации.') + '</p>' +
      '<p id="account-form-error" class="warn" role="alert" tabindex="-1"></p>' +
      '<button class="btn" type="submit">' + (register ? 'Создать аккаунт' : 'Войти') + '</button></form>';
  }
  function accountBuildsHTML(items) {
    return items.length
      ? '<ul class="server-build-list account-build-list">' + items.map(record => '<li><div><strong>' + esc(record.name) + '</strong><p class="caption">Обновлено ' + esc(date(record.updatedAt)) + ' · версия ' + record.version + '</p></div><a class="btn secondary small" href="' + esc(savedURL(record.id).href) + '">Открыть и изменить</a></li>').join('') + '</ul>'
      : '<p>Сохранённых сборок пока нет. Выберите детали в конфигураторе и нажмите «Сохранить на сервере».</p><a class="btn" href="builder.html">Собрать компьютер</a>';
  }
  async function account() {
    const ticket = ++accountRequest;
    const title = heading("Личный кабинет", "Сохраняйте состав компьютера и возвращайтесь к нему с другого устройства.");
    if (!Backend.accountsAvailable) {
      app.innerHTML = title + '<section class="account-panel"><h2>Нужен сервер с аккаунтами</h2><p>В этой версии сайта вход недоступен. GitHub Pages показывает статический интерфейс, а прежний Python API не хранит аккаунты.</p><p>Для локальной версии откройте папку проекта в VS Code и выполните в терминале:</p><pre class="account-command"><code>node online/server.mjs</code></pre><p>Затем откройте <code>localhost:8080/account.html</code> в адресной строке браузера.</p></section>';
      return;
    }
    if (accountError) {
      app.innerHTML = title + '<section class="account-panel"><p class="warn" role="alert">' + esc(accountError) + '</p><button class="btn secondary" type="button" data-action="account-retry">Повторить загрузку</button></section>';
      return;
    }
    const user = Backend.auth.user;
    if (!user) {
      app.innerHTML = title + (accountMessage ? '<p class="info-note" role="status">' + esc(accountMessage) + '</p>' : '') +
        '<div class="account-layout"><section class="account-panel"><div class="account-tabs" role="group" aria-label="Действие с аккаунтом"><button class="btn ' + (accountMode === 'login' ? '' : 'secondary') + '" type="button" data-action="account-mode" data-mode="login" aria-pressed="' + (accountMode === 'login') + '">Вход</button><button class="btn ' + (accountMode === 'register' ? '' : 'secondary') + '" type="button" data-action="account-mode" data-mode="register" aria-pressed="' + (accountMode === 'register') + '">Регистрация</button></div><h2>' + (accountMode === 'register' ? 'Создать аккаунт' : 'Войти в аккаунт') + '</h2>' + accountFields() + '</section><aside class="account-panel account-explanation"><h2>Что хранится в аккаунте</h2><p>Сборки записываются в базу на сервере. После входа вы сможете открыть, изменить или удалить свои записи.</p><p>Гостевые сборки этого браузера перейдут в аккаунт при входе. Избранное, сравнение и несохранённый состав остаются в браузере.</p><p>Общая ссылка показывает название и состав сборки. Другой посетитель может сохранить свою копию; изменять исходную запись может её владелец.</p></aside></div>';
      return;
    }
    app.innerHTML = title + '<section class="account-panel"><div class="account-profile"><div><h2>' + esc(user.displayName || user.username) + '</h2><p class="caption">Логин: ' + esc(user.username) + '</p></div><button class="btn secondary" type="button" data-action="account-logout">Выйти из аккаунта</button></div><p id="account-profile-error" class="warn" role="alert" tabindex="-1"></p><h3>Мои сборки</h3><p class="caption">' + accountOwnershipNote() + '</p><div id="account-builds" aria-live="polite"><p role="status">Загрузка сборок из базы…</p></div></section>';
    try {
      const items = await Backend.saved.list();
      if (ticket !== accountRequest || !$("#account-builds") || Backend.auth.user?.id !== user.id) return;
      $("#account-builds").innerHTML = accountBuildsHTML(items);
    } catch (error) {
      if (ticket !== accountRequest || !$("#account-builds")) return;
      $("#account-builds").innerHTML = '<p class="warn" role="alert">' + esc(error.message) + '</p><button class="btn secondary" type="button" data-action="account-retry">Повторить загрузку</button>';
    }
  }
  async function refreshAccountView(render = true, preserveForm = false) {
    if (!Backend.accountsAvailable || accountBusy) return;
    accountBusy = true;
    const oldId = Backend.auth.user?.id || null;
    let identityChanged = false;
    try {
      await Backend.auth.me();
      accountError = "";
      identityChanged = oldId !== (Backend.auth.user?.id || null);
      if (identityChanged) {
        clearAccountViews();
        if (page === "builder" && $("#saved-state")) updateSummary();
      }
      accountNavigation();
    } catch (error) { accountError = error.message; }
    finally { accountBusy = false; }
    if (render && page === "account") {
      const editing = $("#account-login-form") || $("#account-register-form");
      // Возврат из менеджера паролей не должен пересоздавать ту же гостевую
      // форму. При смене аккаунта и явном повторе показываем актуальную страницу.
      if (!preserveForm || identityChanged || !editing) await account();
    }
  }
  async function submitAccount(form) {
    if (accountBusy || !Backend.accountsAvailable || !form.reportValidity()) return;
    const username = $("#account-username").value.trim();
    const password = $("#account-password").value;
    const displayName = $("#account-display-name")?.value.trim() || "";
    const register = form.id === "account-register-form";
    const errorNode = $("#account-form-error");
    const controls = [...app.querySelectorAll("button,input")];
    controls.forEach(node => { node.disabled = true; });
    errorNode.textContent = "";
    accountBusy = true;
    form.setAttribute("aria-busy", "true");
    try {
      if (register) await Backend.auth.register(username, password, displayName);
      else await Backend.auth.login(username, password);
      clearAccountViews();
      accountError = "";
      accountMessage = "";
      accountNavigation();
      await account();
      app.focus({ preventScroll: true });
      toast(register ? "Аккаунт создан. Вы вошли на сайт." : "Вы вошли в аккаунт.");
    } catch (error) {
      errorNode.textContent = error.message;
      const passwordField = $("#account-password");
      if (passwordField) passwordField.value = "";
      errorNode.focus();
    } finally {
      accountBusy = false;
      form.removeAttribute("aria-busy");
      controls.forEach(node => { if (node.isConnected) node.disabled = false; });
    }
  }
  async function logoutAccount() {
    if (accountBusy || !Backend.accountsAvailable) return;
    accountBusy = true;
    const button = $('[data-action="account-logout"]');
    if (button) button.disabled = true;
    try {
      await Backend.auth.logout();
      clearAccountViews();
      accountMessage = "Вы вышли из аккаунта. Ваши сборки остаются в базе и снова появятся после входа.";
      accountMode = "login";
      accountNavigation();
      await account();
      app.focus({ preventScroll: true });
    } catch (error) {
      const node = $("#account-profile-error");
      if (node) { node.textContent = error.message; node.focus(); }
      else toast(error.message);
    } finally { accountBusy = false; if (button?.isConnected) button.disabled = false; }
  }
  function serverError(message) {
    const node = $("#server-form-error");
    if (node) node.textContent = message;
    else toast(message);
  }
  function saveBuildDialog() {
    if (!Backend.savedAvailable) return;
    serverDialogVersion++;
    showDialog('<h2 id="dialog-title">Сохранить сборку на сервере</h2>' +
      '<form id="server-save-form" class="server-build-form"><label for="saved-name">Название сборки<input id="saved-name" name="name" required maxlength="80" autocomplete="off" value="' + esc(savedBuild?.name || "Мой компьютер") + '"></label>' +
      (savedBuild?.canEdit
        ? '<label class="server-copy-choice"><input id="saved-as-copy" type="checkbox"> Сохранить новую копию вместо изменения «' + esc(savedBuild.name) + '»</label>'
        : savedBuild ? '<p class="caption">Будет создана ваша копия. Исходная запись останется без изменений.</p>' : '') +
      '<p class="caption">Название и состав доступны любому, у кого есть ссылка. Не вводите личные данные.</p><p class="caption">' + accountOwnershipNote() + '</p>' +
      '<p id="server-form-error" class="warn" role="alert"></p><button class="btn" type="submit">' +
      (savedBuild?.canEdit ? 'Сохранить изменения' : 'Сохранить и получить ссылку') + '</button></form>');
    $("#saved-name").focus();
  }
  function newSaveRequestId() {
    if (typeof crypto !== "object") throw new Error("Браузер не поддерживает безопасное сохранение. Обновите его или откройте сайт по HTTPS.");
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    // getRandomValues доступен и при показе локального сервера по HTTP в общей сети.
    if (typeof crypto.getRandomValues !== "function") throw new Error("Браузер не поддерживает безопасное сохранение. Откройте сайт по HTTPS.");
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const value = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join("-");
  }
  async function saveServerBuild(form) {
    if (serverBusy || !Backend.savedAvailable) return;
    const nameField = $("#saved-name");
    nameField.setCustomValidity(nameField.value.trim() ? "" : "Введите название сборки.");
    if (!form.reportValidity()) return;
    const name = nameField.value.trim();
    const parts = { ...S.parts };
    const update = savedBuild?.canEdit && !$("#saved-as-copy")?.checked;
    const target = update ? { ...savedBuild } : null;
    const fingerprint = JSON.stringify([target?.id, target?.version, name, Core.partsString(parts)]);
    try {
      if (!saveAttempt || saveAttempt.fingerprint !== fingerprint)
        saveAttempt = { fingerprint, requestId: newSaveRequestId() };
    } catch (error) {
      serverError(error.message);
      return;
    }
    serverBusy = true;
    const controls = [...$("#details").querySelectorAll("button,input")];
    controls.forEach(control => { control.disabled = true; });
    serverError("");
    try {
      const record = update
        ? await Backend.saved.update(target.id, name, parts, target.version)
        : await Backend.saved.create(name, parts, saveAttempt.requestId);
      savedBuild = { ...record, canEdit: true };
      savedPartsKey = Core.partsString(record.parts);
      // Новая осознанная операция должна получить новый ключ; при отказе ключ остаётся для retry.
      saveAttempt = null;
      syncBuilderURL();
      updateSummary();
      showDialog('<h2 id="dialog-title">Сборка сохранена</h2><p>«' + esc(record.name) + '» записана в базу на сервере.</p>' +
        '<label for="share-link">Ссылка на сохранённый состав</label><input id="share-link" readonly value="' + esc(savedURL(record.id).href) + '">' +
        '<button class="btn" type="button" data-action="copy-link">Скопировать ссылку</button>' +
        (Core.partsString(S.parts) !== savedPartsKey ? '<p class="info-note">Текущий состав изменился во время сохранения. Ссылка открывает именно записанную версию.</p>' : ''));
      toast("Сборка сохранена в базе.");
    } catch (error) {
      serverError(error.message + (error.status === 409 ? " Откройте актуальную запись в «Моих сборках» перед повторным изменением." : " Текущий состав не изменён."));
    } finally {
      serverBusy = false;
      controls.forEach(control => { if (control.isConnected) control.disabled = false; });
    }
  }
  async function showOwnedBuilds() {
    if (!Backend.savedAvailable || serverBusy) return;
    const ticket = ++serverDialogVersion;
    showDialog('<h2 id="dialog-title">Мои сборки</h2><p role="status">Загрузка с сервера…</p>');
    try {
      const items = await Backend.saved.list();
      if (ticket !== serverDialogVersion || !$("#details").open) return;
      ownedBuilds.clear();
      for (const record of items) ownedBuilds.set(record.id, record);
      showDialog('<h2 id="dialog-title">Мои сборки</h2><p class="caption">' + accountOwnershipNote() + '</p>' +
        (items.length ? '<ul class="server-build-list">' + items.map(record => '<li><div><strong>' + esc(record.name) + '</strong><p class="caption">Обновлено ' + esc(date(record.updatedAt)) + ' · версия ' + record.version + '</p></div><div class="row"><a class="btn secondary small" href="' + esc(savedURL(record.id).href) + '">Открыть</a><button class="btn secondary small danger" type="button" data-action="server-delete" data-id="' + esc(record.id) + '">Удалить</button></div></li>').join('') + '</ul>'
          : '<p>Сохранённых сборок пока нет. Выберите детали и нажмите «Сохранить на сервере».</p>'));
    } catch (error) {
      if (ticket !== serverDialogVersion || !$("#details").open) return;
      showDialog('<h2 id="dialog-title">Мои сборки</h2><p class="warn" role="alert">' + esc(error.message) + '</p><button class="btn secondary" type="button" data-action="server-my-builds">Повторить загрузку</button>');
    }
  }
  function deleteBuildDialog(id) {
    const record = ownedBuilds.get(id);
    if (!record || serverBusy) return;
    serverDialogVersion++;
    showDialog('<h2 id="dialog-title">Удалить сохранённую сборку?</h2><p>Запись «' + esc(record.name) + '» будет удалена из базы. Её прежняя ссылка перестанет открываться. Текущий состав в конфигураторе останется.</p><p id="server-form-error" class="warn" role="alert"></p><div class="row"><button class="btn secondary danger" type="button" data-action="server-delete-confirm" data-id="' + esc(id) + '">Удалить запись</button><button class="btn secondary" type="button" data-action="server-my-builds">Отмена</button></div>');
  }
  async function deleteServerBuild(id) {
    if (serverBusy || !ownedBuilds.has(id)) return;
    serverBusy = true;
    const controls = [...$("#details").querySelectorAll("button")];
    controls.forEach(control => { control.disabled = true; });
    let removed = false;
    try {
      await Backend.saved.remove(id);
      removed = true;
      ownedBuilds.delete(id);
      if (savedBuild?.id === id) {
        savedBuild = null;
        savedPartsKey = "";
        syncBuilderURL();
        updateSummary();
      }
      toast("Запись удалена. Текущий состав сохранён в браузере.");
    } catch (error) {
      serverError(error.message);
    } finally {
      serverBusy = false;
      controls.forEach(control => { if (control.isConnected) control.disabled = false; });
    }
    if (removed) await showOwnedBuilds();
  }

  function exportBuild() {
    const cost = budget(S.parts),
      result = check(S.parts);
    const text = [
      "СОБРАНО — состав компьютера",
      "",
      ...cats.map((c) => {
        const p = P[S.parts[c]];
        return (
          names[c] +
          ": " +
          (p
            ? p.name +
              " — " +
              money(Prices.price(p).value) +
              " (" +
              priceLabel(Prices.price(p)) +
              ")"
            : includedComponent(c, S.parts))
        );
      }),
      "",
      "Оценка бюджета: " + money(cost.value),
      budgetNote(cost),
      "",
      ...result.bad,
      ...result.unknown,
      result.missing.length
        ? "Ещё нужны: " + result.missing.map((c) => names[c]).join(", ")
        : "",
      "BIOS, QVL, разъёмы и крепления требуют ручной проверки.",
      "",
      configURL().href,
    ]
      .filter((x) => x !== "")
      .join("\r\n");
    const url = URL.createObjectURL(
      new Blob(["\ufeff" + text], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "sobrano-build.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action,
      index = Number(button.dataset.index),
      p = P[index];
    if (action === "account-mode") {
      if (accountBusy) return;
      accountMode = button.dataset.mode === "register" ? "register" : "login";
      accountMessage = "";
      await account();
      $("#account-username")?.focus();
      return;
    }
    if (action === "account-retry") { await refreshAccountView(); return; }
    if (action === "account-logout") { await logoutAccount(); return; }
    if (action === "server-save") { saveBuildDialog(); return; }
    if (action === "server-my-builds") { await showOwnedBuilds(); return; }
    if (action === "server-delete") { deleteBuildDialog(button.dataset.id); return; }
    if (action === "server-delete-confirm") { await deleteServerBuild(button.dataset.id); return; }
    if (action === "favorite" && p) {
      S.fav = S.fav.includes(index)
        ? S.fav.filter((i) => i !== index)
        : [...S.fav, index];
      persist();
      updateActions();
      if (page === "favorites") {
        await drawProducts();
        $("#app").focus({ preventScroll: true });
      }
    }
    if (action === "compare" && p) {
      if (S.cmp.includes(index)) S.cmp = S.cmp.filter((i) => i !== index);
      else if (S.cmp.length >= 4) {
        toast(
          "В сравнении уже четыре модели. Уберите одну, чтобы добавить другую.",
        );
        return;
      } else if (S.cmp.length && P[S.cmp[0]].c !== p.c) {
        toast("Сравнивать можно модели одной категории.");
        return;
      } else S.cmp.push(index);
      persist();
      updateActions();
      if (page === "compare") compare();
    }
    if (action === "add" && p) {
      const result = Compatibility.assess(p, S.parts);
      if (!result.allowed) {
        toast(result.conflicts.join(" "));
        return;
      }
      if (!(await changeComposition({ ...S.parts, [p.c]: index }))) return;
      toast(p.name + " добавлен в текущую сборку.");
      if (page === "catalog" || page === "favorites") {
        await drawProducts();
        document
          .querySelector('[data-action="add"][data-index="' + index + '"]')
          ?.focus({ preventScroll: true });
      } else if (page === "product") productDetail();
      else if (page === "index") home();
    }
    if (action === "view") {
      params.set("view", button.dataset.view === "grid" ? "grid" : "list");
      history.replaceState(null, "", location.pathname + "?" + params);
      await drawProducts();
    }
    if (action === "more") {
      visible += 12;
      await drawProducts();
    }
    if (action === "load-build" && B[index]) {
      if (!(await changeComposition(Core.buildParts(B[index])))) return;
      location.href = configURL().href;
    }
    if (action === "remove-part") {
      const next = { ...S.parts };
      delete next[button.dataset.category];
      if (!(await changeComposition(next))) return;
      refreshBuilderOptions();
      $("#slot-" + button.dataset.category)?.focus();
    }
    if (action === "clear-parts") {
      if (!(await changeComposition({}))) return;
      refreshBuilderOptions();
      toast("Состав очищен.");
    }
    if (action === "clear-compare") {
      S.cmp = [];
      persist();
      compare();
    }
    if (action === "retry-catalog") await drawProducts();
    if (action === "retry-builds") await drawBuilds();
    if (action === "export") exportBuild();
    if (action === "share") {
      const url = configURL();
      const loopback = url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
        /^127\./.test(url.hostname) || url.hostname === "[::1]";
      const stored = savedBuild && Core.partsString(S.parts) === savedPartsKey;
      const hint = (loopback
        ? '<p class="info-note">Этот локальный адрес работает только на этом компьютере. Для телефона нужен опубликованный онлайн-сайт или адрес компьютера в общей сети.</p>'
        : '<p class="caption">Скопируйте ссылку, чтобы открыть тот же состав на другом устройстве.</p>') +
        (stored ? '<p class="caption">Ссылка открывает сохранённую запись из серверной базы.</p>'
          : savedBuild ? '<p class="info-note">Состав изменён после сохранения. Эта ссылка передаёт текущие детали; запись в базе обновится после нажатия «Сохранить на сервере».</p>' : '');
      showDialog(
        '<h2 id="dialog-title">Ссылка на сборку</h2>' + hint + '<label for="share-link">Ссылка на конфигурацию</label><input id="share-link" readonly value="' +
          esc(url.href) +
          '"><button class="btn" data-action="copy-link">Скопировать ссылку</button>',
      );
      $("#share-link").select();
    }
    if (action === "copy-link") {
      const field = $("#share-link");
      field.select();
      if (navigator.clipboard?.writeText)
        navigator.clipboard
          .writeText(field.value)
          .then(() => toast("Ссылка скопирована."))
          .catch(() =>
            toast(
              "Выделенная ссылка готова: нажмите Ctrl+C или выберите «Копировать».",
            ),
          );
      else toast("Ссылка выделена. Нажмите Ctrl+C или выберите «Копировать».");
    }
    if (action === "close-dialog") {
      if (serverBusy) return;
      serverDialogVersion++;
      $("#details").close();
    }
  });
  document.addEventListener("submit", async (event) => {
    if (["account-login-form", "account-register-form"].includes(event.target.id)) {
      event.preventDefault();
      await submitAccount(event.target);
      return;
    }
    if (event.target.id === "server-save-form") {
      event.preventDefault();
      await saveServerBuild(event.target);
      return;
    }
    if (event.target.id === "catalog-filters") {
      event.preventDefault();
      clearTimeout(searchTimer);
      readFilters(true);
    }
    if (event.target.id === "build-filters") {
      event.preventDefault();
      drawBuilds();
    }
  });
  document.addEventListener("input", (event) => {
    if (event.target.id === "saved-name") event.target.setCustomValidity("");
    if (
      event.target.form?.id === "catalog-filters" &&
      event.target.tagName === "INPUT"
    ) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => readFilters(), 180);
    }
    if (event.target.id === "budget") drawBuilds();
  });
  document.addEventListener("change", async (event) => {
    if (event.target.id === "saved-as-copy") {
      const submit = $("#server-save-form button[type=submit]");
      if (submit) submit.textContent = event.target.checked ? "Сохранить новую копию" : "Сохранить изменения";
    }
    if (event.target.id === "compatible-only") {
      if (event.target.checked) params.delete("compat");
      else params.set("compat", "all");
      history.replaceState(
        null,
        "",
        location.pathname + (params.size ? "?" + params : ""),
      );
      visible = 12;
      drawProducts();
    }
    if (event.target.form?.id === "catalog-filters") {
      clearTimeout(searchTimer);
      readFilters();
    }
    if (event.target.id === "category-select") {
      const next = new URLSearchParams();
      if (event.target.value) next.set("cat", event.target.value);
      if (params.get("compat") === "all") next.set("compat", "all");
      location.href =
        (page === "favorites" ? "favorites.html" : "catalog.html") +
        (next.size ? "?" + next : "");
    }
    if (event.target.id === "task") drawBuilds();
    if (event.target.id === "only-differences")
      document.querySelectorAll(".compare-table tr.same").forEach((tr) => {
        tr.hidden = event.target.checked;
      });
    if (event.target.dataset.slot) {
      const c = event.target.dataset.slot,
        value = event.target.value,
        index = Number(value);
      const next = { ...S.parts };
      if (value === "") delete next[c];
      else if (Core.valid(index) && P[index].c === c) {
        const result = Compatibility.assess(P[index], S.parts);
        if (!result.allowed) {
          toast(result.conflicts.join(" "));
          event.target.value = S.parts[c] ?? "";
          return;
        }
        next[c] = index;
      }
      if (!(await changeComposition(next))) {
        event.target.value = S.parts[c] ?? "";
        return;
      }
      refreshBuilderOptions();
    }
  });
  document.addEventListener(
    "error",
    (event) => {
      const image = event.target;
      if (image.tagName !== "IMG") return;
      const next = image.dataset.fallback;
      if (next && image.src !== next) {
        delete image.dataset.fallback;
        image.src = next;
        return;
      }
      const figure = image.closest(".product-media");
      if (figure) {
        image.replaceWith(
          Object.assign(document.createElement("span"), {
            textContent: "Фото недоступно",
          }),
        );
        figure.classList.add("media-placeholder");
      }
    },
    true,
  );
  const themeButton = $("#theme-toggle");
  function applyTheme(value) {
    document.documentElement.dataset.theme = value;
    themeButton.textContent = value === "dark" ? "Светлая тема" : "Тёмная тема";
    document.querySelector('meta[name="theme-color"]').content =
      value === "dark" ? "#1d2027" : "#ffffff";
  }
  let theme;
  try {
    theme = localStorage.getItem("sobrano:theme:v1");
  } catch {}
  applyTheme(
    theme === "dark" || theme === "light"
      ? theme
      : "light",
  );
  themeButton.addEventListener("click", () => {
    const next =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      localStorage.setItem("sobrano:theme:v1", next);
    } catch {}
  });
  $("#menu-toggle").addEventListener("click", () => {
    const open = $("#menu-toggle").getAttribute("aria-expanded") !== "true";
    $("#menu-toggle").setAttribute("aria-expanded", String(open));
    $("#primary-nav").classList.toggle("open", open);
  });
  $("#details").addEventListener("cancel", (event) => {
    if (serverBusy) event.preventDefault();
    else serverDialogVersion++;
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      $("#primary-nav").classList.contains("open")
    ) {
      $("#primary-nav").classList.remove("open");
      $("#menu-toggle").setAttribute("aria-expanded", "false");
      $("#menu-toggle").focus();
    }
  });
  matchMedia("(min-width:901px)").addEventListener("change", (event) => {
    if ($("#filters-panel")) $("#filters-panel").open = event.matches;
  });
  window.addEventListener("storage", async (event) => {
    if (
      event.key === "sobrano:theme:v1" &&
      ["light", "dark"].includes(event.newValue)
    )
      applyTheme(event.newValue);
    if (event.key === KEY || event.key === null) {
      try {
        const incoming = sanitize(JSON.parse(event.newValue || "{}"));
        if (!(await changeComposition(incoming.parts, incoming))) return;
        counters();
        updateActions();
        if (page === "builder") {
          refreshBuilderOptions();
          syncBuilderURL();
        }
        if (page === "favorites" || page === "catalog") drawProducts();
        if (page === "product") productDetail();
        if (page === "index") home();
        if (page === "compare") compare();
      } catch {}
    }
  });
  const renderers = {
    index: home,
    catalog: () => catalogue(),
    favorites: () => catalogue(true),
    builds,
    builder,
    compare,
    about,
    product: productDetail,
    build: buildDetail,
    account,
  };
  accountNavigation();
  if (Backend.accountsAvailable) await refreshAccountView(false);
  await (renderers[page] || home)();
  counters();
  $("#storage-note").hidden = storageOK;
  $("#global-search").value = params.get("search") || "";
  const active =
    page === "product" ? "catalog" : page === "build" ? "builds" : page;
  document.querySelectorAll(".primary-nav a").forEach((a) => {
    if (a.getAttribute("href") === active + ".html")
      a.setAttribute("aria-current", "page");
  });
  // Публичные данные интерфейса для проверок; состояние пользователя меняется только обработчиками выше.
  window.SobranoApp = {
    products: P,
    builds: B,
    configURL,
    price: Prices.price,
    budget,
    backend: Backend.enabled ? window.SOBRANO_RUNTIME.backend : "static",
  };
  // Cookie задаёт сессию на сервере. При возврате из другой вкладки перечитываем её,
  // чтобы после выхода не показывать прежний кабинет из памяти страницы.
  window.addEventListener("focus", () => {
    if (Backend.accountsAvailable) refreshAccountView(page === "account", true);
  });
  return true;
})().catch((error) => {
  const node = document.getElementById("app");
  const message = document.createElement("p");
  message.className = "warn";
  message.textContent = "Не удалось запустить интерфейс. " + error.message;
  node.replaceChildren(message);
  return false;
});
