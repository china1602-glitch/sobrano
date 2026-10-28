"""Скачивание уже сопоставленных фотографий для локальной защиты.

Запуск из терминала: py tools/cache_images.py
Требуется Интернет. Python использует системные настройки HTTPS/proxy.
Скрипт не ищет новые изображения и не меняет названия, цены или подписи.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 8 * 1024 * 1024
START = "// BEGIN SOBRANO LOCAL IMAGE CACHE"
END = "// END SOBRANO LOCAL IMAGE CACHE"
MIME_TYPES = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
    "image/webp": "webp", "image/gif": "gif",
}


def https_url(value):
    """Только HTTPS без пароля, нестандартного порта и локальных адресов."""
    if not isinstance(value, str):
        raise ValueError("Ожидалась HTTPS-ссылка изображения")
    url = urllib.parse.urlsplit(value)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.port not in (None, 443) or url.fragment
            or url.hostname in {"localhost", "127.0.0.1", "::1"}):
        raise ValueError("Допустимы только внешние HTTPS-ссылки без пароля")
    return url


def image_extension(data):
    """Проверка сигнатуры: страница ошибки HTML не сохранится как фотография."""
    if len(data) < 24:
        raise ValueError("Файл изображения слишком короткий")
    if data[:3] == b"\xff\xd8\xff" and data.rstrip(b"\0 \r\n\t").endswith(b"\xff\xd9"):
        return "jpg"
    if (data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR"
            and b"IEND" in data[-12:] and all(struct.unpack(">II", data[16:24]))):
        return "png"
    if (data[:4] == b"RIFF" and data[8:12] == b"WEBP"
            and int.from_bytes(data[4:8], "little") == len(data) - 8):
        return "webp"
    if data[:6] in (b"GIF87a", b"GIF89a") and data.endswith(b";"):
        return "gif"
    raise ValueError("Ответ не является поддерживаемым JPEG, PNG, WebP или GIF")


def load_sources(root=ROOT):
    """Манифест содержит только уже используемые сайтом HTTPS-источники."""
    path = root / "data/photo-cache-sources.json"
    records = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(records, list) or not records or len(records) > 1000:
        raise ValueError("Некорректный список источников фотографий")
    seen = set()
    result = []
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("models"), list) or not record["models"]:
            raise ValueError("У источника отсутствует список моделей")
        https_url(record.get("src"))
        https_url(record.get("source"))
        if record.get("fallback"):
            https_url(record["fallback"])
        # Одна фотография может иметь несколько страниц с атрибуцией.
        # Байты скачиваются один раз, подписи остаются в js/media.js.
        if record["src"] not in seen:
            seen.add(record["src"])
            result.append(record)
    return result


def file_stem(record):
    name = unicodedata.normalize("NFKD", str(record["models"][0])).encode("ascii", "ignore").decode()
    slug = re.sub("[^a-z0-9]+", "-", name.lower()).strip("-")[:55].rstrip("-") or "component"
    digest = hashlib.sha256(record["src"].encode()).hexdigest()[:20]
    return f"{slug}-{digest}"


def cache_folder(root):
    base = root.resolve()
    folder = base / "assets/products"
    if (base / "assets").is_symlink() or folder.is_symlink() or not folder.resolve().is_relative_to(base):
        raise ValueError("Папка фотографий должна оставаться внутри проекта")
    return folder


class ImageRedirects(urllib.request.HTTPRedirectHandler):
    """Переходы разрешены лишь на известные серверы изображений из манифеста."""

    def __init__(self, hosts):
        self.hosts = hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if https_url(newurl).hostname not in self.hosts:
            raise ValueError("Перенаправление на неизвестный сервер изображения")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def read_image(response):
    if response.status != 200:
        raise ValueError(f"HTTP {response.status}")
    content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower().strip()
    if content_type not in MIME_TYPES:
        raise ValueError("Сервер вернул не изображение: " + (content_type or "нет Content-Type"))
    declared = response.headers.get("Content-Length")
    if declared is not None and (not declared.isdigit() or int(declared) > MAX_BYTES):
        raise ValueError("Недопустимый размер изображения")
    data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("Изображение превышает 8 МиБ")
    extension = image_extension(data)
    if MIME_TYPES[content_type] != extension:
        raise ValueError("Тип ответа не совпадает с содержимым изображения")
    return data, extension


def cached_file(root, record):
    """Повторный запуск использует неповреждённые файлы без загрузки из сети."""
    folder = cache_folder(root)
    for extension in ("jpg", "png", "webp", "gif"):
        path = folder / f"{file_stem(record)}.{extension}"
        if not path.is_symlink() and path.is_file() and path.stat().st_size <= MAX_BYTES:
            try:
                if image_extension(path.read_bytes()) == extension:
                    return path
            except ValueError:
                pass
    return None


def save_image(path, data):
    """Атомарно сохраняет фото; повреждённый старый файл остаётся в backup."""
    if path.is_symlink():
        raise ValueError(f"Не записываю фотографию через символическую ссылку: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    backup = None
    try:
        with tempfile.NamedTemporaryFile("wb", prefix=".sobrano-image-", dir=path.parent, delete=False) as tmp:
            temporary = Path(tmp.name)
            tmp.write(data)
            tmp.flush()
            os.fsync(tmp.fileno())
        # Проверка повторяется после записи временного файла.
        if path.is_symlink():
            raise ValueError(f"Не записываю фотографию через символическую ссылку: {path}")
        if path.exists():
            if not path.is_file():
                raise ValueError(f"Вместо фотографии находится не файл: {path}")
            # mkstemp резервирует уникальное имя: чужая резервная копия не затрётся.
            descriptor, backup_name = tempfile.mkstemp(prefix=path.name + ".backup-", dir=path.parent)
            os.close(descriptor)
            backup = Path(backup_name)
            try:
                path.replace(backup)
            except OSError:
                backup.unlink(missing_ok=True)  # только собственный пустой файл
                backup = None
                raise
        try:
            temporary.replace(path)
        except OSError as error:
            if backup is not None and not path.exists() and not path.is_symlink():
                try:
                    backup.replace(path)
                    backup = None
                except OSError:
                    pass  # исходные байты сохраняются по указанному backup-пути
            suffix = f"; прежний файл сохранён: {backup}" if backup else "; прежний файл не изменён"
            raise OSError(f"Не удалось сохранить фотографию {path}{suffix}: {error}") from error
        return backup
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def download_image(root, record, hosts, timeout=12):
    existing = cached_file(root, record)
    if existing:
        return {"src": record["src"], "path": existing.relative_to(root).as_posix(), "status": "cached"}
    errors = []
    for url in dict.fromkeys([record["src"], record.get("fallback", record["src"]) ]):
        try:
            if https_url(url).hostname not in hosts:
                raise ValueError("Неизвестный сервер изображения")
            opener = urllib.request.build_opener(ImageRedirects(hosts))
            request = urllib.request.Request(url, headers={"User-Agent": "Sobrano educational image cache/1.0"})
            with opener.open(request, timeout=timeout) as response:
                if https_url(response.geturl()).hostname not in hosts:
                    raise ValueError("Неизвестный сервер ответа")
                data, extension = read_image(response)
            path = cache_folder(root) / f"{file_stem(record)}.{extension}"
            backup = save_image(path, data)
            return {"src": record["src"], "path": path.relative_to(root).as_posix(), "status": "downloaded",
                    **({"backup": backup.relative_to(root).as_posix()} if backup else {})}
        except (OSError, ValueError, urllib.error.URLError) as error:
            errors.append(str(error))
    return {"src": record["src"], "models": record["models"], "status": "failed", "error": "; ".join(errors)}


def write_cache_index(root, records):
    """Меняется только выделенный блок, остальной реестр фотографий сохраняется."""
    index = {}
    for record in records:
        path = cached_file(root, record)
        if path:
            index[record["src"]] = path.relative_to(root).as_posix()
    source = root / "js/product-images.js"
    original = source.read_text(encoding="utf-8")
    has_block = START in original or END in original
    if has_block and (original.count(START) != 1 or original.count(END) != 1 or original.index(START) > original.index(END)):
        raise ValueError("Блок локальных фотографий повреждён; исходный JS не изменён")
    if not index and not has_block:
        return 0
    block = (START + "\n(function(root) {\n  root.SOBRANO_LOCAL_IMAGES = "
             + json.dumps(index, ensure_ascii=True, indent=2)
             + ";\n})(typeof window === 'undefined' ? globalThis : window);\n" + END)
    if has_block:
        begin, end = original.index(START), original.index(END) + len(END)
        updated = original[:begin] + block + original[end:]
    else:
        updated = original.rstrip() + "\n\n" + block + "\n"
    if updated != original:
        # Атомарная запись не оставит частичный JavaScript при сбое программы.
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=source.parent, delete=False) as tmp:
            tmp.write(updated)
            temporary = Path(tmp.name)
        try:
            temporary.replace(source)
        finally:
            temporary.unlink(missing_ok=True)
    return len(index)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="только проверить локальный кеш, без сети и изменений")
    parser.add_argument("--limit", type=int, help="скачать только первые N источников для пробного запуска")
    parser.add_argument("--timeout", type=float, default=12, help="тайм-аут одного запроса, секунд (1–60)")
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        parser.error("--limit должен быть положительным")
    if not 1 <= args.timeout <= 60:
        parser.error("--timeout должен быть от 1 до 60 секунд")
    try:
        records = load_sources()
        if args.check:
            count = sum(cached_file(ROOT, record) is not None for record in records)
            print(f"Локальные файлы: {count} из {len(records)} уникальных изображений.")
            return 0 if count == len(records) else 1
        selected = records[:args.limit] if args.limit is not None else records
        hosts = {https_url(url).hostname for record in records for url in [record["src"], record.get("fallback", record["src"])]}
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda record: download_image(ROOT, record, hosts, args.timeout), selected))
        count = write_cache_index(ROOT, records)
        downloaded = sum(result["status"] == "downloaded" for result in results)
        failed = [result for result in results if result["status"] == "failed"]
        print(f"Скачано сейчас: {downloaded}. Локально доступно: {count} из {len(records)} изображений.")
        print("Подписи, авторство и различие точной модели/линейки сохранены.")
        for result in results:
            if result.get("backup"):
                print("Восстановлено:", result["path"], "— прежний файл сохранён:", result["backup"])
        for result in failed[:10]:
            print("Не удалось:", ", ".join(result["models"]), "—", result["error"])
        if len(failed) > 10:
            print(f"Ещё ошибок: {len(failed) - 10}. Повторите запуск после восстановления доступа к источникам.")
        if args.limit is not None:
            print("Это пробная загрузка. Для полного кеша запустите команду без --limit.")
        return 1 if failed else 0
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print("Ошибка:", error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
