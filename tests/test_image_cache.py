"""Проверки кеша используют тестовый PNG и временную папку, не фото товаров."""

import base64
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from tools import cache_images as cache


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
RECORD = {"src": "https://photos.example.org/cpu.png", "source": "https://example.org/cpu", "models": ["AMD Ryzen 5 7600"]}


class Response(io.BytesIO):
    status = 200

    def __init__(self, content=PNG, content_type="image/png", size=None):
        super().__init__(content)
        self.headers = {"Content-Type": content_type}
        if size is not None:
            self.headers["Content-Length"] = str(size)

    def geturl(self):
        return RECORD["src"]


class ImageCacheTests(unittest.TestCase):
    def test_html_wrong_mime_truncated_and_oversize_are_rejected(self):
        data, extension = cache.read_image(Response())
        self.assertEqual((data, extension), (PNG, "png"))
        for response in [
            Response(b"<html>access denied</html>", "image/png"),
            Response(PNG, "text/html"),
            Response(PNG, "image/jpeg"),
            Response(PNG[:24]),
            Response(size=cache.MAX_BYTES + 1),
            Response(b"x" * (cache.MAX_BYTES + 1)),
        ]:
            with self.subTest(headers=response.headers):
                with self.assertRaises(ValueError):
                    cache.read_image(response)

    def test_credentials_insecure_urls_and_unapproved_redirects_are_rejected(self):
        for value in ["http://photos.example.org/a.png", "file:///a.png", "https://user:pass@example.org/a.png", "https://localhost/a.png", "https://example.org:8080/a.png"]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    cache.https_url(value)
        request = urllib.request.Request(RECORD["src"])
        redirects = cache.ImageRedirects({"photos.example.org"})
        for target in ["https://unlisted.example.org/a.png", "http://photos.example.org/a.png"]:
            with self.assertRaises(ValueError):
                redirects.redirect_request(request, None, 302, "Found", {}, target)

    def test_real_download_saves_once_and_preserves_attribution_mapping(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            original = "// original metadata\nconst photos = [];\n"
            (root / "js").mkdir()
            (root / "js/product-images.js").write_text(original)
            opener = unittest.mock.Mock()
            opener.open.return_value = Response()
            with patch.object(cache.urllib.request, "build_opener", return_value=opener):
                first = cache.download_image(root, RECORD, {"photos.example.org"})
                second = cache.download_image(root, RECORD, {"photos.example.org"})
            self.assertEqual(first["status"], "downloaded")
            self.assertEqual(second["status"], "cached")
            self.assertEqual(opener.open.call_count, 1)
            self.assertEqual((root / first["path"]).read_bytes(), PNG)
            self.assertEqual(cache.write_cache_index(root, [RECORD]), 1)
            generated = (root / "js/product-images.js").read_text()
            self.assertTrue(generated.startswith(original))
            self.assertIn(json.dumps(RECORD["src"]), generated)
            self.assertIn(first["path"], generated)
            self.assertEqual(cache.write_cache_index(root, [RECORD]), 1)
            self.assertEqual((root / "js/product-images.js").read_text(), generated)

    def test_failed_source_does_not_create_fake_photo_or_change_js(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "js").mkdir()
            original = "// metadata and licence stay here\n"
            (root / "js/product-images.js").write_text(original)
            opener = unittest.mock.Mock()
            opener.open.side_effect = urllib.error.URLError("unavailable")
            with patch.object(cache.urllib.request, "build_opener", return_value=opener):
                result = cache.download_image(root, RECORD, {"photos.example.org"})
            self.assertEqual(result["status"], "failed")
            self.assertIsNone(cache.cached_file(root, RECORD))
            self.assertEqual(cache.write_cache_index(root, [RECORD]), 0)
            self.assertEqual((root / "js/product-images.js").read_text(), original)

    def test_corrupt_cache_is_repaired_atomically_and_preserved_in_unique_backup(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "assets/products" / (cache.file_stem(RECORD) + ".png")
            path.parent.mkdir(parents=True)
            corrupt = b"<html>old failed download</html>"
            path.write_bytes(corrupt)
            prior_backup = path.with_name(path.name + ".backup-existing")
            prior_backup.write_bytes(b"older user backup")
            self.assertIsNone(cache.cached_file(root, RECORD))
            opener = unittest.mock.Mock()
            opener.open.return_value = Response()
            with patch.object(cache.urllib.request, "build_opener", return_value=opener):
                result = cache.download_image(root, RECORD, {"photos.example.org"})
            self.assertEqual(result["status"], "downloaded")
            self.assertEqual(path.read_bytes(), PNG)
            self.assertEqual((root / result["backup"]).read_bytes(), corrupt)
            self.assertEqual(prior_backup.read_bytes(), b"older user backup")
            self.assertEqual(cache.cached_file(root, RECORD), path)
            self.assertEqual(list(path.parent.glob(".sobrano-image-*")), [])

    def test_failed_atomic_replacement_restores_original_corrupt_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "assets/products" / (cache.file_stem(RECORD) + ".png")
            path.parent.mkdir(parents=True)
            original = b"user file must survive disk error"
            path.write_bytes(original)
            replace = Path.replace

            def fail_image_replacement(source, target):
                if source.name.startswith(".sobrano-image-"):
                    raise PermissionError("simulated replacement failure")
                return replace(source, target)

            opener = unittest.mock.Mock()
            opener.open.return_value = Response()
            with patch.object(cache.urllib.request, "build_opener", return_value=opener), patch.object(Path, "replace", fail_image_replacement):
                result = cache.download_image(root, RECORD, {"photos.example.org"})
            self.assertEqual(result["status"], "failed")
            self.assertIn(str(path), result["error"])
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(path.parent.glob(".sobrano-image-*")), [])

    def test_generated_filename_symlink_is_not_followed_or_replaced(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "assets/products" / (cache.file_stem(RECORD) + ".png")
            path.parent.mkdir(parents=True)
            target = root / "important.txt"
            target.write_bytes(b"do not touch")
            try:
                path.symlink_to(target)
            except (OSError, NotImplementedError):
                self.skipTest("Creating symlinks is not supported by this system")
            opener = unittest.mock.Mock()
            opener.open.return_value = Response()
            with patch.object(cache.urllib.request, "build_opener", return_value=opener):
                result = cache.download_image(root, RECORD, {"photos.example.org"})
            self.assertEqual(result["status"], "failed")
            self.assertIn(str(path), result["error"])
            self.assertTrue(path.is_symlink())
            self.assertEqual(target.read_bytes(), b"do not touch")

    def test_incomplete_managed_block_does_not_overwrite_source(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "js").mkdir()
            original = "// metadata\n" + cache.START
            (root / "js/product-images.js").write_text(original)
            with self.assertRaises(ValueError):
                cache.write_cache_index(root, [RECORD])
            self.assertEqual((root / "js/product-images.js").read_text(), original)

    def test_symlink_cannot_move_cache_outside_project(self):
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as outside:
            root = Path(folder)
            (root / "assets").mkdir()
            try:
                (root / "assets/products").symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("Creating symlinks is not supported by this system")
            with self.assertRaises(ValueError):
                cache.cached_file(root, RECORD)


if __name__ == "__main__":
    unittest.main()
