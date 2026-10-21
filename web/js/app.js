"use strict";
(() => {
  const $ = (q, root = document) => root.querySelector(q);
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const paths = {
    home: '<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/>',
    tasks:
      '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m7 9 2 2 3-4m2 2h3M7 16h10"/>',
    diary: '<path d="M4 4h15v17H4zM7 2v4m4-4v4m4-4v4M8 11h7m-7 4h5"/>',
    guides:
      '<path d="M12 5c-4-3-8-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1zm0 0v15"/>',
    reports: '<path d="M5 3h10l4 4v14H5zm10 0v5h4M8 12h8m-8 4h6"/>',
    settings:
      '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/><path d="m9 3-1 3-3 1-2 3 2 2-1 4 3 2 3-1 3 3 3-1 1-4 3-2-1-4-4-1-2-3z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
    moon: '<path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
    calendar:
      '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6m10-6v6M3 11h18m-13 4h2m4 0h2"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    edit: '<path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14zm0 0 5-1-5-5"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v1"/>',
    flag: '<path d="M5 22V3c5-5 9 5 14 0v11c-5 5-9-5-14 0"/>',
  };
  const icon = (name) =>
    `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24">${paths[name] || paths.info}</svg>`;
  const nav = [
    ["index", "Обзор", "home"],
    ["tasks", "Мои задачи", "tasks"],
    ["diary", "Дневник", "diary"],
    ["guides", "База знаний", "guides"],
    ["reports", "Отчёты", "reports"],
    ["settings", "Настройки", "settings"],
  ];
  const page = document.body.dataset.page || "index";
  const title = nav.find((n) => n[0] === page)?.[1] || "Обзор";
  const statusNames = { todo: "В планах", doing: "В работе", done: "Готово" };
  const priorities = { low: "Низкий", normal: "Обычный", high: "Высокий" };
  const filters = {
    q: "",
    status: "",
    priority: "",
    sort: "new",
    entry_q: "",
    from: "",
    to: "",
  };
  let state,
    mode = "personal",
    sequence = 0,
    toastTimer,
    debounceTimer,
    limit = 24,
    writing = false;
  try {
    mode =
      localStorage.getItem("praktikum-mode") === "demo" ? "demo" : "personal";
  } catch {}
  const duration = (mins) =>
    `${Math.floor(mins / 60)} ч${mins % 60 ? ` ${mins % 60} мин` : ""}`;
  const decimalHours = (mins) =>
    new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(
      mins / 60,
    );
  const dayText = (date, opts = {}) =>
    date
      ? new Date(`${date}T12:00:00`).toLocaleDateString("ru-RU", {
          day: "numeric",
          month: "short",
          ...opts,
        })
      : "Без срока";
  const skillName = (id) =>
    state?.guides.find((g) => g.id === id)?.title || "Без направления";
  const skillOptions = (current) =>
    `<option value="">Не указано</option>${state.guides.map((g) => `<option value="${g.id}" ${current === g.id ? "selected" : ""}>${esc(g.title)}</option>`).join("")}`;
  const btn = (label, action, css = "", symbol = "") =>
    `<button type="button" class="btn ${css}" data-action="${action}">${symbol ? icon(symbol) : ""}${label}</button>`;
  const link = (label, href, css = "", symbol = "") =>
    `<a class="btn ${css}" href="${esc(href)}">${symbol ? icon(symbol) : ""}${label}</a>`;
  function endpoint(path, query = {}) {
    const params = new URLSearchParams({ mode, ...query });
    return `/api/${path}?${params}`;
  }
  async function request(path, method = "GET", data, revision, query = {}) {
    let response;
    try {
      response = await fetch(endpoint(path, query), {
        method,
        headers:
          method === "GET"
            ? {}
            : {
                "Content-Type": "application/json",
                "X-Praktikum-Request": "1",
                "If-Match": String(revision),
              },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      });
    } catch {
      throw new Error(
        "Нет связи с сервером. Проверьте, что в терминале работает py server.py. Введённые данные остаются в форме.",
      );
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(
        "Сервер вернул неверный ответ. Запустите именно py server.py, затем повторите действие.",
      );
    }
    if (!response.ok)
      throw new Error(result.error || "Не удалось выполнить запрос.");
    return result;
  }
  function toast(message) {
    const box = $("#toast");
    box.textContent = message;
    box.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove("visible"), 5000);
  }
  function shell() {
    $("#shell").innerHTML =
      `<aside class="sidebar" id="sidebar"><a class="brand" href="/index.html"><img src="/assets/favicon.svg" alt="">практикум<span aria-hidden="true">.</span></a><p class="brand-sub">Меньше рутины. Больше дела.</p>
      <button class="mobile-menu icon-button" data-action="menu" aria-label="Открыть меню" aria-controls="navigation" aria-expanded="false">${icon("menu")}</button>
      <nav class="nav" id="navigation" aria-label="Основное меню">${nav.map(([key, label, symbol]) => `<a href="/${key}.html" ${key === page ? 'aria-current="page"' : ""}>${icon(symbol)}${label}</a>`).join("")}</nav>
      <div class="sidebar-bottom"><p>Всё, что нужно<br>для осмысленной практики.</p><div class="local-status"><span class="status-dot"></span>Данные на этом компьютере</div></div></aside>
      <div class="layout"><header class="topbar"><div class="breadcrumb"><span class="prefix">Моё пространство / </span><span>${title}</span></div><div class="top-actions"><button class="mode-button" data-action="mode" id="mode-button"></button><button class="icon-button" id="theme-button" data-action="theme"></button><span class="user-badge" id="initials" aria-hidden="true">П</span></div></header><main id="main" class="content" tabindex="-1"><p role="status">Загружаем данные…</p></main></div>`;
    updateTheme();
    updateMode();
  }
  function updateMode() {
    $("#mode-button").textContent =
      mode === "demo" ? "К моим записям" : "Открыть пример";
  }
  function updateTheme() {
    const dark = document.documentElement.dataset.theme === "dark";
    const themeButton = $("#theme-button");
    if (themeButton) {
      themeButton.innerHTML = icon(dark ? "sun" : "moon");
      themeButton.setAttribute(
        "aria-label",
        dark ? "Включить светлую тему" : "Включить тёмную тему",
      );
      themeButton.title = themeButton.getAttribute("aria-label");
    }
  }
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("praktikum-theme", theme);
    } catch {}
    updateTheme();
  }
  const footer = () =>
    `<footer class="footer"><span>Практикум · Личное пространство для студенческой практики</span><span>Сохранение на вашем компьютере · v1.0</span></footer>`;
  function context() {
    return mode === "demo"
      ? `<aside class="context" aria-label="Учебный режим">${icon("info")}<p><strong>Учебный пример.</strong> Здесь вымышленные записи для знакомства с сервисом. Ваши данные хранятся отдельно.</p>${btn("К моим записям", "mode", "small secondary")}</aside>`
      : "";
  }
  function head(heading, description, action = "") {
    return `<div class="page-head"><div><h1>${heading}</h1><p>${description}</p></div>${action}</div>`;
  }
  function empty(heading, text, action = "", compact = false) {
    return `<div class="empty ${compact ? "compact" : ""}">${icon("diary")}<h3>${heading}</h3><p>${text}</p>${action}</div>`;
  }
  function fatal(error) {
    $("#main").innerHTML =
      `<div class="panel fatal"><p class="eyebrow">Связь с рабочим пространством</p><h1>Не удалось загрузить данные</h1><p>${esc(error.message)}</p><p>В терминале папки проекта запустите:</p><p><code>py server.py</code></p>${btn("Повторить загрузку", "retry")}</div>`;
  }
  async function load(partial = false) {
    const own = ++sequence;
    $("#results")?.setAttribute("aria-busy", "true");
    try {
      const query =
        page === "tasks"
          ? {
              q: filters.q,
              status: filters.status,
              priority: filters.priority,
              sort: filters.sort,
            }
          : ["diary", "reports"].includes(page)
            ? { entry_q: filters.entry_q, from: filters.from, to: filters.to }
            : {};
      const result = await request("state", "GET", undefined, undefined, query);
      if (own !== sequence) return;
      state = result;
      if (partial && $("#results")) {
        $("#results").innerHTML =
          page === "tasks" ? taskResults() : diaryResults();
        $("#results").removeAttribute("aria-busy");
        const count = $("#result-count");
        if (count) count.textContent = resultCount();
      } else render();
      $("#initials").textContent = state.profile.name
        ? state.profile.name
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((s) => s[0])
            .join("")
        : "П";
    } catch (error) {
      if (own !== sequence) return;
      if (partial) {
        toast(error.message);
        $("#results")?.removeAttribute("aria-busy");
      } else fatal(error);
    }
  }
  function render() {
    const views = {
      index: overview,
      tasks: tasksPage,
      diary: diaryPage,
      guides: guidesPage,
      reports: reportsPage,
      settings: settingsPage,
    };
    $("#main").innerHTML = context() + views[page]() + footer();
    if (page === "guides") {
      const guide = new URLSearchParams(location.search).get("guide");
      if (guide && state.guides.some((g) => g.id === guide)) showGuide(guide);
    }
  }
  function taskRow(task, compact = false) {
    const overdue =
      task.status !== "done" && task.due_date && task.due_date < state.today;
    return `<article class="task-row" data-task-id="${task.id}"><button class="check ${task.status === "done" ? "checked" : ""}" data-action="toggle-task" data-id="${task.id}" aria-label="${task.status === "done" ? "Вернуть в планы" : "Завершить задачу"}: ${esc(task.title)}" aria-pressed="${task.status === "done"}">${task.status === "done" ? icon("check") : ""}</button><div class="task-text"><button class="task-title ${task.status === "done" ? "done" : ""}" data-action="edit-task" data-id="${task.id}">${esc(task.title)}</button>${!compact && task.description ? `<p class="task-desc">${esc(task.description)}</p>` : ""}<div class="task-meta"><span class="tag ${task.priority}">${priorities[task.priority]}</span><span>${statusNames[task.status]}</span><span class="${overdue ? "overdue" : ""}">${overdue ? "Просрочено · " : ""}${dayText(task.due_date)}</span>${task.skill ? `<span>· ${esc(skillName(task.skill))}</span>` : ""}</div></div>${!compact ? `<div class="row-buttons"><button class="icon-button" data-action="edit-task" data-id="${task.id}" aria-label="Изменить: ${esc(task.title)}">${icon("edit")}</button><button class="icon-button" data-action="delete-task" data-id="${task.id}" aria-label="Удалить: ${esc(task.title)}">${icon("trash")}</button></div>` : ""}</article>`;
  }
  function overview() {
    const p = state.profile,
      s = state.stats;
    const percent = Math.round((s.minutes / (p.target_hours * 60)) * 100);
    const upcoming = state.tasks
      .filter((t) => t.status !== "done")
      .sort((a, b) =>
        (a.due_date || "9999").localeCompare(b.due_date || "9999"),
      )
      .slice(0, 3);
    const greet =
      p.name && mode !== "demo"
        ? `Здравствуйте, ${esc(p.name.split(" ")[0])}!`
        : "Практика под контролем";
    return (
      head(
        greet,
        "Задачи, часы и результаты — в одном месте.",
        `<div class="date-pill">${icon("calendar")}${dayText(state.today, { weekday: "long", year: "numeric" })}</div>`,
      ) +
      `<section class="hero" aria-label="Запись в дневник"><div><p class="eyebrow">От первого дня до готового отчёта</p><h2>Делайте дело.<br>Сохраняйте результат.</h2><p>Запишите, над чем работали сегодня. Часы попадут в дневник и будущий отчёт.</p><div class="actions">${btn("Записать рабочий день", "new-entry", "", "plus")}${link("Все задачи", "/tasks.html", "secondary")}</div></div><img src="/assets/hero.svg" alt="Блокнот со списком выполненных дел и часами"></section>` +
      (mode === "personal" && !p.name
        ? `<aside class="context setup"><p><strong>С чего начать?</strong> Укажите данные практики и план часов или откройте учебный пример.</p>${link("Настроить практику", "/settings.html", "small secondary")}</aside>`
        : "") +
      `<section class="stats" aria-label="Итоги практики"><div class="stat"><div class="stat-top">Отработано ${icon("clock")}</div><div class="value">${decimalHours(s.minutes)} <small>из ${p.target_hours} ч</small></div><p>${percent}% от вашего плана</p></div><div class="stat"><div class="stat-top">Задачи ${icon("check")}</div><div class="value">${s.completed} <small>из ${s.tasks}</small></div><p>Завершено за практику</p></div><div class="stat"><div class="stat-top">Рабочие дни ${icon("calendar")}</div><div class="value">${s.days}</div><p>Записано в дневнике</p></div><div class="stat"><div class="stat-top">Требуют внимания ${icon("flag")}</div><div class="value">${s.overdue}</div><p>Задач с прошедшим сроком</p></div></section>` +
      `<div class="split"><section class="panel"><div class="panel-head"><h2>Ближайшие задачи</h2><a href="/tasks.html">Все задачи →</a></div>${upcoming.length ? upcoming.map((t) => taskRow(t, true)).join("") : empty("Можно начать с малого", "Добавьте задачу, которую сможете выполнить и проверить.", btn("Добавить задачу", "new-task", "small secondary"), true)}</section>
      <section class="panel"><div class="panel-head"><h2>На этой неделе</h2><span class="tag">${duration(s.weekly.reduce((sum, d) => sum + d.minutes, 0))}</span></div><div class="week-chart" role="img" aria-label="Отработанные часы по дням текущей недели">${s.weekly.map((d, i) => `<div class="chart-day"><small>${decimalHours(d.minutes)} ч</small><progress value="${d.minutes}" max="720" aria-label="${dayText(d.date)}: ${duration(d.minutes)}"></progress><span>${["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"][i]}</span></div>`).join("")}</div><div class="progress-label"><span>Общий план практики</span><strong>${Math.min(percent, 100)}%</strong></div><progress value="${Math.min(s.minutes, p.target_hours * 60)}" max="${p.target_hours * 60}" aria-label="Выполнение плана часов"></progress><p class="tip-line">${s.minutes >= p.target_hours * 60 ? "План часов выполнен. Проверьте дневник перед подготовкой отчёта." : `До плана осталось ${duration(p.target_hours * 60 - s.minutes)}.`}</p></section></div>
      <div class="panel-head bottom-heading"><h2>Под рукой</h2><a href="/guides.html">Вся база знаний →</a></div><div class="guide-strip">${state.guides
        .slice(0, 3)
        .map(
          (g) =>
            `<a class="guide-mini" href="/guides.html?guide=${g.id}"><img src="/assets/${g.image}" alt=""><div><h3>${esc(g.title)}</h3><span>Краткий практический разбор →</span></div></a>`,
        )
        .join("")}</div>`
    );
  }
  function resultCount() {
    return page === "tasks"
      ? `Найдено задач: ${state.tasks.length}`
      : `Записей: ${state.entries.length} · ${duration(state.entries.reduce((n, e) => n + e.minutes, 0))}`;
  }
  function taskResults() {
    return state.tasks.length
      ? `<div class="panel task-list">${state.tasks
          .slice(0, limit)
          .map((t) => taskRow(t))
          .join(
            "",
          )}</div>${state.tasks.length > limit ? `<div class="form-actions">${btn("Показать ещё", "more", "secondary")}</div>` : ""}`
      : empty(
          "Задач пока нет",
          filters.q || filters.status || filters.priority
            ? "По этим условиям ничего не найдено. Сбросьте фильтры или измените запрос."
            : "Начните с одной конкретной задачи. Её результат можно будет связать с дневником.",
          filters.q || filters.status || filters.priority
            ? btn("Сбросить фильтры", "reset-filters", "secondary")
            : btn("Добавить задачу", "new-task", "", "plus"),
        );
  }
  function tasksPage() {
    return (
      head(
        "Мои задачи",
        "Планируйте работу и отмечайте то, что уже сделано.",
        btn("Новая задача", "new-task", "", "plus"),
      ) +
      `<div class="tabs" role="group" aria-label="Статус задач">${[["", "Все задачи"], ...Object.entries(statusNames)].map(([value, label]) => `<button class="tab" data-action="status" data-status="${value}" aria-pressed="${filters.status === value}">${label}</button>`).join("")}</div>
      <form id="task-filters" class="filters" role="search"><label class="field search-field"><span>Поиск задачи</span><input type="search" name="q" value="${esc(filters.q)}" placeholder="Название или описание…" autocomplete="off" maxlength="200"></label><label class="field"><span>Приоритет</span><select name="priority"><option value="">Любой приоритет</option>${Object.entries(
        priorities,
      )
        .map(
          ([v, l]) =>
            `<option value="${v}" ${filters.priority === v ? "selected" : ""}>${l}</option>`,
        )
        .join(
          "",
        )}</select></label><label class="field"><span>Порядок</span><select name="sort">${[
        ["new", "Сначала новые"],
        ["due", "По сроку"],
        ["priority", "По приоритету"],
      ]
        .map(
          ([v, l]) =>
            `<option value="${v}" ${filters.sort === v ? "selected" : ""}>${l}</option>`,
        )
        .join(
          "",
        )}</select></label><button class="btn secondary" type="submit">Найти</button></form>
      <p class="results-head" id="result-count" role="status">${resultCount()}</p><div id="results">${taskResults()}</div>`
    );
  }
  function entryCard(e) {
    const task = state.allTasks.find((t) => t.id === e.task_id);
    return `<article class="panel entry" data-entry-id="${e.id}"><div class="entry-day"><strong>${new Date(e.date + "T12:00:00").getDate()}</strong><span>${dayText(e.date, { month: "long" }).replace(/^\d+\s*/, "")}</span><span>${e.date.slice(0, 4)}</span></div><div><h3>${esc(skillName(e.skill))}</h3><p>${esc(e.description)}</p><div class="task-meta"><span>${e.start_time}–${e.end_time}</span><span>· Перерыв ${e.break_minutes} мин</span>${task ? `<span>· ${esc(task.title)}</span>` : ""}</div></div><div class="entry-hours"><strong>${duration(e.minutes)}</strong><div class="row-buttons"><button class="icon-button" data-action="edit-entry" data-id="${e.id}" aria-label="Изменить запись за ${e.date}">${icon("edit")}</button><button class="icon-button" data-action="delete-entry" data-id="${e.id}" aria-label="Удалить запись за ${e.date}">${icon("trash")}</button></div></div></article>`;
  }
  function diaryResults() {
    return state.entries.length
      ? `<div class="diary-list">${state.entries.slice(0, limit).map(entryCard).join("")}</div>${state.entries.length > limit ? `<div class="form-actions">${btn("Показать ещё", "more", "secondary")}</div>` : ""}`
      : empty(
          "Дневник начинается с первого дня",
          filters.entry_q || filters.from || filters.to
            ? "В выбранном периоде записей не найдено. Измените даты или сбросьте фильтры."
            : "Расскажите, что сделано, укажите рабочее время и перерыв. Сервис посчитает часы.",
          filters.entry_q || filters.from || filters.to
            ? btn("Сбросить фильтры", "reset-filters", "secondary")
            : btn("Записать рабочий день", "new-entry", "", "plus"),
        );
  }
  function diaryPage() {
    return (
      head(
        "Дневник практики",
        "Сохраняйте результат каждого рабочего дня.",
        btn("Добавить запись", "new-entry", "", "plus"),
      ) +
      `<form class="filters" id="diary-filters" role="search"><label class="field search-field"><span>Поиск по записям</span><input name="entry_q" type="search" value="${esc(filters.entry_q)}" placeholder="Что было сделано…" maxlength="200"></label><label class="field"><span>С даты</span><input type="date" name="from" value="${filters.from}"></label><label class="field"><span>По дату</span><input type="date" name="to" value="${filters.to}"></label><button class="btn secondary" type="submit">Показать</button></form>
      <p class="results-head" id="result-count" role="status">${resultCount()}</p><div id="results">${diaryResults()}</div>`
    );
  }
  function guidesPage() {
    return (
      head("База знаний", "Короткие инструкции для настоящих рабочих задач.") +
      `<div class="guide-grid">${state.guides.map((g, i) => `<article class="panel guide-card"><img src="/assets/${g.image}" alt="${esc(g.title)}: практическая памятка" loading="lazy"><div class="guide-body"><p class="eyebrow">Памятка / 0${i + 1}</p><h2>${esc(g.title)}</h2><p>${esc(g.subtitle)}</p><button class="text-button" data-action="guide" data-guide="${g.id}">Открыть памятку →</button><div class="guide-time">${icon("clock")}Практическое задание · ≈ ${g.time} мин</div></div></article>`).join("")}</div>
      <div class="panel-head bottom-heading"><h2>Ваш опыт по направлениям</h2></div><p class="small muted">Часы из дневника. Они показывают затраченное время и не заменяют оценку руководителя.</p><div class="guide-progress">${state.guides.map((g) => `<div class="skill-row">${esc(g.title)}<strong>${duration(state.stats.skills[g.id])}</strong></div>`).join("")}</div>`
    );
  }
  function reportsPage() {
    const p = state.profile,
      total = state.entries.reduce((n, e) => n + e.minutes, 0);
    const reportQuery = { from: filters.from, to: filters.to };
    return (
      head(
        "Отчёты",
        "От записей в дневнике — к документу, который можно распечатать.",
      ) +
      `<div class="split"><section class="panel report-preview"><div class="panel-head"><h2>Дневник за период</h2>${icon("reports")}</div><form class="filters" id="report-filters"><label class="field"><span>С даты</span><input type="date" name="from" value="${filters.from}"></label><label class="field"><span>По дату</span><input type="date" name="to" value="${filters.to}"></label><button class="btn secondary" type="submit">Применить</button></form><div class="report-line"><span>Студент</span><strong>${esc(p.name || "Не заполнено")}</strong></div><div class="report-line"><span>Группа</span><strong>${esc(p.group || "Не заполнено")}</strong></div><div class="report-line"><span>Место практики</span><strong>${esc(p.organization || "Не заполнено")}</strong></div><div class="report-line"><span>Период отчёта</span><strong>${filters.from ? dayText(filters.from) : "Все даты"} — ${filters.to ? dayText(filters.to) : "Все даты"}</strong></div><div class="report-total"><div><span class="small muted">Учтено по дневнику</span><br><strong>${duration(total)}</strong></div><span class="tag">Записей: ${state.entries.length}</span></div>
      <div class="actions">${link("Открыть для печати", endpoint("report", reportQuery), "", "reports")}${link("Скачать CSV", endpoint("csv", reportQuery), "secondary", "download")}</div>
      ${!p.name || !p.group ? `<p class="note">Для полного отчёта заполните ФИО и группу в <a href="/settings.html">настройках практики</a>.</p>` : ""}
      ${!state.entries.length ? '<p class="note">Пока нет записей за выбранный период. Добавьте рабочий день в дневник или выберите другие даты.</p>' : ""}</section>
      <aside class="panel"><div class="panel-head"><h2>Перед сдачей отчёта</h2></div><ol class="help-list"><li>Проверьте ФИО, группу, место и сроки практики.</li><li>Убедитесь, что описаны выполненные работы, а перерывы исключены из часов.</li><li>Откройте печатную версию. В окне печати выберите принтер или «Сохранить как PDF».</li><li>Сверьте оформление с требованиями своего колледжа.</li></ol><p class="note">Сервис готовит личный дневник. Он не ставит подписи руководителей и не подтверждает прохождение практики.</p><hr><h3>Нужна копия всех данных?</h3><p class="small muted">Сохраните резервную копию в настройках, чтобы перенести дневник на другой компьютер.</p>${link("Резервная копия", "/settings.html", "secondary small")}</aside></div>`
    );
  }
  function profileField(key, label, type = "text", full = false) {
    return `<label class="field ${full ? "full" : ""}"><span>${label}</span><input name="${key}" type="${type}" value="${esc(state.profile[key])}" ${type === "text" ? 'maxlength="160"' : ""} ${type === "number" ? 'required min="1" max="2000" step="1"' : ""}></label>`;
  }
  function settingsPage() {
    return (
      head(
        "Настройки практики",
        "Ваши данные, план часов и резервное копирование.",
      ) +
      `<div class="settings-grid"><form class="panel settings-form" id="profile-form" data-revision="${state.revision}"><h2>О практике</h2><p>План часов и сроки уточните у руководителя. Эти данные попадут в печатный дневник.</p><div class="form-grid">${profileField("name", "ФИО студента", "text", true)}${profileField("group", "Группа")}${profileField("specialty", "Специальность")}${profileField("organization", "Место практики", "text", true)}${profileField("supervisor", "Руководитель", "text", true)}${profileField("start_date", "Начало практики", "date")}${profileField("end_date", "Конец практики", "date")}${profileField("target_hours", "План часов", "number", true)}</div><div class="error" role="alert" hidden></div><div class="form-actions"><button class="btn" type="submit">Сохранить настройки</button></div></form>
      <div class="settings-stack"><section class="panel"><h2>Внешний вид</h2><p class="small muted">Выберите удобную тему. Настройка сохранится в этом браузере.</p><div class="theme-choice">${btn("Светлая", "light", "secondary", "sun")}${btn("Тёмная", "dark", "secondary", "moon")}</div></section>
      <section class="panel backup-panel"><h2>Резервная копия</h2><p>Скачайте файл с задачами, дневником и настройками. Рекомендуем делать копию перед переносом проекта.</p>${link("Скачать JSON-копию", endpoint("backup"), "secondary", "download")}<hr><h3>Восстановить из файла</h3><p>После проверки файла вы увидите состав копии и сможете подтвердить замену. Текущая версия дополнительно сохранится в папке storage/backups.</p><label class="field file-field"><span>Файл резервной копии (.json, до 2 МБ)</span><input id="restore-file" type="file" accept=".json,application/json"></label>${btn("Проверить файл", "restore", "secondary")}<p class="small">Режим копии должен совпадать с текущим: <strong>${mode === "demo" ? "учебный пример" : "личные записи"}</strong>.</p></section>
      <section class="panel"><h2>Хранение данных</h2><p class="small muted">Записи сохраняются на компьютере, где запущен сервер. Для сохранения нужна работающая команда py server.py. Интернет для работы не требуется.</p><p class="small muted">Приложение рассчитано на одного пользователя. Не размещайте личную базу в открытом доступе.</p></section></div></div>`
    );
  }
  function openModal(title, body) {
    const modal = $("#modal");
    modal.innerHTML = `<div class="dialog-head"><h2 id="modal-title">${title}</h2><button class="icon-button" data-action="close" aria-label="Закрыть окно">${icon("close")}</button></div>${body}`;
    if (!modal.open) modal.showModal();
    $("input,textarea,select", modal)?.focus();
  }
  function showTask(id) {
    const t = state.tasks.find((t) => t.id === id) || {
      title: "",
      description: "",
      due_date: "",
      priority: "normal",
      status: "todo",
      skill: "",
    };
    openModal(
      id ? "Редактировать задачу" : "Новая задача",
      `<form id="task-form" data-id="${id || ""}" data-revision="${state.revision}"><div class="form-grid"><label class="field full"><span>Что нужно сделать *</span><input name="title" required maxlength="160" value="${esc(t.title)}" placeholder="Например, проверить форму регистрации"></label><label class="field full"><span>Описание и критерий готовности</span><textarea name="description" maxlength="4000" placeholder="Как понять, что задача выполнена?">${esc(t.description)}</textarea></label><label class="field"><span>Срок</span><input type="date" name="due_date" value="${t.due_date}"></label><label class="field"><span>Приоритет</span><select name="priority">${Object.entries(
        priorities,
      )
        .map(
          ([v, l]) =>
            `<option value="${v}" ${t.priority === v ? "selected" : ""}>${l}</option>`,
        )
        .join(
          "",
        )}</select></label><label class="field"><span>Статус</span><select name="status">${Object.entries(
        statusNames,
      )
        .map(
          ([v, l]) =>
            `<option value="${v}" ${t.status === v ? "selected" : ""}>${l}</option>`,
        )
        .join(
          "",
        )}</select></label><label class="field"><span>Направление</span><select name="skill">${skillOptions(t.skill)}</select></label></div><div class="error" role="alert" hidden></div><div class="form-actions">${btn("Отмена", "close", "secondary")}<button class="btn" type="submit">${id ? "Сохранить изменения" : "Создать задачу"}</button></div></form>`,
    );
  }
  function showEntry(id) {
    const e = state.entries.find((e) => e.id === id) || {
      date: state.today,
      start_time: "09:00",
      end_time: "15:30",
      break_minutes: 30,
      description: "",
      skill: "",
      task_id: "",
    };
    openModal(
      id ? "Редактировать запись" : "Записать рабочий день",
      `<p class="dialog-intro">Одна запись на день. Время перерыва не включается в отработанные часы.</p><form id="entry-form" data-id="${id || ""}" data-revision="${state.revision}"><div class="form-grid"><label class="field"><span>Дата *</span><input type="date" name="date" required value="${e.date}" max="${state.today}"></label><label class="field"><span>Перерыв, минут *</span><input type="number" name="break_minutes" required min="0" max="720" step="1" value="${e.break_minutes}"></label><label class="field"><span>Начало *</span><input type="time" name="start_time" required value="${e.start_time}"></label><label class="field"><span>Окончание *</span><input type="time" name="end_time" required value="${e.end_time}"></label><label class="field full"><span>Выполненная работа *</span><textarea name="description" required maxlength="5000" placeholder="Что сделано и какой результат получен?">${esc(e.description)}</textarea></label><label class="field"><span>Направление</span><select name="skill">${skillOptions(e.skill)}</select></label><label class="field"><span>Связанная задача</span><select name="task_id"><option value="">Не связывать</option>${state.allTasks.map((t) => `<option value="${t.id}" ${e.task_id === t.id ? "selected" : ""}>${esc(t.title)}</option>`).join("")}</select></label></div><div class="error" role="alert" hidden></div><div class="form-actions">${btn("Отмена", "close", "secondary")}<button class="btn" type="submit">${id ? "Сохранить изменения" : "Сохранить день"}</button></div></form>`,
    );
  }
  function showGuide(id) {
    const g = state.guides.find((g) => g.id === id);
    if (!g) return;
    openModal(
      esc(g.title),
      `<img class="guide-dialog-image" src="/assets/${g.image}" alt=""><p>${esc(g.intro)}</p><h3>Что сделать</h3><ol class="guide-steps">${g.steps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol><p class="note"><strong>Результат:</strong> ${esc(g.deliverable)}</p><hr><h3>Изучить подробнее</h3><div class="guide-sources">${g.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)} ↗</a>`).join("")}</div><p class="small muted">Ссылкам на документацию нужен Интернет. Памятка доступна локально.</p><div class="form-actions">${btn("Добавить свою задачу", "task-from-guide", "secondary", "plus")}${btn("Понятно", "close")}</div>`,
    );
    $("#modal").dataset.skill = id;
  }
  function confirmAction(title, message, button = "Подтвердить") {
    const dialog = $("#confirmation");
    return new Promise((resolve) => {
      dialog.innerHTML = `<h2 id="confirm-title">${title}</h2><p class="dialog-intro">${message}</p><form method="dialog"><div class="form-actions"><button class="btn secondary" value="cancel">Отмена</button><button class="btn danger" value="confirm">${button}</button></div></form>`;
      dialog.returnValue = "";
      dialog.showModal();
      dialog.addEventListener(
        "close",
        () => resolve(dialog.returnValue === "confirm"),
        { once: true },
      );
    });
  }
  async function write(resource, method, data, revision, form) {
    if (writing) return false;
    writing = true;
    const buttons = form ? [...form.querySelectorAll("button")] : [];
    buttons.forEach((b) => (b.disabled = true));
    const errorBox = form && $(".error", form);
    if (errorBox) errorBox.hidden = true;
    try {
      await request(resource, method, data, revision);
      return true;
    } catch (error) {
      if (errorBox) {
        errorBox.textContent = error.message;
        errorBox.hidden = false;
        errorBox.scrollIntoView({ block: "nearest" });
      } else toast(error.message);
      return false;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
      writing = false;
    }
  }
  async function remove(resource, id) {
    const revision = state.revision;
    const message =
      resource === "tasks"
        ? "Задача будет удалена. Записи дневника сохранятся, но их связь с задачей исчезнет."
        : "Запись и учтённые за этот день часы будут удалены. Отменить это действие нельзя.";
    if (!(await confirmAction("Удалить запись?", message, "Удалить"))) return;
    if (await write(`${resource}/${id}`, "DELETE", {}, revision)) {
      toast("Запись удалена");
      await load();
    }
  }
  async function restoreBackup() {
    const input = $("#restore-file"),
      file = input.files[0];
    if (!file) return toast("Сначала выберите JSON-файл резервной копии.");
    if (file.size > 2 * 1024 * 1024)
      return toast("Размер файла не должен превышать 2 МБ.");
    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch {
      return toast(
        "Не удалось прочитать JSON-файл. Выберите резервную копию Практикума.",
      );
    }
    if (
      backup?.format !== "praktikum" ||
      backup?.version !== 1 ||
      !Array.isArray(backup.tasks) ||
      !Array.isArray(backup.entries)
    )
      return toast("Это не резервная копия Практикума версии 1.");
    if (backup.mode !== mode)
      return toast(
        "Режим копии не совпадает. Учебный пример и личные записи восстанавливаются отдельно.",
      );
    const revision = state.revision;
    if (
      !(await confirmAction(
        "Восстановить данные?",
        `В копии: задач — ${backup.tasks.length}, записей дневника — ${backup.entries.length}. Текущие записи в этом режиме будут заменены. Предыдущая версия сохранится в storage/backups.`,
        "Восстановить",
      ))
    )
      return;
    if (await write("restore", "POST", { backup, confirm: true }, revision)) {
      toast(
        "Данные восстановлены. Предыдущая версия сохранена в storage/backups.",
      );
      await load();
    }
  }
  document.addEventListener("click", async (event) => {
    const element = event.target.closest("[data-action]");
    if (!element || element.disabled) return;
    const action = element.dataset.action,
      id = Number(element.dataset.id);
    if (action === "theme")
      setTheme(
        document.documentElement.dataset.theme === "dark" ? "light" : "dark",
      );
    if (action === "light" || action === "dark") setTheme(action);
    if (action === "menu") {
      const open = $("#sidebar").classList.toggle("open");
      element.setAttribute("aria-expanded", String(open));
      element.setAttribute(
        "aria-label",
        open ? "Закрыть меню" : "Открыть меню",
      );
    }
    if (action === "mode") {
      if (writing) return;
      mode = mode === "personal" ? "demo" : "personal";
      try {
        localStorage.setItem("praktikum-mode", mode);
      } catch {}
      Object.keys(filters).forEach(
        (k) => (filters[k] = k === "sort" ? "new" : ""),
      );
      limit = 24;
      updateMode();
      await load();
    }
    if (action === "retry") await load();
    if (!state) return;
    if (action === "new-task") showTask();
    if (action === "edit-task") showTask(id);
    if (action === "new-entry") showEntry();
    if (action === "edit-entry") showEntry(id);
    if (action === "close") $("#modal").close();
    if (action === "delete-task") await remove("tasks", id);
    if (action === "delete-entry") await remove("entries", id);
    if (action === "guide") showGuide(element.dataset.guide);
    if (action === "task-from-guide") {
      const skill = $("#modal").dataset.skill;
      showTask();
      $("#task-form select[name=skill]").value = skill;
    }
    if (action === "toggle-task") {
      const t = state.tasks.find((t) => t.id === id);
      if (
        t &&
        (await write(
          `tasks/${id}`,
          "PUT",
          { ...t, status: t.status === "done" ? "todo" : "done" },
          state.revision,
        ))
      ) {
        toast(
          t.status === "done"
            ? "Задача возвращена в планы"
            : "Задача завершена",
        );
        await load();
      }
    }
    if (action === "status") {
      filters.status = element.dataset.status;
      document
        .querySelectorAll("[data-action=status]")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === element)));
      limit = 24;
      await load(true);
    }
    if (action === "more") {
      limit += 24;
      $("#results").innerHTML =
        page === "tasks" ? taskResults() : diaryResults();
    }
    if (action === "reset-filters") {
      Object.keys(filters).forEach(
        (k) => (filters[k] = k === "sort" ? "new" : ""),
      );
      limit = 24;
      await load();
    }
    if (action === "restore") await restoreBackup();
  });
  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (form.method === "dialog") return;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (["task-filters", "diary-filters", "report-filters"].includes(form.id)) {
      Object.assign(filters, data);
      limit = 24;
      await load(form.id !== "report-filters");
      return;
    }
    if (form.id === "task-form" || form.id === "entry-form") {
      const id = form.dataset.id;
      if (form.id === "entry-form") {
        data.break_minutes = Number(data.break_minutes);
        data.task_id = data.task_id ? Number(data.task_id) : null;
      }
      const resource = form.id === "task-form" ? "tasks" : "entries";
      if (
        await write(
          `${resource}${id ? "/" + id : ""}`,
          id ? "PUT" : "POST",
          data,
          form.dataset.revision,
          form,
        )
      ) {
        $("#modal").close();
        toast(
          resource === "tasks"
            ? "Задача сохранена"
            : "Рабочий день сохранён. Часы рассчитаны сервером.",
        );
        await load();
      }
    }
    if (form.id === "profile-form") {
      data.target_hours = Number(data.target_hours);
      if (await write("profile", "PUT", data, form.dataset.revision, form)) {
        toast("Настройки сохранены");
        await load();
      }
    }
  });
  document.addEventListener("input", (event) => {
    const form = event.target.closest("#task-filters");
    if (!form || event.target.name !== "q") return;
    filters.q = event.target.value;
    limit = 24;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => load(true), 300);
  });
  document.addEventListener("change", (event) => {
    const form = event.target.closest("#task-filters");
    if (!form || event.target.name === "q") return;
    filters[event.target.name] = event.target.value;
    limit = 24;
    load(true);
  });
  window.addEventListener("storage", (event) => {
    if (
      event.key === "praktikum-theme" &&
      ["light", "dark"].includes(event.newValue)
    )
      setTheme(event.newValue);
  });
  shell();
  load();
})();
