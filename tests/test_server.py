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
        self.assertEqual(self.call('/api/tasks','POST',{'title':'Stale'},{'Content-Type':'application/json','X-Praktikum-Request':'1','If-Match':'-1'})[0],409)

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
