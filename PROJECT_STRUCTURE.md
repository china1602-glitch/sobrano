# Структура проекта «СОБРАНО»

Исходники находятся в `C:\Users\Студент\sobrano-work\github`. Фронтенд, бэкенд и данные разделены по файлам. Резервная копия `../local/` в публикацию не входит и не изменяется.

Репозиторий: https://github.com/china1602-glitch/sobrano
Статический сайт: https://china1602-glitch.github.io/sobrano/

## Дерево папок

```text
github/
├── index.html                  Главная
├── catalog.html                Каталог
├── product.html                Карточка модели
├── builds.html                 Готовые сборки
├── build.html                  Карточка сборки
├── builder.html                Конфигуратор
├── compare.html                Сравнение
├── favorites.html              Избранное
├── about.html                  Данные, цены, фото и ограничения
├── css/
│   └── style.css               Оформление, две темы, адаптивность
├── js/
│   ├── bootstrap.js            Выбор режима и загрузка модулей
│   ├── app.js                  Страницы и действия пользователя
│   ├── backend-client.js       Запросы к Python API
│   ├── core.js                 Модели, характеристики, состав и статическая проверка
│   ├── catalog-ui.js           Форма фильтров и статический поиск/сортировка
│   ├── compatibility.js        Статический подбор кандидатов
│   ├── pricing.js              Статические цены и бюджет
│   ├── media.js                Вывод фото, подписей и заглушек
│   └── product-images.js       Соответствие изображений моделям и источникам
├── backend/
│   ├── __init__.py             Python-пакет backend
│   ├── catalog.py              Чтение JSON, поиск и фильтрация
│   ├── compatibility.py        Проверка состава и кандидатов на Python
│   └── pricing.py              Выбор цены и расчёт бюджета на Python
├── server.py                  HTTP-сервер сайта и API
├── runtime.json               Режим static для GitHub Pages
├── data/
│   ├── catalog.json            190 моделей, 22 сборки и метаданные фото
│   └── offers.json             8 датированных предложений магазинов
├── assets/
│   ├── favicon.svg             Значок сайта
│   └── fonts/                  Manrope: кириллица, латиница и OFL.txt
├── tests/
│   ├── *.test.cjs              Тесты JavaScript и API-клиента
│   ├── test_*.py               Тесты Python, HTTP и целостности проекта
│   └── browser-smoke.cjs       Проверка в настоящем Chrome
├── docs/
│   ├── COMPATIBILITY.md        Правила и границы проверки комплектующих
│   ├── PRICE-SOURCES.md        Источники цен
│   ├── PHOTO-SOURCES.md        Источники и подписи изображений
│   ├── DEFENSE.md              Подробный запуск F5 и точки останова
│   ├── FINAL_REPORT.md         Отчёт предыдущего этапа восстановления
│   ├── PUBLICATION.md          Публикация Pages и проверка двух режимов
│   ├── QA.md                   Исторический журнал проверок
│   ├── TASKS.md                История работ и ограничения данных
│   └── screenshots/            Контрольные снимки интерфейса
├── .vscode/
│   ├── extensions.json         Бесплатные расширения для отладки
│   ├── launch.json             Запуск Python через F5
│   ├── tasks.json              Запуск сайта и тестов через меню
│   └── settings.json           Скрытие двоичного Python-кэша
├── .gitignore                 Исключение секретов, кэша и временных файлов
├── .nojekyll                   Публикация готовых статических файлов без Jekyll
├── README.md                  Запуск и основные возможности
├── DEFENSE.md                 Демонстрация двух вариантов на 5–7 минут
├── FRONTEND_BACKEND_GUIDE.md   Разбор файлов, API и архитектуры
└── PROJECT_STRUCTURE.md       Эта карта исходников
```

`.git/` содержит историю и настройки Git, а не код сайта. Виртуальное окружение для запуска не требуется. Python-кэш и секретные конфигурации не входят в коммит.

## Как связаны части

HTML содержит общую структуру девяти страниц. CSS задаёт оформление. JavaScript строит содержимое выбранного раздела, обрабатывает формы и хранит пользовательский выбор в localStorage.

В статическом режиме bootstrap читает `runtime.json`, `data/catalog.json` и `data/offers.json`. Поиск, цены и совместимость вычисляют клиентские JS-модули. Все пути вычисляются относительно папки сайта, включая `/sobrano/`.

При запуске `server.py` адрес `/runtime.json` возвращает `python`, не меняя файл на диске. Браузер получает каталог и результаты через API. Сервер читает те же JSON; функции `backend/` ищут модели, проверяют состав и рассчитывают бюджет.

## Быстро открыть и запустить

```powershell
code "$HOME\sobrano-work\github"
cd "$HOME\sobrano-work\github"
python server.py
```

Откройте http://127.0.0.1:8080/. Если порт занят: `python server.py --port 8081`. Остановка — Ctrl+C.

Для статической проверки без API проекта:

```powershell
python -B -m http.server 8000 --bind 127.0.0.1
```

Откройте http://127.0.0.1:8000/. На Pages не нужен запущенный локальный сервер.

## Что показать в редакторе

1. `catalog.html` — HTML.
2. `css/style.css` — стили и мобильные правила.
3. `js/app.js` — обработчик выбора и рендеринг.
4. `js/backend-client.js` — POST запроса состава.
5. `server.py` — маршрут `/api/configuration`.
6. `backend/compatibility.py` — функции `assess` и `check`.
7. `data/catalog.json` — исходные данные.

Подробный маршрут запроса и вопросы преподавателя — [FRONTEND_BACKEND_GUIDE.md](FRONTEND_BACKEND_GUIDE.md). Сценарий выступления — [DEFENSE.md](DEFENSE.md).
