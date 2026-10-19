"use strict";

const C = {
    cpu: "Процессоры",
    gpu: "Видеокарты",
    motherboard: "Материнские платы",
    ram: "Оперативная память",
    storage: "SSD и HDD",
    psu: "Блоки питания",
    case: "Корпуса",
    cooling: "Охлаждение"
};

const F = {
    cpu: [
        "Сокет", "Память", "Мощность, Вт",
        "Встроенная графика", "Кулер в комплекте", "Ядра", "Потоки"
    ],
    gpu: [
        "Потребление, Вт", "Рекомендованный БП, Вт",
        "Длина, мм", "Видеопамять, ГБ"
    ],
    motherboard: [
        "Сокет", "Память", "Форм-фактор", "Слоты RAM", "Максимум RAM, ГБ"
    ],
    ram: ["Тип памяти", "Объём, ГБ", "Модули", "Скорость, MT/s"],
    storage: ["Тип", "Объём, ГБ", "Формат M.2", "Чтение до, МБ/с"],
    psu: ["Мощность, Вт", "Форм-фактор", "Длина, мм"],
    case: ["Платы", "Видеокарта до, мм", "Кулер до, мм", "БП до, мм"],
    cooling: ["Сокеты", "Высота, мм"]
};

const brands = {
    NVIDIA: "https://www.nvidia.com/",
    AMD: "https://www.amd.com/",
    Intel: "https://www.intel.com/",
    MSI: "https://www.msi.com/",
    ASRock: "https://www.asrock.com/",
    Sapphire: "https://www.sapphiretech.com/",
    Kingston: "https://www.kingston.com/",
    Corsair: "https://www.corsair.com/",
    Crucial: "https://www.crucial.com/",
    Samsung: "https://www.samsung.com/",
    Seagate: "https://www.seagate.com/",
    DeepCool: "https://www.deepcool.com/",
    ARCTIC: "https://www.arctic.de/",
    Noctua: "https://noctua.at/",
    Fractal: "https://www.fractal-design.com/"
};

const esc = value => String(value ?? "").replace(
    /[&<>"']/g,
    symbol => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[symbol]
);

const money = value =>
    new Intl.NumberFormat("ru-KZ").format(value) + " ₸";

const $ = selector => document.querySelector(selector);
const cats = Object.keys(C);
const app = $("#app");
const dialog = $("#details");

const DATA = window.SOBRANO_DATA;

const P = DATA.products.map((row, index) => ({
    i: index,
    c: row[0],
    name: row[1],
    price: row[2],
    v: row[3],
    brand: row[1].split(" ")[0]
}));

const B = DATA.builds;
const PH = DATA.photos;

// Разные иллюстрации системных блоков.
// Они показывают пример внешнего вида, а не точную конфигурацию.

const BUILD_PHOTOS = [
    [
        "Игровой компьютер в корпусе Corsair iCUE 5000X",
        "b/bd/2025_Wn%C4%99trze_komputera_PC.jpg",
        "Jacek Halicki",
        "by-sa"
    ],
    [
        "Компьютер в корпусе Fractal Design Focus G",
        "9/92/ATX_computer_case.jpg",
        "Tiia Monto",
        "by-sa"
    ],
    [
        "Корпус Kolink Observatory RGB Midi-Tower",
        "5/5b/PC-Geh%C3%A4use_Kolink_Observatory_RGB_Midi-Tower_20201120_DSC6134.jpg",
        "PantheraLeo1359531",
        "by"
    ],
    [
        "Белый игровой ПК с жидкостным охлаждением",
        "d/de/Ricer_gaming_PC_with_CPU_watercooler.jpg",
        "Benlisquare",
        "by-sa"
    ],
    [
        "Системный корпус NZXT ATX",
        "4/45/NZXT_ATX_Case_1_2019-03-21.jpg",
        "FASTILY",
        "by-sa"
    ],
    [
        "Cooler Master Cosmos C700P Black Edition",
        "0/0a/Cooler_Master_Cosmos_C700P_Black_Edition_20190601a.jpg",
        "Solomon203",
        "by-sa"
    ],
    [
        "Системный блок Dell OptiPlex Mini Tower",
        "5/5a/Optiplex_Mid-tower.jpg",
        "RTtechPA",
        "by-sa"
    ],
    [
        "Компактный домашний HTPC",
        "d/df/ULTRA_HD_BLU_RAY_HTPC_%28cropped%29.jpg",
        "Danino2200",
        "by-sa"
    ]
].map(([title, path, author, kind]) => {
    const filename = path.split("/").pop();

    const original =
        "https://upload.wikimedia.org/wikipedia/commons/" + path;

    const preview =
        "https://upload.wikimedia.org/wikipedia/commons/thumb/" +
        path + "/960px-" + filename;

    const small = path === "5/5a/Optiplex_Mid-tower.jpg";

    return {
        title,
        author,
        src: small
            ? original
            : preview.replace("upload.wikimedia.org", "thumb.wikimedia.org"),
        fallback: small ? original : preview,
        original,
        source: "https://commons.wikimedia.org/wiki/File:" + filename,
        license: kind === "by" ? "CC BY 4.0" : "CC BY-SA 4.0",
        licenseURL:
            "https://creativecommons.org/licenses/" + kind + "/4.0/"
    };
});

const BUILD_PHOTO_ORDER = [
    6, 4, 7, 2, 3, 5, 6, 7, 1, 2, 4,
    3, 0, 1, 2, 4, 5, 0, 3, 5, 1, 0
];

let storeOK = true;
let S = { fav: [], cmp: [], parts: {} };
let toastTimer;

try {
    S = {
        ...S,
        ...JSON.parse(localStorage.getItem("sobrano:diploma:1") || "{}")
    };
} catch {
    storeOK = false;
}

const valid = index => Number.isInteger(index) && P[index];

S.fav = Array.isArray(S.fav)
    ? [...new Set(S.fav.filter(valid))]
    : [];

S.cmp = Array.isArray(S.cmp)
    ? [...new Set(S.cmp.filter(valid))].slice(0, 4)
    : [];

if (S.cmp.some(index => P[index].c !== P[S.cmp[0]].c)) {
    S.cmp = [];
}

S.parts = S.parts && typeof S.parts === "object"
    ? Object.fromEntries(
        Object.entries(S.parts).filter(
            ([category, index]) =>
                C[category] && valid(index) && P[index].c === category
        )
    )
    : {};

const page = (
    location.pathname.split("/").pop() || "index.html"
).replace(".html", "");

let q = new URLSearchParams(location.search);
let category = C[q.get("cat")] ? q.get("cat") : "";
let visible = 12;

if (page === "builder" && q.has("parts")) {
    const ids = q.get("parts").split(",");
    S.parts = {};

    cats.forEach((category, index) => {
        const productIndex = Number(ids[index]);

        if (
            ids[index] !== "" &&
            valid(productIndex) &&
            P[productIndex].c === category
        ) {
            S.parts[category] = productIndex;
        }
    });
}

function save() {
    try {
        localStorage.setItem("sobrano:diploma:1", JSON.stringify(S));
    } catch {
        storeOK = false;
        toast("Сохранение отключено браузером.");
    }

    $("#storage-note").hidden = storeOK;
    counts();
}

function toast(text) {
    $("#toast").textContent = text;
    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
        $("#toast").textContent = "";
    }, 3500);
}

function counts() {
    document.querySelectorAll("[data-count]").forEach(element => {
        element.textContent = S[element.dataset.count].length;
    });
}

function urlState() {
    history.replaceState(
        null,
        "",
        location.pathname + (q.size ? "?" + q.toString() : "")
    );
}

function configURL() {
    const url = new URL("builder.html", location.href);

    url.searchParams.set(
        "parts",
        cats.map(category => S.parts[category] ?? "").join(",")
    );

    return url;
}

function syncConfigURL() {
    history.replaceState(null, "", configURL());
}

function photo(category, build = false, index = 0) {
    if (!build) return PH[category];

    const position = Math.max(0, index) % BUILD_PHOTO_ORDER.length;
    return BUILD_PHOTOS[BUILD_PHOTO_ORDER[position]];
}

function visual(category, build = false, index = 0) {
    const image = photo(category, build, index);

    if (!image) {
        return '<div class="visual"><span aria-hidden="true">▦</span></div>';
    }

    return `
        <div class="visual ${build ? "build" : ""}">
            <img
                src="${esc(image.local || image.src)}"
                data-remote="${esc(image.fallback || image.src)}"
                ${image.original
                    ? `data-original="${esc(image.original)}"`
                    : ""}
                alt="${esc(image.title)}${build
                    ? "; пример оформления, не фото данной конфигурации"
                    : ""}"
                loading="lazy"
                referrerpolicy="no-referrer"
            >
            <small>
                Фото-пример ${build ? "оформления ПК" : "категории"}
            </small>
        </div>

        ${build ? `
            <div class="build-photo-credit">
                ${esc(image.author)} ·
                <a
                    href="${esc(image.source)}"
                    target="_blank"
                    rel="noopener noreferrer"
                >Источник</a> ·
                <a
                    href="${esc(image.licenseURL)}"
                    target="_blank"
                    rel="noopener noreferrer"
                >${esc(image.license)}</a>
            </div>
        ` : ""}
    `;
}

function spec(product, index) {
    const value = product.v[index];

    if (value === null || value === "" || value === undefined) {
        return "Не указано";
    }

    if (
        ["Встроенная графика", "Кулер в комплекте"]
            .includes(F[product.c][index])
    ) {
        return Number(value) ? "Да" : "Нет";
    }

    return String(value).replaceAll(":", " / ");
}

function card(product) {
    return `
        <article class="card">
            ${visual(product.c)}

            <div class="body">
                <div class="tag">${esc(C[product.c])}</div>

                <h3>
                    <button
                        class="plain"
                        data-a="detail"
                        data-i="${product.i}"
                    >${esc(product.name)}</button>
                </h3>

                <p class="caption">
                    ${esc(
                        F[product.c]
                            .slice(0, 2)
                            .map((_, index) => spec(product, index))
                            .join(" · ")
                    )}
                </p>

                <div class="price">${money(product.price)}</div>
                <span class="caption">Учебная расчётная цена</span>

                <div class="actions">
                    <div class="row">
                        <button
                            class="btn small"
                            data-a="add"
                            data-i="${product.i}"
                        >В сборку</button>

                        <button
                            class="btn small secondary"
                            data-a="fav"
                            data-i="${product.i}"
                            aria-label="Избранное: ${esc(product.name)}"
                            aria-pressed="${S.fav.includes(product.i)}"
                        >${S.fav.includes(product.i) ? "♥" : "♡"}</button>

                        <button
                            class="btn small secondary"
                            data-a="cmp"
                            data-i="${product.i}"
                            aria-pressed="${S.cmp.includes(product.i)}"
                        >${S.cmp.includes(product.i) ? "✓" : "⇄"}</button>
                    </div>
                </div>
            </div>
        </article>
    `;
}

function header(title, subtitle = "") {
    return `
        <section class="section">
            <div class="eyebrow">СОБРАНО / локальный проект</div>
            <h1>${title}</h1>
            ${subtitle ? `<p class="muted">${subtitle}</p>` : ""}
    `;
}

function notice() {
    return `
        <p class="warn">
            Все цены — учебные оценки в ₸.
            Доставка, сборка, ОС и периферия не включены.
            Это не предложения магазинов.
        </p>
    `;
}

function stats() {
    return `
        <div class="stats">
            <div class="panel">
                <strong>${P.length}</strong>реальных моделей
            </div>
            <div class="panel">
                <strong>${B.length}</strong>вариантов сборки
            </div>
            <div class="panel">
                <strong>8</strong>категорий
            </div>
        </div>
    `;
}

function home() {
    const featured = P
        .filter(product =>
            ["cpu", "gpu", "ram", "storage"].includes(product.c)
        )
        .filter((product, index, array) =>
            index === array.findIndex(item => item.c === product.c)
        );

    app.innerHTML = `
        <section class="hero">
            <div>
                <div class="eyebrow">Выбор под контролем</div>

                <h1>
                    Твой следующий ПК.<br>
                    <em>Начни с деталей.</em>
                </h1>

                <p class="muted">
                    Каталог, сравнение и готовые конфигурации.
                    Рассчитывай бюджет и собирай компьютер прямо здесь.
                </p>

                <div class="row">
                    <a class="btn" href="catalog.html">
                        Выбрать комплектующие →
                    </a>
                    <a class="btn secondary" href="builds.html">
                        Готовые сборки
                    </a>
                </div>
            </div>

            <div>
                ${visual("case", true, 4)}
                <p class="caption">
                    Пример оформления компьютера.
                    Внешний вид выбранной сборки может отличаться.
                </p>
            </div>
        </section>

        ${stats()}

        <section class="section">
            <div class="row space">
                <h2>Найди нужную деталь</h2>
                <a class="link" href="catalog.html">Весь каталог →</a>
            </div>

            <div class="categories">
                ${cats.map(category => `
                    <a
                        class="btn secondary"
                        href="catalog.html?cat=${category}"
                    >
                        ${C[category]} ·
                        ${P.filter(product => product.c === category).length}
                    </a>
                `).join("")}
            </div>

            <div class="grid">${featured.map(card).join("")}</div>
        </section>

        <section class="section">
            <div class="row space">
                <h2>Готовые конфигурации</h2>
                <a class="link" href="builds.html">Все сборки →</a>
            </div>

            <div class="grid">
                ${B.slice(0, 4).map(buildCard).join("")}
            </div>
        </section>
    `;
}

function catalogue(favoritesOnly = false) {
    const list = favoritesOnly
        ? P.filter(product => S.fav.includes(product.i))
        : P;

    const availableBrands = [...new Set(
        list
            .filter(product => !category || product.c === category)
            .map(product => product.brand)
    )].sort();

    app.innerHTML = header(
        favoritesOnly ? "Избранное" : "Комплектующие для твоего ПК",
        favoritesOnly
            ? "Сохраняй варианты для будущей сборки."
            : "Цены и характеристики на одном экране."
    ) + `
        <div class="categories">
            <button
                data-cat=""
                class="${!category ? "active" : ""}"
            >Все · ${list.length}</button>

            ${cats.map(item => `
                <button
                    data-cat="${item}"
                    class="${category === item ? "active" : ""}"
                >
                    ${C[item]} ·
                    ${list.filter(product => product.c === item).length}
                </button>
            `).join("")}
        </div>

        <div class="panel filters">
            <label>
                Поиск
                <input
                    id="search"
                    type="search"
                    placeholder="Модель, бренд, DDR5…"
                    value="${esc(q.get("search") || "")}"
                >
            </label>

            <label>
                Бренд
                <select id="brand">
                    <option value="">Все бренды</option>

                    ${availableBrands.map(brand => `
                        <option
                            value="${esc(brand)}"
                            ${q.get("brand") === brand ? "selected" : ""}
                        >${esc(brand)}</option>
                    `).join("")}
                </select>
            </label>

            <label>
                Цена от, ₸
                <input
                    id="min"
                    type="number"
                    min="0"
                    value="${esc(q.get("min") || "")}"
                >
            </label>

            <label>
                Цена до, ₸
                <input
                    id="max"
                    type="number"
                    min="0"
                    value="${esc(q.get("max") || "")}"
                >
            </label>

            <label>
                Сортировка
                <select id="sort">
                    ${[
                        ["name", "По названию"],
                        ["asc", "Сначала дешевле"],
                        ["desc", "Сначала дороже"]
                    ].map(([value, text]) => `
                        <option
                            value="${value}"
                            ${q.get("sort") === value ? "selected" : ""}
                        >${text}</option>
                    `).join("")}
                </select>
            </label>
        </div>

        <div class="row space">
            <p id="found" class="count" aria-live="polite"></p>

            <button
                class="btn secondary small"
                data-a="reset"
            >Сбросить фильтры</button>
        </div>

        <div id="results" class="grid"></div>

        <div class="section row" style="justify-content:center">
            <button
                id="more"
                class="btn secondary"
                data-a="more"
            >Показать ещё</button>
        </div>
        </section>
    `;

    drawProducts();
}

function drawProducts() {
    if (!$("#results")) return;

    const terms = (q.get("search") || "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);

    const rows = P.filter(product =>
        (page !== "favorites" || S.fav.includes(product.i)) &&
        (!category || product.c === category) &&
        (!q.get("brand") || product.brand === q.get("brand")) &&
        (!q.get("min") || product.price >= Number(q.get("min"))) &&
        (!q.get("max") || product.price <= Number(q.get("max"))) &&
        terms.every(term =>
            (
                product.name + " " +
                product.brand + " " +
                product.v.join(" ")
            ).toLowerCase().includes(term)
        )
    );

    rows.sort((a, b) => {
        if (q.get("sort") === "asc") return a.price - b.price;
        if (q.get("sort") === "desc") return b.price - a.price;
        return a.name.localeCompare(b.name, "ru");
    });

    $("#found").textContent = "Найдено: " + rows.length;

    $("#results").innerHTML = rows.length
        ? rows.slice(0, visible).map(card).join("")
        : '<p class="empty">Ничего не найдено. Измени поиск или сбрось фильтры.</p>';

    $("#more").hidden = rows.length <= visible;
}

function product(index) {
    const item = P[index];
    if (!item) return;

    const image = photo(item.c);

    show(`
        <div class="detail">
            <div>
                ${visual(item.c)}
                <p class="caption">
                    ${esc(image?.title || "")} — фото-пример категории.
                </p>
            </div>

            <div>
                <span class="tag">${C[item.c]}</span>
                <h2>${esc(item.name)}</h2>
                <div class="price">${money(item.price)}</div>
                <span class="pill">Учебная расчётная цена</span>

                <p class="muted">
                    Основные характеристики из локального набора данных.
                </p>

                <div class="row">
                    <button
                        class="btn"
                        data-a="add"
                        data-i="${index}"
                    >Добавить в сборку</button>

                    <button
                        class="btn secondary"
                        data-a="cmp"
                        data-i="${index}"
                    >Сравнить</button>
                </div>
            </div>
        </div>

        <h3>Характеристики</h3>

        <table class="specs">
            ${F[item.c].map((title, i) => `
                <tr>
                    <th>${title}</th>
                    <td>${esc(spec(item, i))}</td>
                </tr>
            `).join("")}
        </table>

        <p class="caption">
            Профили памяти зависят от BIOS и контроллера CPU.
            Комплектацию и конкретное исполнение нужно проверять.
        </p>

        ${brands[item.brand] ? `
            <a
                class="link"
                href="${brands[item.brand]}"
                target="_blank"
                rel="noopener noreferrer"
            >Официальный сайт бренда ↗</a>
        ` : ""}
    `);
}

function show(html) {
    dialog.innerHTML = `
        <button
            class="btn secondary small close"
            data-a="close"
            aria-label="Закрыть окно"
        >Закрыть ×</button>

        <div style="clear:both">${html}</div>
    `;

    if (!dialog.open) dialog.showModal();
}

function compare() {
    const rows = S.cmp.map(index => P[index]);

    app.innerHTML = header(
        "Сравнение комплектующих",
        "До четырёх моделей одной категории. Различия выделены."
    ) + (rows.length ? `
        <div class="row space">
            <label class="toggle">
                <input id="diff" type="checkbox">Только различия
            </label>

            <button
                class="btn secondary small"
                data-a="clearcmp"
            >Очистить</button>
        </div>

        <div class="section scroll">
            <table class="compare">
                <thead>
                    <tr>
                        <th>Характеристика</th>

                        ${rows.map(item => `
                            <th>
                                ${esc(item.name)}
                                <p class="price">${money(item.price)}</p>
                                <button
                                    class="btn secondary small"
                                    data-a="cmp"
                                    data-i="${item.i}"
                                >Убрать</button>
                            </th>
                        `).join("")}
                    </tr>
                </thead>

                <tbody>
                    ${F[rows[0].c].map((title, index) => {
                        const different = new Set(
                            rows.map(item => spec(item, index))
                        ).size > 1;

                        return `
                            <tr class="${different ? "diff" : "same"}">
                                <th>${title}</th>
                                ${rows.map(item => `
                                    <td>${esc(spec(item, index))}</td>
                                `).join("")}
                            </tr>
                        `;
                    }).join("")}
                </tbody>
            </table>
        </div>
    ` : `
        <div class="empty">
            Добавь товары кнопкой ⇄ в каталоге.
            <p><a class="btn" href="catalog.html">Открыть каталог</a></p>
        </div>
    `) + "</section>";
}

function total(parts) {
    return Object.values(parts)
        .filter(valid)
        .reduce((sum, index) => sum + P[index].price, 0);
}

function check(parts) {
    const get = category =>
        valid(parts[category]) ? P[parts[category]] : null;

    const cpu = get("cpu");
    const board = get("motherboard");
    const ram = get("ram");
    const gpu = get("gpu");
    const psu = get("psu");
    const box = get("case");
    const cooler = get("cooling");

    const bad = [];

    const missing = [
        "cpu", "motherboard", "ram", "storage", "psu", "case"
    ].filter(category => !get(category));

    if (cpu && !Number(cpu.v[3]) && !gpu) missing.push("gpu");
    if (cpu && !Number(cpu.v[4]) && !cooler) missing.push("cooling");

    if (
        cpu && board &&
        cpu.v[0] && board.v[0] &&
        cpu.v[0] !== board.v[0]
    ) {
        bad.push("Сокеты CPU и платы отличаются");
    }

    if (board && ram && board.v[1] !== ram.v[0]) {
        bad.push("Тип памяти не поддерживается платой");
    }

    if (board && ram && Number(ram.v[1]) > Number(board.v[4])) {
        bad.push("Превышен объём памяти платы");
    }

    if (board && ram && Number(ram.v[2]) > Number(board.v[3])) {
        bad.push("Недостаточно слотов памяти");
    }

    if (
        cpu && cooler &&
        cooler.v[0] &&
        !cooler.v[0].split(":").includes(cpu.v[0])
    ) {
        bad.push("Нет заявленного крепления кулера для CPU");
    }

    if (
        board && box &&
        box.v[0] &&
        !box.v[0].split(":").includes(board.v[2])
    ) {
        bad.push("Плата не помещается в корпус");
    }

    if (gpu && box && Number(gpu.v[2]) > Number(box.v[1])) {
        bad.push("Видеокарта длиннее допуска корпуса");
    }

    if (cooler && box && Number(cooler.v[1]) > Number(box.v[2])) {
        bad.push("Кулер выше допуска корпуса");
    }

    if (psu && box && Number(psu.v[2]) > Number(box.v[3])) {
        bad.push("БП длиннее допуска корпуса");
    }

    const cpuPower =
        (Number(cpu?.v[2]) || 0) *
        (Number(cpu?.v[7]) ? 1 : 1.5);

    const need = Math.ceil(Math.max(
        (cpuPower + (Number(gpu?.v[0]) || 0) + 75) * 1.25,
        Number(gpu?.v[1]) || 0
    ) / 50) * 50;

    if (psu && Number(psu.v[0]) < need) {
        bad.push("Мощность БП ниже расчётной: " + need + " Вт");
    }

    return { bad, missing, need };
}

function bparts(build) {
    return Object.fromEntries(
        cats
            .map((category, index) => [category, build[3][index]])
            .filter(([, index]) => valid(index))
    );
}

function buildCard(build) {
    const parts = bparts(build);
    const index = B.indexOf(build);

    return `
        <article class="card">
            ${visual("case", true, index)}

            <div class="body">
                <span class="tag">${esc(build[1])}</span>
                <h3>${esc(build[0])}</h3>
                <p class="caption">${esc(build[2])}</p>
                <div class="price">${money(total(parts))}</div>
                <span class="caption">Учебная стоимость компонентов</span>

                <div class="actions">
                    <button
                        class="btn secondary"
                        data-a="build"
                        data-i="${index}"
                    >Состав и детали →</button>
                </div>
            </div>
        </article>
    `;
}

function builds() {
    app.innerHTML = header(
        "Готовые сборки ПК",
        "От первого компьютера до игровой и рабочей станции."
    ) + `
        <div class="panel filters">
            <label>
                Задача
                <select id="task">
                    <option value="">Все сценарии</option>

                    ${[...new Set(B.map(build => build[1]))].map(task => `
                        <option value="${esc(task)}">${esc(task)}</option>
                    `).join("")}
                </select>
            </label>

            <label>
                Бюджет до, ₸
                <input
                    id="budget"
                    type="number"
                    min="0"
                    placeholder="Без ограничений"
                >
            </label>
        </div>

        <p id="found" class="count"></p>
        <div id="build-results" class="grid"></div>
        </section>
    `;

    drawBuilds();
}

function drawBuilds() {
    const rows = B.filter(build =>
        (!$("#task").value || build[1] === $("#task").value) &&
        (
            !$("#budget").value ||
            total(bparts(build)) <= Number($("#budget").value)
        )
    );

    $("#found").textContent = "Конфигураций: " + rows.length;

    $("#build-results").innerHTML = rows.length
        ? rows.map(buildCard).join("")
        : '<p class="empty">Сборок по этому бюджету нет. Измени фильтр.</p>';
}

function buildDetail(index) {
    const build = B[index];
    if (!build) return;

    const parts = bparts(build);
    const result = check(parts);

    show(`
        <span class="tag">${esc(build[1])}</span>
        <h2>${esc(build[0])}</h2>
        <p>${esc(build[2])}</p>
        <div class="price">${money(total(parts))}</div>
        ${notice()}

        <table class="specs">
            ${cats.map(category => `
                <tr>
                    <th>${C[category]}</th>
                    <td>
                        ${parts[category] !== undefined
                            ? esc(P[parts[category]].name)
                            : category === "gpu"
                                ? "Встроенная графика CPU"
                                : "Комплектный кулер CPU"}
                    </td>
                    <td>
                        ${parts[category] !== undefined
                            ? money(P[parts[category]].price)
                            : "Включено"}
                    </td>
                </tr>
            `).join("")}
        </table>

        <p class="${result.bad.length ? "bad" : "good"}">
            ${result.bad.length
                ? esc(result.bad.join("; "))
                : "Проверенные базовые ограничения соблюдены."}
        </p>

        <p class="caption">
            BIOS, QVL, кабели, охлаждение и физическая совместимость
            требуют ручной проверки.
        </p>

        <button
            class="btn"
            data-a="load"
            data-i="${index}"
        >Изменить в конфигураторе →</button>
    `);
}

function builder() {
    const result = check(S.parts);

    app.innerHTML = header(
        "Собери свой компьютер",
        "Выбери детали, проверь ограничения и сохрани состав."
    ) + `
        <div class="builder">
            <div class="panel">
                ${cats.map(category => `
                    <div class="slot">
                        <label for="slot-${category}">${C[category]}</label>

                        <select id="slot-${category}" data-slot="${category}">
                            <option value="">
                                ${category === "gpu"
                                    ? "Встроенная графика / не выбран"
                                    : category === "cooling"
                                        ? "Комплектный / не выбран"
                                        : "Выбрать компонент"}
                            </option>

                            ${P.filter(product => product.c === category)
                                .sort((a, b) => a.price - b.price)
                                .map(product => `
                                    <option
                                        value="${product.i}"
                                        ${S.parts[category] === product.i
                                            ? "selected" : ""}
                                    >
                                        ${esc(product.name)}
                                        · ${money(product.price)}
                                    </option>
                                `).join("")}
                        </select>

                        <button
                            class="btn secondary small"
                            data-a="remove"
                            data-cat="${category}"
                            aria-label="Убрать ${C[category]}"
                        >×</button>
                    </div>
                `).join("")}
            </div>

            <aside class="panel summary">
                <span class="tag">Стоимость компонентов</span>

                <div class="price" style="font-size:34px">
                    ${money(total(S.parts))}
                </div>

                <p class="caption">Учебная расчётная стоимость</p>
                <h3>Проверка сборки</h3>

                ${result.bad.map(text => `
                    <p class="bad">✕ ${esc(text)}</p>
                `).join("")}

                ${result.missing.length
                    ? `
                        <p class="muted">
                            Ещё нужны:
                            ${result.missing
                                .map(category => C[category].toLowerCase())
                                .join(", ")}.
                        </p>
                    `
                    : !result.bad.length
                        ? '<p class="good">✓ Базовые ограничения соблюдены.</p>'
                        : ""}

                <p class="caption">
                    Расчётный минимум БП: ${result.need} Вт.
                    Проверь также качество и разъёмы блока питания.
                </p>

                <p class="warn">
                    Проверь BIOS, QVL, кабели, крепления,
                    охлаждение и геометрию перед покупкой.
                </p>

                <div class="stack">
                    <button class="btn" data-a="export">
                        Скачать состав .txt
                    </button>
                    <button class="btn secondary" data-a="share">
                        Ссылка на сборку
                    </button>
                    <button
                        class="btn secondary danger"
                        data-a="clearparts"
                    >Очистить состав</button>
                </div>
            </aside>
        </div>
        </section>
    `;
}

function about() {
    const images = [...Object.values(PH), ...BUILD_PHOTOS]
        .filter((image, index, array) =>
            array.findIndex(item => item.source === image.source) === index
        );

    app.innerHTML = header(
        "О проекте СОБРАНО",
        "Независимый локальный информационный сервис."
    ) + `
        <div class="panel">
            <h2>Как устроен проект</h2>
            <p>
                Названия моделей реальны.
                Характеристики сокращены до основных параметров.
                Цены — учебные оценки для демонстрации расчётов.
            </p>
            <p>
                HTML задаёт каркас страницы, CSS отвечает за оформление.
                В data.js хранятся данные, в app.js — логика интерфейса.
            </p>
            <p>
                Избранное, сравнение и конфигурация сохраняются
                в localStorage браузера.
            </p>
            <p>
                Фотографии показывают примеры внешнего вида.
                Они не подтверждают внешний вид конкретной конфигурации.
            </p>
            <p>
                Manrope подключён через Google Fonts под
                SIL Open Font License 1.1.
            </p>

            <h3>Фотографии и авторство</h3>
            <ul>
                ${images.map(image => `
                    <li>
                        <a
                            class="link"
                            href="${esc(image.source)}"
                            target="_blank"
                            rel="noopener noreferrer"
                        >${esc(image.title)}</a>

                        · ${esc(image.author)} ·

                        <a
                            class="link"
                            href="${esc(image.licenseURL)}"
                            target="_blank"
                            rel="noopener noreferrer"
                        >${esc(image.license)}</a>
                    </li>
                `).join("")}
            </ul>
        </div>
        </section>
    `;
}

function render() {
    const routes = {
        index: home,
        catalog: catalogue,
        builds,
        builder,
        favorites: () => catalogue(true),
        compare,
        about
    };

    (routes[page] || home)();
    counts();

    document.querySelectorAll("nav a").forEach(link => {
        if (link.getAttribute("href") === page + ".html") {
            link.setAttribute("aria-current", "page");
        }
    });

    if (!storeOK) $("#storage-note").hidden = false;
}

function refreshCards() {
    if (page === "index") home();
    if (page === "catalog" || page === "favorites") drawProducts();
    if (page === "compare") compare();
    counts();
}

document.addEventListener("error", event => {
    const image = event.target;
    if (image.tagName !== "IMG") return;

    if (image.dataset.remote && image.src !== image.dataset.remote) {
        const next = image.dataset.remote;
        delete image.dataset.remote;
        image.src = next;
    } else if (
        image.dataset.original &&
        image.src !== image.dataset.original
    ) {
        const next = image.dataset.original;
        delete image.dataset.original;
        image.src = next;
    } else {
        image.replaceWith(
            Object.assign(document.createElement("span"), {
                textContent: "Изображение недоступно"
            })
        );
    }
}, true);

document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;

    if (button.dataset.cat !== undefined && !button.dataset.a) {
        category = button.dataset.cat;
        category ? q.set("cat", category) : q.delete("cat");
        q.delete("brand");
        visible = 12;
        urlState();
        catalogue(page === "favorites");
        return;
    }

    const index = Number(button.dataset.i);
    const action = button.dataset.a;

    if (action === "detail") product(index);
    if (action === "close") dialog.close();

    if (action === "add" && valid(index)) {
        S.parts[P[index].c] = index;
        save();
        toast("Добавлено в конфигуратор");
        if (page === "builder") builder();
    }

    if (action === "fav" && valid(index)) {
        S.fav = S.fav.includes(index)
            ? S.fav.filter(item => item !== index)
            : [...S.fav, index];

        save();
        refreshCards();
    }

    if (action === "cmp" && valid(index)) {
        if (S.cmp.includes(index)) {
            S.cmp = S.cmp.filter(item => item !== index);
        } else {
            if (S.cmp.length && P[S.cmp[0]].c !== P[index].c) {
                toast("Сравнивай модели одной категории");
                return;
            }

            if (S.cmp.length === 4) {
                toast("В сравнении уже 4 модели");
                return;
            }

            S.cmp.push(index);
        }

        save();
        refreshCards();
        toast("В сравнении: " + S.cmp.length);
    }

    if (action === "reset") {
        q = new URLSearchParams();
        category = "";
        visible = 12;
        urlState();
        catalogue(page === "favorites");
    }

    if (action === "more") {
        visible += 12;
        drawProducts();
    }

    if (action === "clearcmp") {
        S.cmp = [];
        save();
        compare();
    }

    if (action === "build") buildDetail(index);

    if (action === "load" && B[index]) {
        S.parts = bparts(B[index]);
        save();
        location.href = configURL().href;
    }

    if (action === "remove") {
        delete S.parts[button.dataset.cat];
        save();
        syncConfigURL();
        builder();
    }

    if (action === "clearparts") {
        S.parts = {};
        save();
        syncConfigURL();
        builder();
    }

    if (action === "share") {
        const link = configURL();

        show(`
            <h2>Ссылка на конфигурацию</h2>
            <p>
                Адрес 127.0.0.1 работает на текущем компьютере.
                Для другого устройства нужен доступный адрес сайта.
            </p>

            <label class="field">
                Скопируй ссылку
                <input
                    id="share-link"
                    readonly
                    value="${esc(link.href)}"
                >
            </label>
        `);

        $("#share-link").select();
    }

    if (action === "export") {
        const result = check(S.parts);

        const text = [
            "СОБРАНО — конфигурация ПК",
            "Учебные расчётные цены; не предложения магазинов.",
            "",
            ...cats.map(category =>
                C[category] + ": " + (
                    valid(S.parts[category])
                        ? P[S.parts[category]].name +
                          " — " + money(P[S.parts[category]].price)
                        : "не выбран / комплектный"
                )
            ),
            "",
            "Итого: " + money(total(S.parts)),
            "Не включены доставка, сборка, ОС и периферия.",
            ...result.bad,
            "Ручная проверка: BIOS, QVL, кабели, охлаждение и геометрия."
        ].join("\n");

        const url = URL.createObjectURL(
            new Blob([text], { type: "text/plain;charset=utf-8" })
        );

        const link = document.createElement("a");
        link.href = url;
        link.download = "sobrano-build.txt";
        link.click();

        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
});

document.addEventListener("input", event => {
    const id = event.target.id;

    if (["search", "min", "max"].includes(id)) {
        event.target.value
            ? q.set(id, event.target.value)
            : q.delete(id);

        visible = 12;
        urlState();
        drawProducts();
    }

    if (id === "budget") drawBuilds();
});

document.addEventListener("change", event => {
    const id = event.target.id;

    if (["brand", "sort"].includes(id)) {
        event.target.value
            ? q.set(id, event.target.value)
            : q.delete(id);

        visible = 12;
        urlState();
        drawProducts();
    }

    if (id === "task") drawBuilds();

    if (id === "diff") {
        document.querySelectorAll(".compare .same").forEach(row => {
            row.hidden = event.target.checked;
        });
    }

    if (event.target.dataset.slot) {
        const category = event.target.dataset.slot;

        if (event.target.value === "") {
            delete S.parts[category];
        } else {
            const index = Number(event.target.value);

            if (valid(index) && P[index].c === category) {
                S.parts[category] = index;
            }
        }

        save();
        syncConfigURL();
        builder();
    }
});

// Переключатель светлой и тёмной темы.
(function initializeSobranoTheme() {
    const root = document.documentElement;
    const bar = document.querySelector("header .bar");

    if (!bar || document.getElementById("theme-toggle")) return;

    const key = "sobrano:theme:v1";
    let saved = null;

    try {
        saved = localStorage.getItem(key);
    } catch {}

    const systemDark =
        window.matchMedia("(prefers-color-scheme: dark)").matches;

    const button = document.createElement("button");
    button.type = "button";
    button.id = "theme-toggle";
    button.className = "theme-toggle";

    function apply(theme) {
        const dark = theme === "dark";
        root.dataset.theme = dark ? "dark" : "light";

        button.innerHTML = `
            <span class="theme-symbol" aria-hidden="true">
                ${dark ? "☀" : "☾"}
            </span>
            <span>${dark ? "Светлая тема" : "Тёмная тема"}</span>
        `;
    }

    apply(
        saved === "dark" || saved === "light"
            ? saved
            : systemDark ? "dark" : "light"
    );

    bar.append(button);

    button.addEventListener("click", () => {
        const theme =
            root.dataset.theme === "dark" ? "light" : "dark";

        apply(theme);

        try {
            localStorage.setItem(key, theme);
        } catch {}
    });

    window.addEventListener("storage", event => {
        if (
            event.key === key &&
            (event.newValue === "dark" || event.newValue === "light")
        ) {
            apply(event.newValue);
        }
    });
})();

const titles = {
    index: "Главная",
    catalog: "Каталог комплектующих",
    builds: "Готовые сборки ПК",
    builder: "Конфигуратор ПК",
    favorites: "Избранное",
    compare: "Сравнение",
    about: "О проекте"
};

document.title = (titles[page] || "Главная") + " — СОБРАНО";
render();