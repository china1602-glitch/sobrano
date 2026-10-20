"""Снимки цен: достоверность структуры, срок, наличие и итог сборки."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import unittest

from backend.pricing import budget, offers_for, prices_for, valid_offers


NOW = datetime(2026, 10, 20, 7, 42, 30, tzinfo=timezone.utc)
PRODUCTS = [
    {"i": 0, "id": "p0", "c": "cpu", "price": 55000},
    {"i": 1, "id": "p1", "c": "storage", "price": 42000},
    {"i": 2, "id": "p2", "c": "psu", "price": 32000},
]


def offer(product_id="p1", price=78990, **changes):
    return {"productId": product_id, "store": "Test store", "price": price,
            "url": "https://example.org/product", "currency": "KZT",
            "checkedAt": "2026-10-20T12:42:30+05:00",
            "availability": "unknown", **changes}


class PricingTests(unittest.TestCase):
    def test_minimum_fresh_offer_and_fresh_count(self):
        entries = [offer(price=79990), offer(price=78990, store="Sulpak")]
        price = prices_for(PRODUCTS, entries, NOW)["p1"]
        self.assertEqual(price["value"], 78990)
        self.assertEqual(price["kind"], "snapshot")
        self.assertEqual(price["count"], 2)
        self.assertEqual(price["offer"]["store"], "Sulpak")
        self.assertEqual(prices_for(PRODUCTS, entries, NOW)["p0"], {
            "value": 55000, "kind": "estimate", "offer": None, "count": 0,
        })

    def test_exact_age_boundaries_and_history(self):
        entry = offer()
        self.assertEqual(prices_for(PRODUCTS, [entry], NOW + timedelta(days=30))["p1"]["kind"], "snapshot")
        stale = prices_for(PRODUCTS, [entry], NOW + timedelta(days=30, microseconds=1))["p1"]
        self.assertEqual(stale["kind"], "estimate")
        self.assertEqual(stale["value"], 42000)
        self.assertEqual(stale["count"], 0)
        self.assertEqual(offers_for(PRODUCTS[1], [entry]), [entry])

    def test_five_minute_future_tolerance_is_inclusive(self):
        entry = offer()
        self.assertEqual(prices_for(PRODUCTS, [entry], NOW - timedelta(minutes=5))["p1"]["kind"], "snapshot")
        self.assertEqual(prices_for(PRODUCTS, [entry], NOW - timedelta(minutes=5, microseconds=1))["p1"]["kind"], "estimate")
        self.assertEqual(prices_for(PRODUCTS, [entry], NOW - timedelta(days=1))["p1"]["kind"], "estimate")

    def test_stock_filters_only_known_absence(self):
        entries = [offer(price=1, availability="out-of-stock"), offer(price=2, availability="unknown"), offer(price=3, availability="in-stock")]
        price = prices_for(PRODUCTS, entries, NOW)["p1"]
        self.assertEqual(price["value"], 2)
        self.assertEqual(price["count"], 2)
        self.assertEqual(len(offers_for(PRODUCTS[1], entries)), 3)
        self.assertEqual(prices_for(PRODUCTS, [entries[0]], NOW)["p1"]["kind"], "estimate")

    def test_invalid_currency_numbers_dates_ids_and_urls_cannot_be_snapshots(self):
        bad = [offer(currency="USD"), offer(price=0), offer(price=-1),
               offer(price=float("nan")), offer(price=float("inf")), offer(price=True),
               offer(price="78990"), offer(price=10 ** 1000),
               offer(checkedAt="not a date"), offer(checkedAt=None),
               offer(product_id="p-1"), offer(product_id="p١"),
               offer(url="javascript:alert(1)"), offer(url="http://example.org"),
               offer(url="https://"), None, "bad row"]
        self.assertEqual(valid_offers(bad), [])
        self.assertTrue(all(price["kind"] == "estimate" for price in prices_for(PRODUCTS, bad, NOW).values()))

    def test_timezone_equivalence_and_naive_test_clock(self):
        entries = [offer(checkedAt="2026-10-20T07:42:30Z"), offer(checkedAt="2026-10-20T12:42:30+05:00")]
        price = prices_for(PRODUCTS, entries, NOW.replace(tzinfo=None))["p1"]
        self.assertEqual(price["count"], 2)
        with self.assertRaises(TypeError):
            prices_for(PRODUCTS, entries, "2026-10-20")

    def test_mixed_budget_counts_index_zero_once_and_rejects_invalid_indices(self):
        prices = prices_for(PRODUCTS, [offer(), offer("p2", 23990)], NOW)
        parts = {"cpu": 0, "storage": 1, "psu": 2, "negative": -1,
                 "bool": True, "text": "0", "fraction": 1.0, "outside": 99, "missing": None}
        self.assertEqual(budget(parts, PRODUCTS, prices), {
            "value": 55000 + 78990 + 23990, "snapshots": 2, "estimates": 1,
        })
        self.assertEqual(budget({"cpu": 0}, PRODUCTS, {}), {"value": 55000, "snapshots": 0, "estimates": 1})
        self.assertEqual(budget({}, PRODUCTS, prices), {"value": 0, "snapshots": 0, "estimates": 0})

    def test_calculations_do_not_modify_input_or_price_timestamps(self):
        entries = [offer()]
        original = deepcopy(entries)
        products = deepcopy(PRODUCTS)
        prices = prices_for(products, entries, NOW)
        budget({"storage": 1}, products, prices)
        self.assertEqual(entries, original)
        self.assertEqual(products, PRODUCTS)
        self.assertEqual(prices["p1"]["offer"]["checkedAt"], original[0]["checkedAt"])


if __name__ == "__main__":
    unittest.main()
