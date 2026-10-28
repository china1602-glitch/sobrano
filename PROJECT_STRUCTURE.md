# Структура проекта

В VS Code откройте папку, в которой лежат **`package.json`, `online/`, `index.html`**, либо `sobrano.code-workspace`. Не открывайте только отдельный HTML-файл.

```text
проект/
├── index.html, catalog.html, product.html
├── builds.html, build.html, builder.html
├── compare.html, favorites.html, account.html, about.html
├── css/style.css                   Темы, размеры, адаптивность
├── js/
│   ├── bootstrap.js                Определение режима сервера
│   ├── backend-client.js           Fetch, ошибки, сессия, аккаунты
│   ├── app.js                      Страницы, формы и события
│   ├── core.js                     Модели и состав
│   ├── catalog-ui.js               Фильтры/сортировка
│   ├── compatibility.js            Известные правила совместимости
│   ├── pricing.js                  Предложения и бюджет
│   ├── media.js                    Вывод фото и состояния ошибки
│   └── product-images.js           Сопоставление фото и источники
├── online/
│   ├── server.mjs                  Основной Node.js HTTP-сервер
│   ├── worker.mjs                  Облачный вход Cloudflare Workers
│   ├── api.mjs                     Маршруты, JSON, CSRF, права
│   ├── domain.mjs                  Каталог, расчёт, проверка состава
│   ├── auth.mjs                    Пароли и учётные данные
│   ├── store.mjs                   SQL-каталог, аккаунты, сессии, сборки
│   ├── node-db.mjs                 Адаптер встроенной SQLite
│   ├── schema.sql                  Начальная локальная схема
│   ├── db-schema.mjs               Описание схемы для Drizzle
│   └── generated-assets.mjs        Результат сборки, не ручной код
├── drizzle/                        SQL-миграции и metadata
├── drizzle.config.mjs              Настройка генерации миграций
├── data/
│   ├── catalog.json                Исходные модели и готовые составы
│   ├── offers.json                 Датированные предложения магазинов
│   └── photo-cache-sources.json    Источники необязательного кеша фото
├── instance/sobrano.sqlite          База, появляется при запуске
├── assets/                         Локальные шрифты, favicon, фото при наличии
├── backend/                        Python-расчёт и проверка файлов состава
├── desktop_app.py                  Отдельное приложение Python/Tkinter
├── server.py                       Сохранённый прежний Python API
├── runtime.json                    Статический режим для файлов Pages
├── tools/                          Сборка, запуск JS-тестов, загрузка фото
├── tests/                          Расчёт, HTTP, SQL, доступ, браузер и Python
├── docs/
│   ├── PM6_REQUIREMENTS.md         Соответствие вопросам преподавателя
│   ├── ONLINE_BACKEND.md           Запуск/API/хранение
│   ├── ONLINE_CHECKS.md            Фактически выполненные проверки
│   ├── COMPATIBILITY.md            Границы проверки совместимости
│   ├── PRICE-SOURCES.md            Происхождение цен
│   └── PHOTO-SOURCES.md            Происхождение фото
├── .vscode/                        Запуск F5 и задачи
├── .openai/hosting.json             Связь с прежним Sites-размещением
├── package.json, package-lock.json  Команды и зависимости разработки
├── requirements.txt                Пояснение зависимостей Python/Tkinter
├── START.bat, START-ONLINE.bat      Основной Node.js-сервер Windows
├── START-PYTHON.bat                 Прежний Python API
├── START-DESKTOP.bat                Оконная Python-программа
├── sobrano.code-workspace           Рабочая область VS Code
├── README.md                       Что и как запустить
├── DEFENSE.md                      Сценарий на 5–6 минут
└── FRONTEND_BACKEND_GUIDE.md        Объяснение работы частей
```

`node_modules/` появляется после `npm ci`; `dist/` — после сборки. Они не заменяют исходники. `dist/` и `online/generated-assets.mjs` генерируются; вручную их не редактируют.

`instance/`, SQLite-файлы, сессии, пароли и временные данные не включают в исходный архив и публичный Git. Чтобы перенести существующую локальную базу, сначала остановите сервер, затем отдельно скопируйте `instance/`. Новый чистый архив не содержит чужих аккаунтов и личных записей.

`.git/` содержит историю кода. `__pycache__/` и `.pyc` — двоичный кеш Python, а не текст программы. Для объяснения открывайте `.py`, `.mjs`, `.js`, `.sql`, HTML и CSS. Технические снимки проверки не нужны сайту; для презентации сделайте снимки своей запущенной копии.

## Какие части связаны

**Сайт:** HTML/CSS → `js/app.js` → `js/backend-client.js` → HTTP → `online/api.mjs` → `domain.mjs` / `auth.mjs` / `store.mjs` → JSON → DOM.

**SQL:** исходный JSON → загрузка каталога в таблицы; регистрация → аккаунт/сессия; сохранение состава → запись с владельцем. localStorage отдельно хранит избранное, сравнение и текущий несохранённый выбор браузера.

**Python:** `desktop_app.py` → модули `backend/` → расчёт и локальный JSON/TXT-файл. Это самостоятельное приложение, не исполняемый код облачного JavaScript-сервера.

**Облако:** `tools/build-online.mjs` собирает Worker; `drizzle/` хранит миграции D1. Файл настройки не доказывает, что новая версия уже опубликована. Прежняя опубликованная версия и новая локальная версия с аккаунтами различаются, пока обновление отдельно не размещено.

Начните с [README](README.md), затем прочитайте [разбор](FRONTEND_BACKEND_GUIDE.md) и [сценарий защиты](DEFENSE.md).
