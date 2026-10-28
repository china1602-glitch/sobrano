"""Интеграционные проверки реального локального HTTP-сервера."""

import json
import sys
import threading
import unittest
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from unittest.mock import patch

from server import CATEGORIES, PROJECT_ROOT, create_server


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = create_server(0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.raw = json.loads((PROJECT_ROOT / "data" / "catalog.json").read_text(encoding="utf-8"))

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
        self.assertEqual(data["products"], len(self.raw["products"]))
        self.assertEqual(data["builds"], len(self.raw["builds"]))
        self.assertIn("compatibility", data["purpose"])
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

    def test_development_files_are_not_served(self):
        for path in ("/.git/config", "/.vscode/launch.json", "/%2egit/config", "/.env",
                     "/server.py", "/online/api.mjs", "/instance/sobrano.sqlite",
                     "/instance/", "/backend/", "/docs/", "/package.json"):
            for method in ("GET", "HEAD"):
                with self.subTest(path=path, method=method):
                    with self.assertRaises(HTTPError) as caught:
                        urlopen(Request(self.base + path, method=method), timeout=3)
                    self.assertEqual(caught.exception.code, 404)

    def test_existing_private_database_is_not_exposed_by_legacy_server(self):
        with TemporaryDirectory() as directory:
            private = Path(directory) / "instance"
            private.mkdir()
            (private / "sobrano.sqlite").write_bytes(b"private account database")
            server = create_server(0, root=directory)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for path in ("/instance/sobrano.sqlite", "/instance/", "/"):
                    with self.subTest(path=path):
                        with self.assertRaises(HTTPError) as caught:
                            urlopen(f"http://127.0.0.1:{server.server_port}" + path, timeout=3)
                        self.assertEqual(caught.exception.code, 404)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)

    def test_missing_resource_is_404(self):
        with self.assertRaises(HTTPError) as caught:
            urlopen(self.base + "/missing-file-for-test.html", timeout=3)
        self.assertEqual(caught.exception.code, 404)

    def get_json(self, path):
        with urlopen(self.base + path, timeout=5) as response:
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(response.headers.get_content_type(), "application/json")
            return json.load(response)

    def post_json(self, payload):
        request = Request(
            self.base + "/api/configuration",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    def assert_json_error(self, path, status=400, body=None, content_type="application/json", method=None):
        request = Request(
            self.base + path, data=body,
            headers={"Content-Type": content_type} if body is not None else {},
            method=method or ("POST" if body is not None else "GET"),
        )
        with self.assertRaises(HTTPError) as caught:
            urlopen(request, timeout=5)
        response = caught.exception
        self.assertEqual(response.code, status)
        self.assertEqual(response.headers.get_content_type(), "application/json")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        data = json.load(response)
        self.assertIsInstance(data["error"], str)
        self.assertTrue(data["error"])
        self.assertNotIn("Traceback", data["error"])
        return data

    def product_index(self, name):
        return next(i for i, row in enumerate(self.raw["products"]) if row[1] == name)

    def test_runtime_selects_real_python_api(self):
        with patch.dict("os.environ", {"SOBRANO_DEBUG": "0"}):
            self.assertEqual(self.get_json("/runtime.json"), {"backend": "python", "apiBase": "api/"})

    def test_debugger_runtime_allows_waiting_at_python_breakpoint(self):
        with patch.dict("os.environ", {"SOBRANO_DEBUG": "1"}):
            runtime = self.get_json("/runtime.json")
        self.assertEqual(runtime["backend"], "python")
        self.assertEqual(runtime["requestTimeoutMs"], 0)

    def test_catalog_returns_raw_data_prices_and_computed_build_results(self):
        data = self.get_json("/api/catalog")
        self.assertEqual(data["products"], self.raw["products"])
        self.assertEqual(data["builds"], self.raw["builds"])
        self.assertEqual(len(data["prices"]), len(data["products"]))
        self.assertEqual(set(data["buildResults"]), {f"b{i}" for i in range(len(data["builds"]))})
        expected_parts = {category: value for category, value in zip(CATEGORIES, data["builds"][0][3]) if value is not None}
        result = data["buildResults"]["b0"]
        self.assertEqual(result["parts"], expected_parts)
        self.assertEqual(result["budget"]["value"], sum(data["prices"][f"p{i}"]["value"] or 0 for i in expected_parts.values()))
        self.assertIn(result["check"]["status"], {"ok", "incomplete", "unknown", "conflict"})

    def test_product_search_facets_and_price_sort_are_computed_on_server(self):
        query = urlencode({"cat": "cpu", "search": "Ryzen 5 7600", "socket": "AM5", "sort": "asc", "compat": "all"})
        data = self.get_json("/api/products?" + query)
        expected = {f"p{self.product_index(name)}" for name in ("AMD Ryzen 5 7600", "AMD Ryzen 5 7600X")}
        self.assertEqual(set(data["ids"]), expected)
        prices = self.get_json("/api/catalog")["prices"]
        values = [prices[pid]["value"] for pid in data["ids"]]
        self.assertEqual(values, sorted(values))
        self.assertEqual(data["filteredTotal"], 2)
        self.assertEqual(data["hidden"], 0)

    def test_product_price_filter_uses_displayed_store_or_estimate_value(self):
        index = self.product_index("Kingston NV3 1000 ГБ")
        price = self.get_json("/api/catalog")["prices"][f"p{index}"]["value"]
        data = self.get_json("/api/products?" + urlencode({"cat": "storage", "min": price, "max": price}))
        self.assertIn(f"p{index}", data["ids"])

    def test_compatibility_filter_excludes_wrong_socket_and_can_be_disabled(self):
        cpu = self.product_index("AMD Ryzen 5 7600")
        parts = str(cpu) + ",,,,,,,"
        data = self.get_json("/api/products?" + urlencode({"cat": "motherboard", "parts": parts}))
        wrong = f"p{self.product_index('MSI B550M PRO-VDH WIFI')}"
        right = f"p{self.product_index('MSI PRO B650M-P')}"
        self.assertNotIn(wrong, data["ids"])
        self.assertIn(right, data["ids"])
        self.assertGreater(data["hidden"], 0)
        all_rows = self.get_json("/api/products?" + urlencode({"cat": "motherboard", "parts": parts, "compat": "all"}))
        self.assertIn(wrong, all_rows["ids"])
        self.assertEqual(all_rows["hidden"], 0)

    def test_favorites_subset_and_empty_subset(self):
        subset = self.get_json("/api/products?ids=p0,p1&compat=all")
        self.assertEqual(set(subset["ids"]), {"p0", "p1"})
        self.assertEqual(subset["total"], 2)
        self.assertEqual(self.get_json("/api/products?ids=")["ids"], [])

    def test_configuration_returns_conflict_budget_and_all_candidate_assessments(self):
        cpu = self.product_index("AMD Ryzen 5 7600")
        board = self.product_index("MSI B550M PRO-VDH WIFI")
        parts = {"cpu": cpu, "motherboard": board}
        data = self.post_json({"parts": parts})
        self.assertEqual(data["parts"], parts)
        self.assertEqual(data["check"]["status"], "conflict")
        self.assertTrue(data["check"]["bad"])
        self.assertEqual(len(data["assessments"]), len(self.raw["products"]))
        prices = self.get_json("/api/catalog")["prices"]
        self.assertEqual(data["budget"]["value"], sum(prices[f"p{i}"]["value"] or 0 for i in parts.values()))
        self.assertFalse(data["assessments"][f"p{board}"]["allowed"])
        self.assertTrue(self.post_json({"parts": {}})["check"]["missing"])

    def test_build_filters_use_calculated_budget_and_task(self):
        catalog_data = self.get_json("/api/catalog")
        task = self.raw["builds"][0][1]
        maximum = catalog_data["buildResults"]["b0"]["budget"]["value"]
        expected = [f"b{i}" for i, row in enumerate(self.raw["builds"]) if row[1] == task and catalog_data["buildResults"][f"b{i}"]["budget"]["value"] <= maximum]
        query = urlencode({"task": task, "budget": maximum})
        self.assertEqual(self.get_json("/api/builds?" + query)["ids"], expected)
        self.assertEqual(len(self.get_json("/api/builds")["ids"]), len(self.raw["builds"]))
        self.assertEqual(len(self.get_json("/api/builds?budget=")["ids"]), len(self.raw["builds"]))
        self.assertEqual(self.get_json("/api/builds?budget=0")["ids"], [])

    def test_malformed_parts_queries_are_rejected_instead_of_reset(self):
        for value in ("", "0", "-1,,,,,,,", "1.0,,,,,,,", "true,,,,,,,", "999999,,,,,,,", ",0,,,,,,", "00,,,,,,,", "null,,,,,,,"):
            with self.subTest(parts=value):
                self.assert_json_error("/api/products?" + urlencode({"parts": value}))

    def test_invalid_query_filters_and_identifiers_return_400(self):
        for query in ("min=NaN", "max=Infinity", "min=-1", "min=10&max=1", "cat=bad", "sort=bad", "compat=bad", "ids=p999999", "ids=0", "ids=p01", "cat=cpu&cat=gpu"):
            with self.subTest(query=query):
                self.assert_json_error("/api/products?" + query)
        for value in ("NaN", "-1", "0.5", "Infinity", "oops", "9007199254740992"):
            with self.subTest(budget=value):
                self.assert_json_error("/api/builds?" + urlencode({"budget": value}))

    def test_invalid_configuration_objects_return_400(self):
        wrong_board = self.product_index("MSI PRO B650M-P")
        for parts in (None, [], "0", {"cpu": True}, {"cpu": "0"}, {"cpu": 0.0}, {"cpu": -1}, {"cpu": 999999}, {"cpu": wrong_board}, {"other": 0}):
            with self.subTest(parts=parts):
                self.assert_json_error("/api/configuration", body=json.dumps({"parts": parts}).encode())
        for payload in ({}, {"parts": {}, "extra": 1}, [], None):
            self.assert_json_error("/api/configuration", body=json.dumps(payload).encode())

    def test_malformed_json_duplicates_and_nonfinite_numbers_return_400(self):
        for body in (b"{", b'{"parts":{},"parts":{}}', b'{"parts":{"cpu":NaN}}', b'{"parts":{"cpu":0,"cpu":1}}', b"\xff", b""):
            with self.subTest(body=body):
                self.assert_json_error("/api/configuration", body=body)
        self.assert_json_error("/api/configuration", body=b'{"parts":{}}', content_type="text/plain")

    def test_body_size_limit_is_enforced(self):
        self.assert_json_error("/api/configuration", status=413, body=b" " * 65537)
        body = b'{"parts":{}}'
        request = Request(self.base + "/api/configuration", data=body.ljust(65536, b" "), headers={"Content-Type": "application/json"}, method="POST")
        with urlopen(request, timeout=5) as response:
            self.assertEqual(json.load(response)["parts"], {})

    def test_unknown_api_routes_and_wrong_methods_return_json(self):
        self.assert_json_error("/api/not-found", status=404)
        self.assert_json_error("/api/not-found", status=404, body=b"{}")
        self.assert_json_error("/api/configuration", status=405)
        self.assert_json_error("/api/catalog", status=405, body=b"{}")
        for method in ("PUT", "PATCH", "DELETE", "OPTIONS"):
            with self.subTest(method=method):
                self.assert_json_error("/api/catalog", status=405, method=method)
                self.assert_json_error("/api/not-found", status=404, method=method)

    def test_internal_data_error_has_json_without_private_details(self):
        with patch("server.catalog.load_catalog", side_effect=RuntimeError("private test traceback")):
            data = self.assert_json_error("/api/catalog", status=500)
        self.assertNotIn("private", data["error"])

    def test_json_changes_are_read_without_server_restart(self):
        with TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            data_dir.mkdir()
            path = data_dir / "catalog.json"
            path.write_text(json.dumps({"products": [["cpu", "Test CPU", 10, []]], "builds": []}), encoding="utf-8")
            server = create_server(0, root=directory)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}/api/catalog"
                with urlopen(url, timeout=3) as response:
                    self.assertEqual(json.load(response)["prices"]["p0"]["value"], 10)
                path.write_text(json.dumps({"products": [["cpu", "Test CPU", 25, []]], "builds": []}), encoding="utf-8")
                with urlopen(url, timeout=3) as response:
                    self.assertEqual(json.load(response)["prices"]["p0"]["value"], 25)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
