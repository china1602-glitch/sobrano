"""Печатный HTML-отчёт из SQLite. PDF сохраняется средствами браузера."""
from html import escape


def hours(minutes):
    return f"{minutes // 60} ч {minutes % 60:02d} мин"


def render_report(state, start="", end=""):
    esc = lambda value: escape(str(value), quote=True)
    profile = state["profile"]
    entries = list(reversed(state["entries"]))
    total = sum(e["minutes"] for e in entries)
    hour_minutes = profile.get("hour_minutes", 60)
    unit = "акад. ч" if hour_minutes == 45 else "ч"
    unit_description = "Академический час — 45 минут" if hour_minutes == 45 else "Астрономический час — 60 минут"
    credited = lambda minutes: f"{minutes / hour_minutes:.2f}".rstrip("0").rstrip(".").replace(".", ",")
    demo = '<p class="demo">УЧЕБНЫЙ ПРИМЕР · Вымышленные записи для демонстрации интерфейса</p>' if state["mode"] == "demo" else ""
    profile_rows = "".join(f"<div><dt>{label}</dt><dd>{esc(profile[key] or 'Не заполнено')}</dd></div>" for key, label in
                           [("name", "Студент"), ("group", "Группа"), ("specialty", "Специальность"),
                            ("organization", "Место практики"), ("supervisor", "Руководитель")])
    rows = "".join(f'<tr><td>{esc(e["date"])}</td><td>{esc(e["description"])}</td><td>{esc(e["start_time"])}–{esc(e["end_time"])}<br><small>Перерыв {e["break_minutes"]} мин</small></td><td>{hours(e["minutes"])}<br><small>Учёт: {credited(e["minutes"])} {unit}</small></td></tr>' for e in entries)
    if not rows:
        rows = '<tr><td colspan="4">За выбранный период записей нет.</td></tr>'
    return f'''<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Дневник практики — Практикум</title><link rel="stylesheet" href="/css/report.css"><script defer src="/js/report.js"></script></head>
<body><nav class="tools"><a href="/reports.html">← К отчётам</a><button id="print" type="button">Печать / сохранить PDF</button></nav>
<main>{demo}<div class="kicker">ПРАКТИКУМ / ЛИЧНЫЙ ДНЕВНИК</div><h1>Отчёт о практике</h1><p>Период: {esc(start or 'все даты')} — {esc(end or 'все даты')}</p>
<dl>{profile_rows}</dl><p>Единица учёта: {unit_description}. План: {profile["target_hours"]} {unit}.</p>
<p class="total">Фактически: <strong>{hours(total)}</strong> · Учтено: <strong>{credited(total)} {unit}</strong> · Рабочих дней: <strong>{len(entries)}</strong></p>
<table><thead><tr><th>Дата</th><th>Выполненная работа</th><th>Время</th><th>Фактически / учёт</th></tr></thead><tbody>{rows}</tbody></table>
<p class="note">Отчёт составлен по записям пользователя. Это личный дневник; требования к официальному оформлению определяет колледж. Подписи и подтверждение руководителя приложение не создаёт.</p>
</main></body></html>'''
