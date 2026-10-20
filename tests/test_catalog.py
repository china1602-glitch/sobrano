"""Проверки Python-каталога: поиск, характеристики и показываемая цена."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from backend.catalog import (
    build_parts, facets, filter_builds, filter_products, load_catalog,
    normalize_products,
)


ROWS = [
    ["cpu", "AMD Ryzen 5 7600X", 115000, ["AM5", "DDR5", "105", "1", "0", "6", "12", "0"]],
    ["cpu", "Intel Core i5-12400F", 55000, ["LGA1700", "DDR4:DDR5", "117", "0", "0", "6", "12", "1"]],
    ["ram", "Kingston FURY Beast 32 DDR5", 70000, ["DDR5", "32", "2", "6000"]],
    ["ram", "Kingston FURY Beast 16 DDR4", 28000, ["DDR4", "16", "2", "3200"]],
    ["ram", "Crucial UDIMM 32 DDR5", 65000, ["DDR5", "32", "1", "6000"]],
    ["gpu", "Sapphire PULSE Radeon RX 7800 XT", 290000, ["266", "700", "280", "16"]],
    ["gpu", "MSI GeForce RTX 4060", 165000, ["120", "550", "199", "8"]],
    ["gpu", "ASRock Intel Arc A750", 135000, ["", "", "", "8"]],
    ["case", "Case 10", 20000, ["ATX:mATX:Mini-ITX", "370", "165", "170"]],
    ["case", "Case 2", 20000, ["mATX:Mini-ITX", "320", "165", "160"]],
    ["cooling", "Cooler AM5", 25000, ["AM4:AM5:LGA1700", "159"]],
    ["storage", "SSD unknown speed", None, ["NVMe", "1000", "2280", ""]],
]


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.products = normalize_products(deepcopy(ROWS))

    def test_normalization_preserves_ids_zero_and_unknown_values(self):
        first = self.products[0]
        self.assertEqual(first["id"], "p0")
        self.assertEqual(first["i"], 0)
        self.assertEqual(first["brand"], "AMD")
        self.assertEqual(first["v"][4], "0")
        self.assertIsNone(self.products[-1]["price"])
        self.assertEqual(self.products[-1]["v"][3], "")
        self.assertEqual(normalize_products(None), [])
        with self.assertRaises(ValueError):
            normalize_products([["cpu", "Incomplete"]])

    def test_search_requires_every_word_and_searches_specifications(self):
        result = filter_products(self.products, {"search": "  ryZen 7600x  AM5 "}, "cpu")
        self.assertEqual([p["id"] for p in result], ["p0"])
        self.assertEqual(filter_products(self.products, {"search": "Ryzen AM4"}, "cpu"), [])
        result = filter_products(self.products, {"search": ["DDR4 LGA1700"]}, "cpu")
        self.assertEqual([p["id"] for p in result], ["p1"])

    def test_ram_filters_apply_type_capacity_modules_speed_and_brand(self):
        filters = {"type": "DDR5", "capacity": "32", "modules": "2", "speed": "6000", "brand": "Kingston"}
        result = filter_products(self.products, filters, "ram")
        self.assertEqual([p["id"] for p in result], ["p2"])
        self.assertEqual(filter_products(self.products, {**filters, "modules": "4"}, "ram"), [])

    def test_gpu_family_and_vram_are_real_facets(self):
        for family, vram, product_id in [("radeon", "16", "p5"), ("nvidia", "8", "p6"), ("arc", "8", "p7")]:
            result = filter_products(self.products, {"family": family, "vram": vram}, "gpu")
            self.assertEqual([p["id"] for p in result], [product_id])

    def test_multivalue_specs_match_individual_option(self):
        self.assertEqual([p["id"] for p in filter_products(self.products, {"type": "DDR4"}, "cpu")], ["p1"])
        self.assertEqual(len(filter_products(self.products, {"format": "Mini-ITX"}, "case")), 2)
        self.assertEqual([p["id"] for p in filter_products(self.products, {"socket": "AM4"}, "cooling")], ["p10"])

    def test_price_map_controls_both_filters_and_sorting(self):
        prices = {"p0": {"value": 100}, "p1": {"value": 999999}}
        result = filter_products(self.products, {"max": "500", "sort": "asc"}, "cpu", prices)
        self.assertEqual([p["id"] for p in result], ["p0"])
        result = filter_products(self.products, {"min": "100", "max": "999999", "sort": "desc"}, "cpu", prices)
        self.assertEqual([p["id"] for p in result], ["p1", "p0"])
        self.assertEqual(filter_products(self.products, {"min": "900", "max": "100"}, "cpu", prices), [])

    def test_invalid_price_limits_are_ignored_and_zero_is_valid(self):
        for value in ["", "-1", "NaN", "Infinity", "oops"]:
            self.assertEqual(len(filter_products(self.products, {"min": value, "max": value}, "cpu")), 2)
        self.assertEqual(filter_products(self.products, {"max": "0"}, "cpu"), [])

    def test_unknown_categories_ignore_category_facets_and_natural_sort_works(self):
        self.assertEqual(len(filter_products(self.products, {"type": "DDR999"}, "constructor")), len(ROWS))
        self.assertEqual(facets("__proto__", self.products), [])
        result = filter_products(self.products, {"sort": "asc"}, "case")
        self.assertEqual([p["name"] for p in result], ["Case 2", "Case 10"])

    def test_cpu_suffixes_sort_space_before_model_number_suffix(self):
        rows = normalize_products([
            ["cpu", "AMD Ryzen 7 5700X3D OEM", 125000, []],
            ["cpu", "AMD Ryzen 7 5700X OEM", 85000, []],
        ])
        self.assertEqual([p["i"] for p in filter_products(rows, {}, "cpu")], [1, 0])

    def test_facets_exclude_missing_values_and_preserve_graphics_zero(self):
        cpu = {facet["key"]: facet["options"] for facet in facets("cpu", self.products)}
        self.assertEqual(cpu["graphics"], [{"value": "0", "label": "Нет"}, {"value": "1", "label": "Есть"}])
        self.assertEqual(cpu["type"], [{"value": "DDR4", "label": "DDR4"}, {"value": "DDR5", "label": "DDR5"}])
        gpu = {facet["key"]: facet["options"] for facet in facets("gpu", self.products)}
        self.assertEqual([option["value"] for option in gpu["vram"]], ["8", "16"])
        self.assertTrue(all(option["value"] for options in gpu.values() for option in options))

    def test_filters_do_not_mutate_products_or_params(self):
        original = deepcopy(self.products)
        params = {"type": "DDR5", "sort": "desc"}
        filter_products(self.products, params, "ram")
        facets("ram", self.products)
        self.assertEqual(self.products, original)
        self.assertEqual(params, {"type": "DDR5", "sort": "desc"})

    def test_load_catalog_reads_json_relative_to_explicit_root_and_separate_offers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data"
            path.mkdir()
            raw = {"products": ROWS, "builds": [], "photos": {}}
            (path / "catalog.json").write_text(json.dumps(raw), encoding="utf-8")
            self.assertEqual(load_catalog(directory)["offers"], [])
            (path / "offers.json").write_text('[{"productId":"p0"}]', encoding="utf-8")
            loaded = load_catalog(directory)
            self.assertEqual(loaded["products"], ROWS)
            self.assertEqual(loaded["offers"], [{"productId": "p0"}])
            (path / "catalog.json").write_text('{"products":{}}', encoding="utf-8")
            with self.assertRaises(ValueError):
                load_catalog(directory)

    def test_build_task_and_budget_use_same_snapshot_prices(self):
        first = ["First", "Игры", "", [0, 6, None, 2, None, None, 8, 10]]
        second = ["Second", "Работа", "", [1, None, None, 4, None, None, 9, 10]]
        prices = {"p0": {"value": 1, "kind": "snapshot"}}
        selected = filter_builds([first, second], self.products, prices, task="Игры", max_price=300000)
        self.assertEqual(selected, [first])
        self.assertEqual(filter_builds([first, second], self.products, prices, max_price=10), [])
        self.assertEqual(len(filter_builds([first, second], self.products, prices, max_price=0)), 2)
        self.assertEqual(build_parts(first, self.products)["cpu"], 0)
        broken = ["Wrong", "", "", [True, 0, None, "2"]]
        self.assertEqual(build_parts(broken, self.products), {})


if __name__ == "__main__":
    unittest.main()
