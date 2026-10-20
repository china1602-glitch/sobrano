"""Интеграционные проверки реального локального HTTP-сервера."""

import json
import sys
import threading
import unittest
from datetime import datetime
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server import create_server


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = create_server(0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)

    def test_health_reports_running_python_and_fresh_time(self):
        with urlopen(self.base + "/api/health", timeout=3) as response:
            data = json.load(response)
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_charset(), "utf-8")
            self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(data["backend"], "Python")
        self.assertEqual(data["pythonVersion"], sys.version.split()[0])
        self.assertEqual(data["project"], "СОБРАНО")
        timestamp = datetime.fromisoformat(data["serverTime"])
        self.assertIsNotNone(timestamp.tzinfo)
        self.assertLess(abs((datetime.now().astimezone() - timestamp).total_seconds()), 5)

    def test_head_has_headers_without_body(self):
        request = Request(self.base + "/api/health", method="HEAD")
        with urlopen(request, timeout=3) as response:
            self.assertEqual(response.status, 200)
            self.assertGreater(int(response.headers["Content-Length"]), 0)
            self.assertEqual(response.read(), b"")

    def test_page_and_javascript_served_by_python(self):
        with urlopen(self.base + "/builder.html", timeout=3) as response:
            self.assertEqual(response.status, 200)
            self.assertIn("СОБРАНО", response.read().decode("utf-8"))
        with urlopen(self.base + "/js/compatibility.js", timeout=3) as response:
            self.assertEqual(response.status, 200)
            self.assertIn(b"SobranoCompatibility", response.read())

    def test_missing_resource_is_404(self):
        with self.assertRaises(HTTPError) as caught:
            urlopen(self.base + "/missing-file-for-test.html", timeout=3)
        self.assertEqual(caught.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
