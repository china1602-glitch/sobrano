"""Целостность исходников, JSON, локальных ссылок и данных обеих частей."""
import ast
import json
import re
import unittest
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
from backend.catalog import CATEGORIES
from backend.compatibility import validate_parts
from backend.catalog import normalize_products

ROOT = Path(__file__).resolve().parent.parent

class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs = []
    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ("href", "src") and value:
                self.refs.append(value)

class ProjectTests(unittest.TestCase):
    def test_all_json_is_strict_and_contains_no_duplicate_keys(self):
        def unique(pairs):
            result = {}
            for key, value in pairs:
                self.assertNotIn(key, result, "duplicate JSON key: " + key)
                result[key] = value
            return result
        for file in ROOT.rglob("*.json"):
            if any(part in {".git", "node_modules", "dist", "instance", ".wrangler", ".sites-runtime"} for part in file.parts):
                continue
            with self.subTest(file=file.relative_to(ROOT)):
                json.loads(file.read_text(encoding="utf-8-sig"), object_pairs_hook=unique,
                           parse_constant=lambda value: self.fail("invalid JSON constant: " + value))

    def test_catalog_and_offer_references_are_consistent(self):
        data = json.loads((ROOT / "data/catalog.json").read_text(encoding="utf-8"))
        offers = json.loads((ROOT / "data/offers.json").read_text(encoding="utf-8"))
        products = normalize_products(data["products"])
        self.assertEqual(len(products), 190)
        self.assertEqual(len(data["builds"]), 22)
        categories = list(CATEGORIES)
        for product in products:
            self.assertIn(product["c"], categories)
            self.assertGreater(product["price"], 0)
            self.assertTrue(product["name"])
        for build in data["builds"]:
            self.assertEqual(len(build), 4)
            self.assertEqual(len(build[3]), 8)
            parts = {key: index for key, index in zip(categories, build[3]) if index is not None}
            self.assertEqual(validate_parts(parts, products), parts)
        for offer in offers:
            self.assertRegex(offer["productId"], r"^p(?:0|[1-9][0-9]*)$")
            self.assertLess(int(offer["productId"][1:]), len(products))
            self.assertEqual(offer["currency"], "KZT")

    def test_html_css_and_bootstrap_local_resources_exist(self):
        def exists(base, ref):
            url = urlsplit(ref)
            if url.scheme or url.netloc or not url.path:
                return
            target = base / unquote(url.path)
            self.assertTrue(target.is_file(), str(base.relative_to(ROOT)) + ": " + ref)
        pages = list(ROOT.glob("*.html"))
        self.assertEqual({page.name for page in pages}, {
            "index.html", "catalog.html", "builds.html", "builder.html",
            "compare.html", "favorites.html", "about.html", "product.html",
            "build.html", "account.html",
        })
        for page in pages:
            parser = References()
            parser.feed(page.read_text(encoding="utf-8"))
            for ref in parser.refs:
                exists(page.parent, ref)
        for css in (ROOT / "css").glob("*.css"):
            for ref in re.findall(r'url\(["\x27]?([^)"\x27]+)', css.read_text(encoding="utf-8")):
                exists(css.parent, ref)
        bootstrap = (ROOT / "js/bootstrap.js").read_text(encoding="utf-8")
        for name in re.findall(r'loadScript\("([^"]+)"\)', bootstrap):
            exists(ROOT / "js", name)

    def test_pages_uses_static_runtime_and_keeps_both_source_parts(self):
        runtime = json.loads((ROOT / "runtime.json").read_text(encoding="utf-8"))
        self.assertEqual(runtime["backend"], "static")
        for name in ("index.html", ".nojekyll", "server.py", "backend/catalog.py",
                     "backend/compatibility.py", "backend/pricing.py", "PROJECT_STRUCTURE.md"):
            self.assertTrue((ROOT / name).is_file(), name)
        for folder, pattern in ((ROOT, "*.html"), (ROOT / "js", "*.js"), (ROOT / "css", "*.css")):
            for file in folder.glob(pattern):
                self.assertNotRegex(file.read_text(encoding="utf-8"), r"https?://(?:localhost|127\.0\.0\.1)(?::|/|\b)")

    def test_documentation_local_links_exist(self):
        for file in ROOT.rglob("*.md"):
            if any(part in {".git", "node_modules", "dist", "instance", ".wrangler", ".sites-runtime"} for part in file.parts):
                continue
            for ref in re.findall(r"\]\(([^)]+)\)", file.read_text(encoding="utf-8")):
                url = urlsplit(ref)
                if not url.scheme and not url.netloc and url.path:
                    self.assertTrue((file.parent / unquote(url.path)).exists(), str(file) + ": " + ref)

    def test_python_sources_parse_without_writing_cache(self):
        for folder in (ROOT, ROOT / "backend", ROOT / "tests"):
            for file in folder.glob("*.py"):
                ast.parse(file.read_text(encoding="utf-8-sig"), filename=str(file))

if __name__ == "__main__":
    unittest.main()
