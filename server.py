"""Локальный сервер СОБРАНО. Python 3, только стандартная библиотека.

Запуск в терминале VS Code: py server.py
Сервер отдаёт HTML/CSS/JavaScript и отвечает на GET /api/health.
Логика каталога и совместимости выполняется JavaScript в браузере.
"""

import argparse
import json
import sys
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


PROJECT_ROOT = Path(__file__).resolve().parent


class SobranoHandler(SimpleHTTPRequestHandler):
    """Обрабатывает HTTP-запросы браузера к локальному проекту."""

    server_version = "SobranoPython/1.0"

    def __init__(self, *args, **kwargs):
        # Каталог задаётся явно: запуск работает даже из другой папки терминала.
        super().__init__(*args, directory=str(PROJECT_ROOT), **kwargs)

    def send_health(self, include_body=True):
        """Диагностика работающего Python-процесса, без сохранённых показаний."""
        payload = {
            "status": "ok",
            "project": "СОБРАНО",
            "backend": "Python",
            "pythonVersion": sys.version.split()[0],
            "serverTime": datetime.now().astimezone().isoformat(timespec="seconds"),
            "frontend": ["HTML", "CSS", "JavaScript"],
            "purpose": "Local HTTP server and diagnostics",
        }
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def do_GET(self):
        # На этой строке удобно поставить точку останова в VS Code.
        if urlsplit(self.path).path == "/api/health":
            self.send_health()
            return
        super().do_GET()

    def do_HEAD(self):
        if urlsplit(self.path).path == "/api/health":
            self.send_health(include_body=False)
            return
        super().do_HEAD()


def create_server(port=8080):
    """Сервер доступен на этом компьютере; порт можно изменить при запуске."""
    return ThreadingHTTPServer(("127.0.0.1", port), SobranoHandler)


def main():
    parser = argparse.ArgumentParser(description="Локальный Python-сервер СОБРАНО")
    parser.add_argument("--port", type=int, default=8080, help="Порт, по умолчанию 8080")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("порт должен быть от 1 до 65535")

    try:
        server = create_server(args.port)
    except OSError as error:
        print(f"Не удалось запустить сервер на порту {args.port}: {error}", file=sys.stderr)
        print("Остановите прежний сервер (Ctrl+C) или запустите: py server.py --port 8081", file=sys.stderr)
        return 1

    url = f"http://127.0.0.1:{server.server_port}"
    print(f"СОБРАНО — Python {sys.version.split()[0]}", flush=True)
    print(f"Папка проекта: {PROJECT_ROOT}", flush=True)
    print(f"Сайт: {url}/", flush=True)
    print(f"Диагностика Python: {url}/api/health", flush=True)
    print("Запросы браузера появятся ниже. Остановка: Ctrl+C.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
