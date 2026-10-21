#!/usr/bin/env python3
"""Локальный HTTP-сервер и настоящий Python API. Python 3.10+, без pip."""
import argparse
import json
import logging
import os
import re
import sqlite3
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.dont_write_bytecode = True

from app.service import AppError, Store
from app.reports import render_report

ROOT = Path(__file__).resolve().parent
VERSION = "1.0.0"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "web"), **kwargs)

    def setup(self):
        super().setup()
        if not os.environ.get("PRAKTIKUM_DEBUG"):
            self.connection.settimeout(15)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
        super().end_headers()

    def respond(self, payload, status=200, mime="application/json; charset=utf-8", filename=None):
        if isinstance(payload, (dict, list)):
            payload = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(payload)))
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(payload)

    def route(self):
        parsed = urlsplit(self.path)
        query = {k: v[0] for k, v in parse_qs(parsed.query, keep_blank_values=True).items()}
        if self.headers.get("Host") not in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"):
            raise AppError("Используйте локальный адрес, показанный в терминале.", 403)
        return parsed.path, query

    def guarded(self, callback):
        try:
            callback()
        except AppError as error:
            self.respond({"error": str(error)}, error.status)
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.respond({"error": "Не удалось прочитать JSON. Проверьте формат файла."}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            logging.exception("Ошибка обработки запроса")
            self.respond({"error": "Не удалось выполнить операцию. Данные не изменены; подробности в терминале сервера."}, 500)

    def do_GET(self):
        self.guarded(self.get)

    def get(self):
        path, query = self.route()
        if path == "/api/health":
            return self.respond({"ok": True, "application": "Практикум", "version": VERSION,
                                 "python": sys.version.split()[0], "sqlite": sqlite3.sqlite_version})
        if path.startswith("/api/"):
            store = Store(self.server.data_dir, query.get("mode", "personal"))
            if path == "/api/state":
                return self.respond(store.state(query))
            if path == "/api/backup":
                return self.respond(store.backup(), filename=f"praktikum-{store.mode}.json")
            if path == "/api/csv":
                return self.respond(store.csv(query), mime="text/csv; charset=utf-8", filename="praktikum-diary.csv")
            if path == "/api/report":
                return self.respond(render_report(store.state(query), query.get("from", ""), query.get("to", "")), mime="text/html; charset=utf-8")
            raise AppError("Такого API нет.", 404)
        # Публичная папка отделена от исходников и пользовательской базы.
        return super().do_GET()

    def do_HEAD(self):
        def head():
            path, _ = self.route()
            if path.startswith("/api/"):
                self.send_response(405)
                self.end_headers()
            else:
                super(Handler, self).do_HEAD()
        self.guarded(head)

    def do_POST(self):
        self.guarded(self.write)

    def do_PUT(self):
        self.guarded(self.write)

    def do_DELETE(self):
        self.guarded(self.write)

    def write(self):
        path, query = self.route()
        allowed_origins = {f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"}
        if self.headers.get("Origin") and self.headers["Origin"] not in allowed_origins:
            raise AppError("Запрос с постороннего сайта запрещён.", 403)
        if self.headers.get("X-Praktikum-Request") != "1":
            raise AppError("Откройте приложение через его локальный адрес.", 403)
        if self.headers.get_content_type() != "application/json":
            raise AppError("Ожидается application/json.", 415)
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise AppError("Некорректный размер запроса.") from None
        if size < 2 or size > 2 * 1024 * 1024:
            raise AppError("Допустимый размер запроса — от 2 байт до 2 МБ.", 413)
        data = json.loads(self.rfile.read(size))
        match = re.fullmatch(r"/api/(tasks|entries|profile|restore)(?:/([1-9][0-9]*))?", path)
        if not match:
            raise AppError("Действие не найдено.", 404)
        resource, raw_id = match.groups()
        item_id = int(raw_id) if raw_id else None
        if resource in ("profile", "restore") and item_id is not None:
            raise AppError("Действие не найдено.", 404)
        if resource in ("tasks", "entries") and ((self.command == "POST") == bool(item_id)):
            raise AppError("Неверный адрес операции.", 405)
        store = Store(self.server.data_dir, query.get("mode", "personal"))
        return self.respond(store.mutate(resource, self.command, data, self.headers.get("If-Match"), item_id), 201 if self.command == "POST" and item_id is None and resource in ("tasks", "entries") else 200)


def create_server(port=8090, data_dir=None):
    directory = Path(data_dir or ROOT / "storage")
    Store(directory, "personal")
    Store(directory, "demo")
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.data_dir = directory
    return server


def main():
    parser = argparse.ArgumentParser(description="Локальный сервер Практикума")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "storage", help="Папка SQLite; по умолчанию storage")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("порт должен быть от 1 до 65535")
    try:
        server = create_server(args.port, args.data_dir)
    except OSError as error:
        print(f"Не удалось запустить сервер: {error}\nЗакройте старый сервер клавишами Ctrl+C или выполните: py server.py --port 8091")
        return 1
    print(f"\nПРАКТИКУМ · Python {sys.version.split()[0]} · SQLite {sqlite3.sqlite_version}\n"
          f"Сайт: http://127.0.0.1:{server.server_port}/\nБаза: {server.data_dir.resolve()}\n"
          "Оставьте терминал открытым. Остановка: Ctrl+C.\n", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен. Данные сохранены.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
