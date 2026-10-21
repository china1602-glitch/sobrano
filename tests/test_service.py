import copy
import csv
import io
import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

from app.service import AppError, Store, calculate_minutes
from app.reports import render_report


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(self.tmp.name)
        self.task = dict(title="Проверить форму", description="Пустое поле", due_date="", priority="high", status="todo", skill="testing")
        self.entry = dict(date=date.today().isoformat(), start_time="09:00", end_time="15:30", break_minutes=30,
                          description="Проверены обязательные поля формы", skill="testing", task_id=None)

    def save(self, resource, data, method="POST", item_id=None):
        return self.store.mutate(resource, method, data, self.store.state()["revision"], item_id)

    def test_new_personal_database_is_empty(self):
        state = self.store.state()
        self.assertEqual((state["tasks"], state["entries"], state["stats"]["minutes"]), ([], [], 0))

    def test_time_calculated_on_python(self):
        self.assertEqual(calculate_minutes("09:00", "15:30", 30), 360)
        self.assertEqual(calculate_minutes("09:00", "09:01", 0), 1)
        self.assertEqual(calculate_minutes("08:00", "20:30", 30), 720)

    def test_invalid_times_are_rejected(self):
        for start, end, pause in [("15:00","09:00",0),("09:00","09:00",0),("09:00","10:00",60),
                                  ("24:00","25:00",0),("9:00","10:00",0),("00:00","23:00",0),("09:00","10:00",True)]:
            with self.subTest((start,end,pause)), self.assertRaises(AppError):
                calculate_minutes(start,end,pause)

    def test_task_crud_and_persistence(self):
        result = self.save("tasks", self.task)
        other = Store(self.tmp.name)
        self.assertEqual(other.state()["tasks"][0]["title"], self.task["title"])
        self.save("tasks", dict(self.task, status="done"), "PUT", result["id"])
        self.assertEqual(self.store.state()["stats"]["completed"], 1)
        self.save("tasks", {}, "DELETE", result["id"])
        self.assertEqual(self.store.state()["tasks"], [])

    def test_entry_crud_and_server_recalculates_minutes(self):
        result = self.save("entries", dict(self.entry, minutes=999999))
        self.assertEqual(self.store.state()["stats"]["minutes"], 360)
        self.save("entries",dict(self.entry,end_time="17:00"),"PUT",result["id"])
        self.assertEqual(self.store.state()["stats"]["minutes"], 450)
        self.save("entries",{},"DELETE",result["id"])
        self.assertEqual(self.store.state()["stats"]["minutes"], 0)

    def test_duplicate_day_rolls_back(self):
        self.save("entries",self.entry)
        revision = self.store.state()["revision"]
        with self.assertRaisesRegex(AppError,"уже есть запись"):
            self.save("entries",self.entry)
        state=self.store.state()
        self.assertEqual(len(state["entries"]),1)
        self.assertEqual(state["revision"],revision)

    def test_future_and_outside_period_rejected(self):
        tomorrow=(date.today()+timedelta(days=1)).isoformat()
        with self.assertRaisesRegex(AppError,"будущий"):
            self.save("entries",dict(self.entry,date=tomorrow))
        p=dict(self.store.state()["profile"], start_date=date.today().isoformat())
        self.save("profile",p,"PUT")
        with self.assertRaisesRegex(AppError,"раньше начала"):
            self.save("entries",dict(self.entry,date=(date.today()-timedelta(days=1)).isoformat()))

    def test_period_cannot_exclude_existing_record(self):
        self.save("entries",self.entry)
        p=dict(self.store.state()["profile"], end_date=(date.today()-timedelta(days=1)).isoformat())
        with self.assertRaisesRegex(AppError,"за пределами"):
            self.save("profile",p,"PUT")
        self.assertEqual(self.store.state()["profile"]["end_date"],"")

    def test_delete_task_preserves_diary(self):
        task=self.save("tasks",self.task)
        self.save("entries",dict(self.entry,task_id=task["id"]))
        self.save("tasks",{},"DELETE",task["id"])
        self.assertIsNone(self.store.state()["entries"][0]["task_id"])
        self.assertEqual(self.store.state()["stats"]["minutes"],360)

    def test_stale_request_does_not_overwrite(self):
        self.save("tasks",self.task)
        with self.assertRaises(AppError) as raised:
            self.store.mutate("tasks","POST",dict(self.task,title="Старая вкладка"),0)
        self.assertEqual(raised.exception.status,409)
        self.assertEqual(len(self.store.state()["tasks"]),1)

    def test_demo_is_separate_from_personal(self):
        demo=Store(self.tmp.name,"demo")
        self.assertEqual(demo.state()["stats"]["minutes"],2160)
        self.assertEqual(demo.state()["stats"]["days"],6)
        self.save("tasks",self.task)
        self.assertEqual(len(demo.state()["tasks"]),6)
        self.assertEqual(len(self.store.state()["tasks"]),1)

    def test_task_filters_are_on_server(self):
        self.save("tasks",self.task)
        self.save("tasks",dict(self.task,title="Написать инструкцию",priority="low",status="done"))
        self.assertEqual(len(self.store.state({"q":"ФОРМУ","status":"todo"})["tasks"]),1)
        self.assertEqual(self.store.state({"sort":"priority"})["tasks"][0]["priority"],"high")
        self.assertEqual(self.store.state({"q":"несуществующее"})["tasks"],[])
        self.assertEqual(self.store.state({"status":"done"})["stats"]["tasks"],2)

    def test_report_and_csv_range_and_escaping(self):
        self.save("entries",dict(self.entry,description='=SUM(A1) <script>alert(1)</script>'))
        csv=self.store.csv().decode("utf-8-sig")
        self.assertIn("'=SUM(A1)",csv)
        report=render_report(self.store.state())
        self.assertNotIn('<script>alert(1)</script>',report)
        self.assertIn('&lt;script&gt;',report)
        past=(date.today()-timedelta(days=1)).isoformat()
        self.assertEqual(self.store.state({"to":past})["entries"],[])
        with self.assertRaises(AppError):
            self.store.state({"from":date.today().isoformat(),"to":past})

    def test_backup_restore_preserves_ids_and_makes_previous_copy(self):
        t=self.save("tasks",self.task)
        self.save("entries",dict(self.entry,task_id=t["id"]))
        backup=self.store.backup()
        self.save("tasks",{},"DELETE",t["id"])
        self.save("restore",{"backup":backup,"confirm":True})
        state=self.store.state()
        self.assertEqual(state["entries"][0]["task_id"],t["id"])
        self.assertEqual(state["tasks"][0]["id"],t["id"])
        self.assertEqual(len(list((Path(self.tmp.name)/"backups").glob('*.json'))),1)

    def test_invalid_import_rolls_back_all_records(self):
        self.save("entries",self.entry)
        backup=self.store.backup()
        broken=copy.deepcopy(backup)
        broken["entries"].append(dict(broken["entries"][0],id=9))
        with self.assertRaises(AppError):
            self.save("restore",{"backup":broken,"confirm":True})
        self.assertEqual(self.store.backup()["entries"],backup["entries"])
        self.assertFalse((Path(self.tmp.name)/"backups").exists())

    def test_demo_backup_cannot_replace_personal_data(self):
        backup=Store(self.tmp.name,"demo").backup()
        with self.assertRaisesRegex(AppError,"Режим"):
            self.save("restore",{"backup":backup,"confirm":True})
        self.assertEqual(self.store.state()["tasks"],[])

    def test_required_and_invalid_values(self):
        for patch in [{"title":"  "},{"title":14},{"description":"a"*4001},{"due_date":"2026-02-30"}, {"priority":"urgent"},{"skill":"fake"}]:
            with self.subTest(patch),self.assertRaises(AppError):
                self.save("tasks",dict(self.task,**patch))
        with self.assertRaises(AppError):
            self.save("entries",dict(self.entry,task_id=9999))
        self.assertEqual(self.store.state()["revision"],0)

    def test_old_sqlite_profile_defaults_to_sixty_without_touching_records(self):
        self.save("entries", self.entry)
        before = self.store.state()
        old_profile = dict(before["profile"])
        old_profile.pop("hour_minutes")
        with self.store.connect() as db:
            db.execute("UPDATE profile SET content=? WHERE id=1", (json.dumps(old_profile),))
        state = Store(self.tmp.name).state()
        self.assertEqual(state["profile"]["hour_minutes"], 60)
        self.assertEqual(state["stats"]["credited_hours"], 6)
        self.assertEqual(state["stats"]["target_minutes"], 144 * 60)
        self.assertEqual(state["entries"], before["entries"])
        self.assertEqual(state["revision"], before["revision"])
        self.assertEqual(self.store.backup()["profile"]["hour_minutes"], 60)

    def test_changing_hour_unit_updates_plan_without_changing_actual_minutes(self):
        self.save("entries", dict(self.entry, end_time="17:30", break_minutes=60))
        profile = dict(self.store.state()["profile"], target_hours=10, hour_minutes=45)
        self.save("profile", profile, "PUT")
        state = self.store.state()
        self.assertEqual(state["stats"]["minutes"], 450)
        self.assertEqual(state["stats"]["hour_minutes"], 45)
        self.assertEqual(state["stats"]["credited_hours"], 10)
        self.assertEqual(state["stats"]["target_minutes"], 450)
        self.assertEqual(state["stats"]["remaining_minutes"], 0)
        self.assertEqual(state["stats"]["progress_percent"], 100)
        self.assertEqual(state["stats"]["skills"]["testing"], 450)
        self.assertEqual(sum(day["minutes"] for day in state["stats"]["weekly"]), 450)
        self.save("profile", dict(profile, hour_minutes=60), "PUT")
        state = self.store.state()
        self.assertEqual(state["stats"]["credited_hours"], 7.5)
        self.assertEqual(state["stats"]["target_minutes"], 600)
        self.assertEqual(state["stats"]["remaining_minutes"], 150)
        self.assertEqual(state["stats"]["progress_percent"], 75)
        self.assertEqual(state["entries"][0]["minutes"], 450)
        self.save("profile", dict(profile, target_hours=1, hour_minutes=60), "PUT")
        self.assertEqual(self.store.state()["stats"]["progress_percent"], 750)
        self.assertEqual(self.store.state()["stats"]["remaining_minutes"], 0)

    def test_old_profile_update_preserves_selected_unit_but_old_backup_uses_sixty(self):
        self.save("entries", self.entry)
        profile = dict(self.store.state()["profile"], hour_minutes=45)
        self.save("profile", profile, "PUT")
        profile.pop("hour_minutes")
        self.save("profile", dict(profile, name="Другое имя"), "PUT")
        self.assertEqual(self.store.state()["profile"]["hour_minutes"], 45)
        backup = self.store.backup()
        backup["profile"].pop("hour_minutes")
        self.save("restore", {"backup": backup, "confirm": True})
        state = self.store.state()
        self.assertEqual(state["profile"]["hour_minutes"], 60)
        self.assertEqual(state["stats"]["minutes"], 360)
        self.assertEqual(state["stats"]["credited_hours"], 6)

    def test_hour_unit_only_accepts_integer_fortyfive_or_sixty(self):
        profile = self.store.state()["profile"]
        for value in (0, 30, 46, 75, "45", True, None, 45.0, [], {}):
            with self.subTest(value=value), self.assertRaisesRegex(AppError, "45 или 60"):
                self.save("profile", dict(profile, hour_minutes=value), "PUT")
        self.assertEqual(self.store.state()["revision"], 0)

    def test_academic_report_and_csv_keep_actual_minutes_and_label_credited_time(self):
        self.save("entries", self.entry)
        self.save("profile", dict(self.store.state()["profile"], hour_minutes=45), "PUT")
        state = self.store.state()
        report = render_report(state)
        self.assertIn("Фактически:", report)
        self.assertIn("6 ч 00 мин", report)
        self.assertIn("8 акад. ч", report)
        self.assertIn("Академический час — 45 минут", report)
        rows = list(csv.reader(io.StringIO(self.store.csv().decode("utf-8-sig")), delimiter=";"))
        self.assertEqual(rows[0][4], "Фактическая работа, мин")
        self.assertEqual(rows[1][4], "360")
        self.assertEqual(rows[1][7], "8")
        self.assertEqual(rows[1][8], "Академический час (45 минут)")
        self.save("profile", dict(state["profile"], hour_minutes=60), "PUT")
        report = render_report(self.store.state())
        self.assertIn("Астрономический час — 60 минут", report)
        self.assertNotIn("акад. ч", report)

    def test_calendar_leap_month_period_and_totals_exclude_other_month(self):
        profile = dict(self.store.state()["profile"], start_date="2000-02-10", end_date="2000-03-03", hour_minutes=45)
        self.save("profile", profile, "PUT")
        entry = self.save("entries", dict(self.entry, date="2000-02-29", description="<b>Текст работы</b>"))
        self.save("entries", dict(self.entry, date="2000-03-01"))
        month = self.store.calendar("2000-02")
        self.assertEqual(len(month["days"]), 29)
        self.assertEqual(month["days"][0]["date"], "2000-02-01")
        self.assertFalse(month["days"][8]["within_period"])
        self.assertTrue(month["days"][9]["within_period"])
        self.assertIsNone(month["days"][0]["entry_id"])
        self.assertEqual(month["days"][0]["description"], "")
        self.assertEqual(month["days"][-1]["entry_id"], entry["id"])
        self.assertEqual(month["days"][-1]["description"], "<b>Текст работы</b>")
        self.assertEqual(month["days"][-1]["skill"], "testing")
        self.assertEqual(month["totals"], {"minutes": 360, "credited_hours": 8, "days": 1})
        self.assertEqual(month["revision"], self.store.state()["revision"])
        march = self.store.calendar("2000-03")
        self.assertEqual(march["totals"]["days"], 1)
        self.assertTrue(march["days"][2]["within_period"])
        self.assertFalse(march["days"][3]["within_period"])

    def test_calendar_current_month_future_markers_and_empty_period(self):
        with patch("app.service.date", wraps=date) as clock:
            clock.today.return_value = date(2026, 1, 15)
            month = self.store.calendar()
        self.assertEqual(month["month"], "2026-01")
        self.assertEqual(month["today"], "2026-01-15")
        self.assertEqual(len(month["days"]), 31)
        self.assertFalse(month["days"][14]["is_future"])
        self.assertTrue(month["days"][15]["is_future"])
        self.assertTrue(all(day["within_period"] for day in month["days"]))
        self.assertTrue(all(day["minutes"] == 0 for day in month["days"]))
        self.assertEqual(month["totals"], {"minutes": 0, "credited_hours": 0, "days": 0})
        self.assertEqual(len(self.store.calendar("2025-02")["days"]), 28)

    def test_calendar_strict_month_and_year_boundaries(self):
        for value in ("", "2026-1", "2026-01-01", "2026-00", "2026-13", "1999-12", "2101-01",
                      "２０２６-０１", "2026-01 ", True, 202601, []):
            with self.subTest(value=value), self.assertRaises(AppError):
                self.store.calendar(value)
        self.assertEqual(len(self.store.calendar("2000-01")["days"]), 31)
        self.assertEqual(len(self.store.calendar("2100-02")["days"]), 28)
        self.assertEqual(self.store.state()["revision"], 0)


if __name__ == '__main__':
    unittest.main()
