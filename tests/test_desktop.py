"""Проверки переносимых сборок и окна Python-приложения (если есть экран)."""

import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.catalog import build_parts, load_catalog, normalize_products
from backend.configuration_file import (
    configuration_document, configuration_text, read_configuration,
    save_configuration, validate_configuration, write_text,
)
from backend.pricing import prices_for


RAW = load_catalog()
PRODUCTS = normalize_products(RAW["products"])


class ConfigurationFileTests(unittest.TestCase):
    def setUp(self):
        self.parts = build_parts(RAW["builds"][0], PRODUCTS)
        self.document = configuration_document(self.parts, PRODUCTS)

    def test_all_ready_builds_round_trip(self):
        for build in RAW["builds"]:
            with self.subTest(build=build[0]):
                parts = build_parts(build, PRODUCTS)
                self.assertEqual(validate_configuration(configuration_document(parts, PRODUCTS), PRODUCTS), parts)

    def test_saved_file_opens_without_changing_catalog_or_prices(self):
        before = copy.deepcopy(PRODUCTS)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "мой компьютер.json"
            save_configuration(path, self.parts, PRODUCTS)
            self.assertEqual(read_configuration(path, PRODUCTS), self.parts)
            self.assertNotIn("price", path.read_text(encoding="utf-8"))
        self.assertEqual(PRODUCTS, before)

    def test_empty_and_partial_configuration_are_supported(self):
        for parts in [{}, {"cpu": 0}]:
            self.assertEqual(validate_configuration(configuration_document(parts, PRODUCTS), PRODUCTS), parts)

    def test_wrong_schema_version_and_model_are_rejected(self):
        malformed = [None, [], {}, {**self.document, "version": True}, {**self.document, "version": 2},
                     {**self.document, "format": "other"}, {**self.document, "extra": 1},
                     {**self.document, "parts": []}]
        for identifier, name in [("p-1", "bad"), ("p999999", "bad"), ("p01", PRODUCTS[1]["name"]),
                                 ("p1", "Подменённое название"), (True, "bad")]:
            malformed.append({**self.document, "parts": {"cpu": {"id": identifier, "name": name}}})
        for value in malformed:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_configuration(value, PRODUCTS)

    def test_unknown_category_and_wrong_category_cannot_be_opened(self):
        board = next(p for p in PRODUCTS if p["c"] == "motherboard")
        for category in ["untrusted", "cpu"]:
            document = {**self.document, "parts": {category: {"id": board["id"], "name": board["name"]}}}
            with self.subTest(category=category), self.assertRaises(ValueError):
                validate_configuration(document, PRODUCTS)

    def test_incompatible_parts_are_rejected(self):
        gpu = next(p for p in PRODUCTS if p["name"] == "NVIDIA GeForce RTX 4090")
        weak = next(p for p in PRODUCTS if p["c"] == "psu" and p["v"][0] == "550")
        with self.assertRaisesRegex(ValueError, "Несовместимые"):
            configuration_document({"gpu": gpu["i"], "psu": weak["i"]}, PRODUCTS)

    def test_read_rejects_duplicate_keys_invalid_json_and_oversized_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.json"
            for text in ["{broken", "[]", '{"format":1,"format":2}', " " * (128 * 1024 + 1)]:
                with self.subTest(size=len(text)):
                    path.write_text(text, encoding="utf-8")
                    with self.assertRaises(ValueError):
                        read_configuration(path, PRODUCTS)

    def test_existing_file_is_preserved_unless_overwrite_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "saved.json"
            path.write_text("user data", encoding="utf-8")
            with self.assertRaises(FileExistsError):
                save_configuration(path, self.parts, PRODUCTS)
            self.assertEqual(path.read_text(), "user data")
            save_configuration(path, self.parts, PRODUCTS, overwrite=True)
            self.assertEqual(read_configuration(path, PRODUCTS), self.parts)
            with self.assertRaises(FileExistsError):
                write_text(path, "replacement")

    def test_text_export_contains_current_budget_and_honest_price_kinds(self):
        prices = prices_for(PRODUCTS, RAW["offers"])
        text = configuration_text(self.parts, PRODUCTS, prices)
        self.assertIn("Итого:", text)
        self.assertIn("расчётная цена", text)
        self.assertIn("Сохранённых цен магазинов:", text)
        self.assertIn("₸", text)
        self.assertIn(PRODUCTS[self.parts["cpu"]]["name"], text)


class DesktopWindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import tkinter as tk
            cls.root = tk.Tk()
            cls.root.withdraw()
        except (ImportError, RuntimeError) as error:
            raise unittest.SkipTest("Tkinter/экран недоступен: " + str(error))
        except Exception as error:
            if type(error).__name__ == "TclError":
                raise unittest.SkipTest("Графический экран недоступен: " + str(error))
            raise

    @classmethod
    def tearDownClass(cls):
        cls.root.destroy()

    def setUp(self):
        from desktop_app import SobranoApp
        for child in self.root.winfo_children():
            child.destroy()
        self.app = SobranoApp(self.root)

    def test_window_loads_and_filters_power_supplies_after_gpu(self):
        app = self.app
        gpu = next(p for p in app.products if p["name"] == "NVIDIA GeForce RTX 4090")
        app.combos["gpu"].current(app.options["gpu"].index(gpu["i"]))
        app.choose("gpu")
        allowed = [app.products[index] for index in app.options["psu"] if index is not None]
        self.assertTrue(allowed)
        self.assertTrue(all(int(p["v"][0]) >= 850 for p in allowed))
        self.assertIn("₸", app.total.get())
        self.root.update_idletasks()

    def test_gui_save_clear_open_export_and_invalid_file_preserves_current_parts(self):
        app = self.app
        app.preset.current(0)
        app.load_preset()
        selected = app.parts.copy()
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "computer.json")
            report = str(Path(directory) / "computer.txt")
            with patch("desktop_app.filedialog.asksaveasfilename", return_value=path):
                app.save_file()
            self.assertFalse(app.dirty)
            self.assertEqual(read_configuration(path, app.products), selected)
            with patch("desktop_app.filedialog.asksaveasfilename", return_value=report):
                app.export_text()
            self.assertIn("Итого:", Path(report).read_text(encoding="utf-8"))
            app.clear()
            self.assertEqual(app.parts, {})
            with patch("desktop_app.filedialog.askopenfilename", return_value=path):
                app.open_file()
            self.assertEqual(app.parts, selected)
            Path(path).write_text('{"version": "bad"}', encoding="utf-8")
            with patch("desktop_app.filedialog.askopenfilename", return_value=path), patch("desktop_app.messagebox.showerror") as error:
                app.open_file()
            error.assert_called_once()
            self.assertEqual(app.parts, selected)
            with patch("desktop_app.filedialog.asksaveasfilename", return_value=path), patch("desktop_app.messagebox.askyesno", return_value=False):
                app.save_file()
            self.assertEqual(Path(path).read_text(encoding="utf-8"), '{"version": "bad"}')


if __name__ == "__main__":
    unittest.main()
