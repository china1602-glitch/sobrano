import json
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from datetime import date

from server import create_server


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.server = create_server(0,cls.tmp.name)
        cls.thread = threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.tmp.cleanup()

    def call(self, path, method="GET", data=None, headers=None):
        request = Request(self.url+path, data=json.dumps(data).encode() if data is not None else None,
                          method=method, headers=headers or {})
        try:
            response = urlopen(request)
        except HTTPError as error:
            response=error
        with response:
            return response.status,response.headers,response.read()

    def state(self):
        return json.loads(self.call('/api/state')[2])

    def headers(self):
        return {'Content-Type':'application/json','X-Praktikum-Request':'1','If-Match':str(self.state()['revision'])}

    def test_health_and_static_pages(self):
        status,headers,body=self.call('/api/health')
        self.assertEqual(status,200)
        self.assertIn('python',json.loads(body))
        for path in ['/', '/tasks.html','/diary.html','/guides.html','/reports.html','/settings.html','/assets/web.svg','/css/style.css','/js/app.js']:
            with self.subTest(path):
                self.assertEqual(self.call(path)[0],200)

    def test_private_files_not_served(self):
        for path in ['/server.py','/app/service.py','/storage/personal.sqlite3','/../server.py','/data/guides.json']:
            with self.subTest(path):
                self.assertEqual(self.call(path)[0],404)

    def test_http_crud_and_csv(self):
        status,_,body=self.call('/api/tasks','POST',{'title':'HTTP test'},self.headers())
        self.assertEqual(status,201)
        tid=json.loads(body)['id']
        self.assertTrue(any(t['id']==tid for t in self.state()['tasks']))
        self.assertEqual(self.call(f'/api/tasks/{tid}','PUT',{'title':'Updated','status':'done'},self.headers())[0],200)
        self.assertEqual(self.call(f'/api/tasks/{tid}','DELETE',{},self.headers())[0],200)
        status,headers,body=self.call('/api/csv')
        self.assertEqual(status,200)
        self.assertIn('attachment',headers['Content-Disposition'])
        self.assertTrue(body.startswith(b'\xef\xbb\xbf'))

    def test_cross_origin_and_missing_marker_rejected(self):
        headers=self.headers()
        headers['Origin']='https://example.com'
        self.assertEqual(self.call('/api/tasks','POST',{'title':'X'},headers)[0],403)
        self.assertEqual(self.call('/api/tasks','POST',{'title':'X'},{'Content-Type':'application/json'})[0],403)

    def test_wrong_json_and_schema_rejected(self):
        for data in [[],None,{'title':[]},{'title':'X','skill':[]},{'title':'X','priority':{} }]:
            with self.subTest(data):
                self.assertEqual(self.call('/api/tasks','POST',data,self.headers())[0],400 if data is not None else 413)
        self.assertEqual(self.call('/api/profile','PUT',[],self.headers())[0],400)
        self.assertEqual(self.call('/api/restore','POST',{'confirm':True,'backup':{'format':'praktikum','version':1,'mode':'personal','profile':[]}},self.headers())[0],400)

    def test_stale_http_revision(self):
        status, _, body = self.call('/api/tasks','POST',{'title':'Stale'},{'Content-Type':'application/json','X-Praktikum-Request':'1','If-Match':'-1'})
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(body)["code"], "revision_conflict")

    def test_calendar_contract_and_month_validation(self):
        status, _, body = self.call('/api/calendar?mode=demo&month=2026-10')
        self.assertEqual(status, 200)
        calendar = json.loads(body)
        self.assertEqual(set(calendar), {"month", "today", "start_date", "end_date", "hour_minutes",
                                        "target_hours", "days", "totals", "revision"})
        self.assertEqual(calendar["month"], "2026-10")
        self.assertEqual(len(calendar["days"]), 31)
        self.assertEqual(calendar["days"][0]["date"], "2026-10-01")
        self.assertEqual(calendar["days"][-1]["date"], "2026-10-31")
        self.assertEqual(set(calendar["days"][0]), {"date", "minutes", "entry_id", "skill", "description", "within_period", "is_future"})
        self.assertEqual(self.call('/api/calendar')[0], 200)
        for query in ('month=', 'month=2026-1', 'month=2026-13', 'month=1999-12', 'month=2101-01', 'mode=other'):
            with self.subTest(query=query):
                self.assertEqual(self.call('/api/calendar?' + query)[0], 400)
        health = json.loads(self.call('/api/health')[2])
        self.assertEqual(health["version"], "1.1.0")

    def test_academic_hours_pass_through_http_state_and_calendar(self):
        profile = self.state()["profile"]
        academic = dict(profile, hour_minutes=45)
        try:
            self.assertEqual(self.call('/api/profile', 'PUT', academic, self.headers())[0], 200)
            state = self.state()
            self.assertEqual(state["profile"]["hour_minutes"], 45)
            self.assertEqual(state["stats"]["target_minutes"], academic["target_hours"] * 45)
            calendar = json.loads(self.call('/api/calendar')[2])
            self.assertEqual(calendar["hour_minutes"], 45)
            report = self.call('/api/report')[2].decode()
            self.assertIn("Академический час — 45 минут", report)
            self.assertEqual(self.call('/api/profile', 'PUT', dict(academic, hour_minutes=50), self.headers())[0], 400)
        finally:
            self.call('/api/profile', 'PUT', profile, self.headers())

    def test_duplicate_date_is_not_a_revision_conflict(self):
        entry = {"date": date.today().isoformat(), "start_time": "09:00", "end_time": "10:00",
                 "break_minutes": 0, "description": "Проверка повторной даты"}
        status, _, body = self.call('/api/entries', 'POST', entry, self.headers())
        self.assertEqual(status, 201)
        entry_id = json.loads(body)["id"]
        try:
            status, _, body = self.call('/api/entries', 'POST', entry, self.headers())
            self.assertEqual(status, 409)
            self.assertNotIn("code", json.loads(body))
        finally:
            self.call(f'/api/entries/{entry_id}', 'DELETE', {}, self.headers())

    def test_report_and_bad_ranges(self):
        status,headers,body=self.call('/api/report?mode=demo')
        self.assertEqual(status,200)
        self.assertIn('text/html',headers['Content-Type'])
        self.assertIn('УЧЕБНЫЙ ПРИМЕР',body.decode())
        self.assertEqual(self.call('/api/state?from=2026-10-30&to=2026-10-01')[0],400)
        self.assertEqual(self.call('/api/state?sort=arbitrary')[0],400)

    def test_bad_routes_and_security_headers(self):
        self.assertEqual(self.call('/api/unknown')[0],404)
        self.assertEqual(self.call('/api/tasks/2','POST',{},self.headers())[0],405)
        self.assertEqual(self.call('/api/tasks','PUT',{},self.headers())[0],405)
        self.assertEqual(self.call('/api/profile/2','PUT',{},self.headers())[0],404)
        _,headers,_=self.call('/')
        self.assertEqual(headers['X-Content-Type-Options'],'nosniff')
        self.assertIn("frame-ancestors 'none'",headers['Content-Security-Policy'])


if __name__ == '__main__':
    unittest.main()
