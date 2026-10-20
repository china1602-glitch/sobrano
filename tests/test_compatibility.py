"""Проверки Python-бизнес-логики. Требуются только Python и JSON проекта."""

import copy
import json
from pathlib import Path
import unittest

from backend.compatibility import assess, check, filter_products, validate_parts


ROOT = Path(__file__).resolve().parent.parent
RAW = json.loads((ROOT / "data" / "catalog.json").read_text(encoding="utf-8"))
PRODUCTS = [
    {"i": index, "id": f"p{index}", "c": row[0], "name": row[1], "price": row[2],
     "v": row[3][:], "brand": row[1].split(" ")[0]}
    for index, row in enumerate(RAW["products"])
]
CATEGORIES = ("cpu", "gpu", "motherboard", "ram", "storage", "psu", "case", "cooling")


def named(name, products=PRODUCTS):
    return next(product for product in products if product["name"] == name)


def build_parts(build):
    return {category: index for category, index in zip(CATEGORIES, build[3]) if index is not None}


class CompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.gpu = named("NVIDIA GeForce RTX 4090")
        self.psu550 = next(p for p in PRODUCTS if p["c"] == "psu" and p["v"][0] == "550")
        self.psu1000 = next(p for p in PRODUCTS if p["c"] == "psu" and p["v"][0] == "1000")
        self.am4 = named("AMD Ryzen 5 5600")
        self.am5 = named("AMD Ryzen 5 7600")
        self.board = named("MSI B550M PRO-VDH WIFI")
        self.ddr4 = next(p for p in PRODUCTS if p["c"] == "ram" and p["v"][0] == "DDR4")
        self.ddr5 = next(p for p in PRODUCTS if p["c"] == "ram" and p["v"][0] == "DDR5")
        self.box = named("DeepCool MATREXX 40")
        self.cooler = named("DeepCool AG400")
        self.full = build_parts(next(b for b in RAW["builds"] if b[0] == "Игры в Full HD"))

    def test_validate_parts_is_strict_and_excludes_boolean_indices(self):
        self.assertEqual(validate_parts({"cpu": 0}, PRODUCTS), {"cpu": 0})
        for value in [None, [], {"unknown": 0}, {"cpu": True}, {"cpu": False},
                      {"cpu": "0"}, {"cpu": 0.0}, {"cpu": -1}, {"cpu": 190},
                      {"cpu": self.board["i"]}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_parts(value, PRODUCTS)

    def test_gpu_first_excludes_weak_psu_without_cpu(self):
        parts = {"gpu": self.gpu["i"]}
        self.assertFalse(assess(self.psu550, parts, PRODUCTS)["allowed"])
        self.assertTrue(assess(self.psu1000, parts, PRODUCTS)["allowed"])
        allowed = filter_products([p for p in PRODUCTS if p["c"] == "psu"], parts, PRODUCTS)
        self.assertTrue(allowed)
        self.assertTrue(all(int(p["v"][0]) >= 850 for p in allowed))

    def test_gpu_psu_order_is_symmetric_for_every_catalog_pair(self):
        for gpu in [p for p in PRODUCTS if p["c"] == "gpu"]:
            for psu in [p for p in PRODUCTS if p["c"] == "psu"]:
                with self.subTest(gpu=gpu["id"], psu=psu["id"]):
                    self.assertEqual(assess(gpu, {"psu": psu["i"]}, PRODUCTS)["allowed"],
                                     assess(psu, {"gpu": gpu["i"]}, PRODUCTS)["allowed"])

    def test_unknown_gpu_power_does_not_remove_known_psu_recommendation(self):
        products = copy.deepcopy(PRODUCTS)
        products[self.gpu["i"]]["v"][0] = ""
        result = assess(self.psu550["i"], {"gpu": self.gpu["i"]}, products)
        self.assertFalse(result["allowed"])
        self.assertTrue(any("потребление" in text for text in result["unknown"]))
        allowed = assess(self.psu1000["i"], {"gpu": self.gpu["i"]}, products)
        self.assertTrue(allowed["allowed"])
        self.assertEqual(allowed["status"], "unknown")

    def test_cpu_and_gpu_load_increases_psu_threshold(self):
        cpu = named("AMD Ryzen 9 9950X")
        gpu = named("MSI GeForce RTX 4060 VENTUS 2X BLACK 8G OC")
        # TDP 170 × 1.5, GPU 120, прочие 75, запас 25%: порог 600 Вт.
        result = assess(self.psu550, {"cpu": cpu["i"], "gpu": gpu["i"]}, PRODUCTS)
        self.assertFalse(result["allowed"])
        self.assertIn("600 Вт", result["conflicts"][0])
        self.assertFalse(assess(cpu, {"gpu": gpu["i"], "psu": self.psu550["i"]}, PRODUCTS)["allowed"])
        self.assertFalse(assess(gpu, {"cpu": cpu["i"], "psu": self.psu550["i"]}, PRODUCTS)["allowed"])

    def test_cpu_and_ram_are_checked_before_motherboard(self):
        self.assertFalse(assess(self.am5, {"ram": self.ddr4["i"]}, PRODUCTS)["allowed"])
        self.assertFalse(assess(self.ddr4, {"cpu": self.am5["i"]}, PRODUCTS)["allowed"])
        self.assertTrue(assess(self.ddr5, {"cpu": self.am5["i"]}, PRODUCTS)["allowed"])
        intel = named("Intel Core i5-12400")
        self.assertTrue(assess(self.ddr4, {"cpu": intel["i"]}, PRODUCTS)["allowed"])
        self.assertTrue(assess(self.ddr5, {"cpu": intel["i"]}, PRODUCTS)["allowed"])

    def test_replacement_corrects_an_old_socket_conflict(self):
        parts = {"cpu": self.am5["i"], "motherboard": self.board["i"]}
        self.assertTrue(assess(self.am4, parts, PRODUCTS)["allowed"])
        board_am5 = named("MSI PRO B650M-P")
        self.assertTrue(assess(board_am5, parts, PRODUCTS)["allowed"])
        self.assertFalse(assess(self.am5, {"cpu": self.am4["i"], "motherboard": self.board["i"]}, PRODUCTS)["allowed"])

    def test_ram_capacity_modules_and_type_are_all_checked(self):
        products = copy.deepcopy(PRODUCTS)
        products[self.board["i"]]["v"][3:5] = ["1", "8"]
        products[self.ddr4["i"]]["v"][1:3] = ["32", "2"]
        result = assess(self.ddr4["i"], {"motherboard": self.board["i"]}, products)
        self.assertFalse(result["allowed"])
        self.assertTrue(any("Объём" in text for text in result["conflicts"]))
        self.assertTrue(any("слотов" in text for text in result["conflicts"]))
        self.assertFalse(assess(self.ddr5, {"motherboard": self.board["i"]}, PRODUCTS)["allowed"])

    def test_case_gpu_size_is_checked_in_both_directions(self):
        products = copy.deepcopy(PRODUCTS)
        gpu = named("Sapphire PULSE Radeon RX 7800 XT")
        products[gpu["i"]]["v"][2] = "350"
        self.assertFalse(assess(gpu["i"], {"case": self.box["i"]}, products)["allowed"])
        self.assertFalse(assess(self.box["i"], {"gpu": gpu["i"]}, products)["allowed"])
        larger = next(p for p in products if p["c"] == "case" and int(p["v"][1]) >= 350)
        self.assertTrue(assess(larger, {"case": self.box["i"], "gpu": gpu["i"]}, products)["allowed"])

    def test_case_checks_board_cooler_and_psu_geometry(self):
        products = copy.deepcopy(PRODUCTS)
        products[self.board["i"]]["v"][2] = "ATX"
        products[self.cooler["i"]]["v"][1] = "999"
        products[self.psu550["i"]]["v"][2] = "999"
        parts = {"motherboard": self.board["i"], "cooling": self.cooler["i"], "psu": self.psu550["i"]}
        result = assess(self.box["i"], parts, products)
        self.assertFalse(result["allowed"])
        for text in ["формату", "Кулер", "Блок питания длиннее"]:
            self.assertTrue(any(text in message for message in result["conflicts"]), text)

    def test_cooler_socket_constraint_and_unknown_partial_selection(self):
        self.assertTrue(assess(self.cooler, {}, PRODUCTS)["allowed"])
        products = copy.deepcopy(PRODUCTS)
        products[self.cooler["i"]]["v"][0] = "LGA1700"
        self.assertFalse(assess(self.cooler["i"], {"cpu": self.am4["i"]}, products)["allowed"])
        self.assertFalse(assess(self.am4["i"], {"cooling": self.cooler["i"]}, products)["allowed"])

    def test_unrelated_conflicts_do_not_hide_storage_or_correcting_board(self):
        parts = {"cpu": self.am5["i"], "motherboard": self.board["i"],
                 "gpu": self.gpu["i"], "psu": self.psu550["i"]}
        drives = [p for p in PRODUCTS if p["c"] == "storage"]
        self.assertEqual(filter_products(drives, parts, PRODUCTS), drives)
        self.assertTrue(assess(named("MSI PRO B650M-P"), parts, PRODUCTS)["allowed"])

    def test_unknown_arc_stays_visible_and_full_power_is_not_invented(self):
        arc = named("ASRock Intel Arc A750 Challenger D 8GB OC")
        partial = assess(arc, {"case": self.box["i"], "psu": self.psu550["i"]}, PRODUCTS)
        self.assertTrue(partial["allowed"])
        self.assertEqual(partial["status"], "unknown")
        self.assertTrue(any("длина" in text for text in partial["unknown"]))
        self.assertTrue(any("потребление" in text for text in partial["unknown"]))
        result = check({**self.full, "gpu": arc["i"]}, PRODUCTS)
        self.assertEqual(result["status"], "unknown")
        self.assertIsNone(result["need"])
        self.assertEqual(result["bad"], [])

    def test_known_power_and_unknown_gpu_length_are_distinct(self):
        gpu = named("NVIDIA GeForce RTX 2060")
        result = check({**self.full, "gpu": gpu["i"]}, PRODUCTS)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["need"], 500)
        self.assertTrue(any("длина" in text for text in result["unknown"]))

    def test_missing_required_components_are_not_candidate_conflicts(self):
        self.assertEqual(assess(self.am4, {}, PRODUCTS)["status"], "compatible")
        empty = check({}, PRODUCTS)
        self.assertEqual(empty["status"], "incomplete")
        self.assertEqual(len(empty["missing"]), 6)
        self.assertIsNone(empty["need"])
        parts = self.full.copy()
        del parts["gpu"]
        del parts["cooling"]
        result = check(parts, PRODUCTS)
        self.assertIn("gpu", result["missing"])
        self.assertIn("cooling", result["missing"])
        self.assertIsNone(result["need"])

    def test_all_22_builds_keep_their_indices_and_no_known_conflict(self):
        self.assertEqual(len(PRODUCTS), 190)
        self.assertEqual(len(RAW["builds"]), 22)
        totals = []
        for build in RAW["builds"]:
            with self.subTest(build=build[0]):
                parts = validate_parts(build_parts(build), PRODUCTS)
                result = check(parts, PRODUCTS)
                self.assertEqual(result["bad"], [])
                self.assertEqual(result["missing"], [])
                self.assertIn(result["status"], ("ok", "unknown"))
                totals.append(sum(PRODUCTS[index]["price"] for index in parts.values()))
        self.assertEqual((min(totals), max(totals)), (191000, 2060000))

    def test_assessment_and_check_do_not_mutate_input(self):
        parts = self.full.copy()
        before = copy.deepcopy(PRODUCTS)
        for product in PRODUCTS:
            assess(product, parts, PRODUCTS)
        check(parts, PRODUCTS)
        self.assertEqual(PRODUCTS, before)
        self.assertEqual(parts, self.full)
        self.assertEqual(len(filter_products(PRODUCTS, {}, PRODUCTS)), 190)
        self.assertFalse(assess(True, parts, PRODUCTS)["allowed"])
        self.assertFalse(assess({"i": self.am4["i"], "c": "gpu"}, parts, PRODUCTS)["allowed"])


if __name__ == "__main__":
    unittest.main()
