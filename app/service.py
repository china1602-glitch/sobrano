"""Бизнес-логика. Не зависит от браузера или HTTP-сервера."""
import csv
import io
import json
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GUIDES = json.loads((ROOT / "data" / "guides.json").read_text(encoding="utf-8"))
SKILLS = {g["id"] for g in GUIDES}
DEFAULT_PROFILE = {"name": "", "group": "", "specialty": "", "organization": "",
                   "supervisor": "", "start_date": "", "end_date": "", "target_hours": 144}


class AppError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def text(value, label, limit=200, required=False):
    if not isinstance(value, str):
        raise AppError(f"{label}: ожидается текст.")
    value = value.strip()
    if required and not value:
        raise AppError(f"Заполните поле «{label}».")
    if len(value) > limit:
        raise AppError(f"{label}: не более {limit} символов.")
    return value


def iso_date(value, label="Дата", optional=False):
    if optional and value == "":
        return ""
    try:
        if not isinstance(value, str) or len(value) != 10:
            raise ValueError()
        return date.fromisoformat(value).isoformat()
    except (ValueError, TypeError):
        raise AppError(f"{label}: укажите корректную дату.") from None


def integer(value, label, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise AppError(f"{label}: целое число от {low} до {high}.")
    return value


def calculate_minutes(start, end, pause):
    """Вернуть фактическое рабочее время в минутах, исключив перерыв."""
    def clock(value):
        try:
            if not isinstance(value, str) or len(value) != 5:
                raise ValueError()
            moment = datetime.strptime(value, "%H:%M")
            return moment.hour * 60 + moment.minute
        except (ValueError, TypeError):
            raise AppError("Время укажите в формате ЧЧ:ММ.") from None
    duration = clock(end) - clock(start)
    pause = integer(pause, "Перерыв", 0, 720)
    if duration <= 0:
        raise AppError("Окончание должно быть позже начала в тот же день.")
    if pause >= duration:
        raise AppError("Перерыв должен быть короче рабочего дня.")
    if duration - pause > 12 * 60:
        raise AppError("Одна запись может содержать не более 12 часов работы.")
    return duration - pause


def validate_profile(data):
    if not isinstance(data, dict):
        raise AppError("Настройки практики должны быть объектом JSON.")
    result = {k: text(data.get(k, ""), label, 160) for k, label in
              [("name", "ФИО"), ("group", "Группа"), ("specialty", "Специальность"),
               ("organization", "Организация"), ("supervisor", "Руководитель")]}
    result["start_date"] = iso_date(data.get("start_date", ""), "Начало практики", True)
    result["end_date"] = iso_date(data.get("end_date", ""), "Конец практики", True)
    if result["start_date"] and result["end_date"] and result["start_date"] > result["end_date"]:
        raise AppError("Конец практики не может быть раньше начала.")
    result["target_hours"] = integer(data.get("target_hours", 144), "План часов", 1, 2000)
    return result


def validate_task(data):
    result = {"title": text(data.get("title", ""), "Название задачи", 160, True),
              "description": text(data.get("description", ""), "Описание", 4000),
              "due_date": iso_date(data.get("due_date", ""), "Срок", True)}
    for key, allowed, default in [("priority", {"low", "normal", "high"}, "normal"),
                                  ("status", {"todo", "doing", "done"}, "todo"),
                                  ("skill", SKILLS | {""}, "")]:
        result[key] = data.get(key, default)
        if not isinstance(result[key], str) or result[key] not in allowed:
            raise AppError(f"Некорректное значение поля {key}.")
    return result


def validate_entry(data, profile, today=None):
    day = iso_date(data.get("date"))
    if day > (today or date.today()).isoformat():
        raise AppError("Нельзя записать отработанные часы за будущий день.")
    if profile["start_date"] and day < profile["start_date"]:
        raise AppError("Дата записи раньше начала практики. Измените дату или период в настройках.")
    if profile["end_date"] and day > profile["end_date"]:
        raise AppError("Дата записи позже конца практики. Измените дату или период в настройках.")
    start, end, pause = data.get("start_time"), data.get("end_time"), data.get("break_minutes", 0)
    minutes = calculate_minutes(start, end, pause)
    skill = data.get("skill", "")
    if not isinstance(skill, str) or skill not in SKILLS | {""}:
        raise AppError("Выберите существующее направление.")
    task_id = data.get("task_id") or None
    if task_id is not None:
        integer(task_id, "Задача", 1, 2**31 - 1)
    return {"date": day, "start_time": start, "end_time": end, "break_minutes": pause,
            "minutes": minutes, "description": text(data.get("description", ""), "Выполненная работа", 5000, True),
            "skill": skill, "task_id": task_id}


class Store:
    def __init__(self, directory=None, mode="personal"):
        if mode not in ("personal", "demo"):
            raise AppError("Неизвестный режим.")
        self.mode = mode
        self.directory = Path(directory or ROOT / "storage")
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / f"{mode}.sqlite3"
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK(id=1), content TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL,
                    due_date TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL, skill TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS entries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL UNIQUE, start_time TEXT NOT NULL,
                    end_time TEXT NOT NULL, break_minutes INTEGER NOT NULL, minutes INTEGER NOT NULL CHECK(minutes>0),
                    description TEXT NOT NULL, skill TEXT NOT NULL,
                    task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL);
            """)
            if not db.execute("SELECT 1 FROM meta").fetchone():
                db.execute("INSERT INTO meta VALUES (1, 0)")
                db.execute("INSERT INTO profile VALUES (1, ?)", (json.dumps(DEFAULT_PROFILE, ensure_ascii=False),))
                if mode == "demo":
                    self._seed(db)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def _seed(self, db):
        today = date.today()
        start = today - timedelta(days=14)
        p = dict(DEFAULT_PROFILE, name="Учебный пример", group="ИТ · пример",
                 specialty="Разработка программного обеспечения", start_date=start.isoformat(),
                 end_date=(today + timedelta(days=20)).isoformat())
        db.execute("UPDATE profile SET content=?", (json.dumps(p, ensure_ascii=False),))
        tasks = [
            ("Познакомиться с рабочим процессом", "Записать инструменты команды и правила работы с задачами.", -10, "normal", "done", "team"),
            ("Сверстать форму обратной связи", "Добавить подписи, состояния фокуса и адаптивную вёрстку.", -4, "high", "done", "web"),
            ("Спроектировать базу задач", "Выделить таблицы, первичные и внешние ключи.", -1, "high", "doing", "data"),
            ("Проверить сохранение формы", "Проверить пустые поля, граничные значения и повторную отправку.", 1, "high", "todo", "testing"),
            ("Подготовить инструкцию запуска", "Проверить инструкцию на чистой папке проекта.", 3, "normal", "todo", "docs"),
            ("Сделать отдельную ветку для исправления", "Создать ветку, внести правку и описать результат коммита.", 4, "low", "todo", "git")]
        for title, desc, offset, priority, status, skill in tasks:
            db.execute("INSERT INTO tasks(title,description,due_date,priority,status,skill) VALUES(?,?,?,?,?,?)",
                       (title, desc, (today + timedelta(days=offset)).isoformat(), priority, status, skill))
        descriptions = [
            ("Изучены правила ведения задач. Составлен список инструментов для работы с проектом.", "team", 1),
            ("Подготовлена структура HTML-страницы и форма с подписями полей.", "web", 2),
            ("Добавлены стили формы, состояния фокуса и мобильное представление.", "web", 2),
            ("Создана схема таблиц задач и записей дневника; настроен внешний ключ.", "data", 3),
            ("Проверены запросы выборки и сохранение данных между перезапусками.", "data", 3),
            ("Составлены сценарии проверки обязательных полей и ошибочных значений.", "testing", 4)]
        days = [start + timedelta(days=n) for n in range(14) if (start + timedelta(days=n)).weekday() < 5][-6:]
        for day, (desc, skill, task_id) in zip(days, descriptions):
            db.execute("""INSERT INTO entries(date,start_time,end_time,break_minutes,minutes,description,skill,task_id)
                          VALUES(?, '09:00', '15:30', 30, 360, ?, ?, ?)""", (day.isoformat(), desc, skill, task_id))

    @staticmethod
    def _profile(db):
        return json.loads(db.execute("SELECT content FROM profile WHERE id=1").fetchone()[0])

    def state(self, query=None):
        query = query or {}
        for key, allowed in [("status", {"", "todo", "doing", "done"}),
                             ("priority", {"", "low", "normal", "high"}),
                             ("sort", {"", "new", "due", "priority"})]:
            if query.get(key, "") not in allowed:
                raise AppError(f"Неверный фильтр {key}.")
        with self.connect() as db:
            db.execute("BEGIN")  # согласованный снимок даже при запросе из другой вкладки
            tasks = [dict(r) for r in db.execute("SELECT * FROM tasks ORDER BY id DESC")]
            entries = [dict(r) for r in db.execute("SELECT * FROM entries ORDER BY date DESC")]
            profile = self._profile(db)
            revision = db.execute("SELECT revision FROM meta").fetchone()[0]
        today = date.today()
        minutes = sum(e["minutes"] for e in entries)
        monday = today - timedelta(days=today.weekday())
        weekly = [{"date": (monday + timedelta(days=i)).isoformat(),
                   "minutes": sum(e["minutes"] for e in entries if e["date"] == (monday + timedelta(days=i)).isoformat())} for i in range(7)]
        stats = {"minutes": minutes, "days": len(entries), "completed": sum(t["status"] == "done" for t in tasks),
                 "tasks": len(tasks), "overdue": sum(t["status"] != "done" and bool(t["due_date"]) and t["due_date"] < today.isoformat() for t in tasks),
                 "weekly": weekly, "skills": {s: sum(e["minutes"] for e in entries if e["skill"] == s) for s in SKILLS}}
        filtered_tasks = [t for t in tasks if (not query.get("status") or t["status"] == query["status"])
                          and (not query.get("priority") or t["priority"] == query["priority"])
                          and query.get("q", "").casefold() in (t["title"] + " " + t["description"]).casefold()]
        sort = query.get("sort", "new")
        if sort == "due":
            filtered_tasks.sort(key=lambda t: (t["due_date"] or "9999", -t["id"]))
        if sort == "priority":
            filtered_tasks.sort(key=lambda t: ({"high": 0, "normal": 1, "low": 2}[t["priority"]], -t["id"]))
        first = iso_date(query.get("from", ""), "Начало периода", True)
        last = iso_date(query.get("to", ""), "Конец периода", True)
        if first and last and first > last:
            raise AppError("Начало периода позже конца.")
        filtered_entries = [e for e in entries if (not first or e["date"] >= first) and (not last or e["date"] <= last)
                            and query.get("entry_q", "").casefold() in e["description"].casefold()]
        return {"mode": self.mode, "revision": revision, "profile": profile, "stats": stats,
                "tasks": filtered_tasks, "entries": filtered_entries, "guides": GUIDES,
                "allTasks": [{"id": t["id"], "title": t["title"]} for t in tasks], "today": today.isoformat()}

    def mutate(self, resource, method, data, revision, item_id=None):
        if not isinstance(data, dict):
            raise AppError("Ожидается объект JSON.")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            actual = db.execute("SELECT revision FROM meta").fetchone()[0]
            if revision is None or str(actual) != str(revision):
                raise AppError("Данные изменились в другой вкладке. Обновите страницу и повторите действие.", 409)
            profile = self._profile(db)
            if resource == "profile" and method == "PUT":
                clean = validate_profile(data)
                for entry in db.execute("SELECT date FROM entries"):
                    if (clean["start_date"] and entry[0] < clean["start_date"]) or (clean["end_date"] and entry[0] > clean["end_date"]):
                        raise AppError("В дневнике есть записи за пределами нового периода. Сначала исправьте записи.")
                db.execute("UPDATE profile SET content=? WHERE id=1", (json.dumps(clean, ensure_ascii=False),))
            elif resource in ("tasks", "entries"):
                table = resource  # только из фиксированного набора выше
                if method in ("PUT", "DELETE"):
                    if not db.execute(f"SELECT 1 FROM {table} WHERE id=?", (item_id,)).fetchone():
                        raise AppError("Запись уже удалена.", 404)
                if method == "DELETE":
                    db.execute(f"DELETE FROM {table} WHERE id=?", (item_id,))
                elif method in ("POST", "PUT"):
                    clean = validate_task(data) if table == "tasks" else validate_entry(data, profile)
                    if table == "entries":
                        if clean["task_id"] and not db.execute("SELECT 1 FROM tasks WHERE id=?", (clean["task_id"],)).fetchone():
                            raise AppError("Связанная задача не найдена.")
                        if db.execute("SELECT 1 FROM entries WHERE date=? AND id!=?", (clean["date"], item_id or 0)).fetchone():
                            raise AppError("За этот день уже есть запись. Откройте её и дополните.", 409)
                    cols = list(clean)
                    if method == "POST":
                        cur = db.execute(f"INSERT INTO {table}({','.join(cols)}) VALUES({','.join('?' for _ in cols)})", tuple(clean.values()))
                        item_id = cur.lastrowid
                    else:
                        db.execute(f"UPDATE {table} SET {','.join(c+'=?' for c in cols)} WHERE id=?", (*clean.values(), item_id))
                else:
                    raise AppError("Метод не поддерживается.", 405)
            elif resource == "restore" and method == "POST":
                self._restore(db, data)
            else:
                raise AppError("Действие не найдено.", 404)
            db.execute("UPDATE meta SET revision=revision+1")
            return {"ok": True, "id": item_id, "revision": actual + 1}

    def backup(self):
        state = self.state()
        return {"format": "praktikum", "version": 1, "mode": self.mode,
                "exported_at": datetime.now().astimezone().isoformat(),
                "profile": state["profile"], "tasks": state["tasks"], "entries": state["entries"]}

    def _restore(self, db, data):
        if data.get("confirm") is not True:
            raise AppError("Подтвердите замену записей резервной копией.")
        blob = data.get("backup")
        if not isinstance(blob, dict) or blob.get("format") != "praktikum" or blob.get("version") != 1:
            raise AppError("Это не резервная копия Практикума версии 1.")
        if blob.get("mode") != self.mode:
            raise AppError("Режим резервной копии не совпадает. Личные и учебные данные восстанавливаются отдельно.")
        profile = validate_profile(blob.get("profile", {}))
        tasks, entries = blob.get("tasks"), blob.get("entries")
        if not isinstance(tasks, list) or not isinstance(entries, list) or len(tasks) > 10000 or len(entries) > 10000:
            raise AppError("Некорректный состав резервной копии.")
        clean_tasks, clean_entries, task_ids, days, entry_ids = [], [], set(), set(), set()
        for task in tasks:
            if not isinstance(task, dict):
                raise AppError("Повреждена задача в резервной копии.")
            tid = integer(task.get("id"), "ID задачи", 1, 2**31 - 1)
            if tid in task_ids:
                raise AppError("Повторяются идентификаторы задач.")
            task_ids.add(tid)
            clean_tasks.append(dict(id=tid, **validate_task(task)))
        for entry in entries:
            if not isinstance(entry, dict):
                raise AppError("Повреждена запись дневника.")
            eid = integer(entry.get("id"), "ID записи", 1, 2**31 - 1)
            clean = validate_entry(entry, profile)
            if clean["date"] in days or eid in entry_ids:
                raise AppError("В копии повторяются даты или идентификаторы записей.")
            if clean["task_id"] and clean["task_id"] not in task_ids:
                raise AppError("Запись ссылается на отсутствующую задачу.")
            days.add(clean["date"])
            entry_ids.add(eid)
            clean_entries.append(dict(id=eid, **clean))
        # Сохраняем предыдущее состояние до замены. Проверки выше ничего не меняют.
        backup_dir = self.directory / "backups"
        backup_dir.mkdir(exist_ok=True)
        old = {"format": "praktikum", "version": 1, "mode": self.mode,
               "profile": self._profile(db), "tasks": [dict(r) for r in db.execute("SELECT * FROM tasks")],
               "entries": [dict(r) for r in db.execute("SELECT * FROM entries")]}
        name = f"{self.mode}-before-restore-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.json"
        (backup_dir / name).write_text(json.dumps(old, ensure_ascii=False, indent=2), encoding="utf-8")
        db.execute("DELETE FROM entries")
        db.execute("DELETE FROM tasks")
        db.execute("UPDATE profile SET content=?", (json.dumps(profile, ensure_ascii=False),))
        for table, records in [("tasks", clean_tasks), ("entries", clean_entries)]:
            for record in records:
                db.execute(f"INSERT INTO {table}({','.join(record)}) VALUES({','.join('?' for _ in record)})", tuple(record.values()))

    def csv(self, query=None):
        state = self.state(query)
        output = io.StringIO(newline="")
        writer = csv.writer(output, delimiter=";")
        writer.writerow(["Дата", "Начало", "Конец", "Перерыв, мин", "Работа, мин", "Выполненная работа", "Направление"])
        names = {g["id"]: g["title"] for g in GUIDES}
        def safe(value):
            return "'" + value if value.lstrip().startswith(("=", "+", "-", "@")) else value
        for entry in reversed(state["entries"]):
            writer.writerow([entry["date"], entry["start_time"], entry["end_time"], entry["break_minutes"],
                             entry["minutes"], safe(entry["description"]), names.get(entry["skill"], "Не указано")])
        return ("\ufeff" + output.getvalue()).encode("utf-8")
