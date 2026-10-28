"""Локальный сервер СОБРАНО. Python 3, только стандартная библиотека.

Запуск в терминале VS Code: py server.py
Сервер отдаёт сайт и выполняет поиск, расчёт стоимости и проверку
совместимости через HTTP API. JSON читается заново при каждом запросе.
"""

import argparse
import json
import math
import os
import re
import sys
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit

sys.dont_write_bytecode = True  # Не засоряем учебный проект двоичным кэшем.

from backend import catalog, compatibility, pricing


PROJECT_ROOT = Path(__file__).resolve().parent
CATEGORIES = ("cpu", "gpu", "motherboard", "ram", "storage", "psu", "case", "cooling")
MAX_BODY_BYTES = 65536


class APIError(Exception):
    """Ошибка запроса, которую можно безопасно показать браузеру."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Повторяющийся ключ JSON")
        result[key] = value
    return result


def reject_json_constant(value):
    raise ValueError(f"Недопустимое число JSON: {value}")


def validated_parts(parts, products):
    try:
        return compatibility.validate_parts(parts, products)
    except (ValueError, TypeError) as error:
        raise APIError(str(error) or "Неверный состав сборки") from error


def parts_from_query(payload, products):
    """Пустая позиция ссылки означает отсутствие компонента."""
    tokens = payload.split(",")
    if len(payload) > 256 or len(tokens) != len(CATEGORIES):
        raise APIError("В parts должно быть восемь позиций через запятую")
    parts = {}
    for category, token in zip(CATEGORIES, tokens):
        if token == "":
            continue
        if not re.fullmatch(r"0|[1-9][0-9]*", token):
            raise APIError("parts содержит недопустимый индекс товара")
        parts[category] = int(token)
    return validated_parts(parts, products)


def build_parts(build, products):
    return compatibility.validate_parts(
        {category: value for category, value in zip(CATEGORIES, build[3]) if value is not None},
        products,
    )


class SobranoHandler(SimpleHTTPRequestHandler):
    """HTTP-маршруты; бизнес-правила находятся в пакете backend."""

    server_version = "SobranoPython/2.0"

    def __init__(self, *args, **kwargs):
        kwargs.setdefault("directory", str(PROJECT_ROOT))
        super().__init__(*args, **kwargs)

    def send_json(self, payload, status=200, include_body=True):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def query_params(self):
        query = urlsplit(self.path).query
        if len(query) > 8192:
            raise APIError("Слишком длинная строка параметров")
        try:
            pairs = parse_qsl(query, keep_blank_values=True, max_num_fields=40)
        except ValueError as error:
            raise APIError("Слишком много параметров запроса") from error
        params = {}
        for key, value in pairs:
            if key in params:
                raise APIError(f"Параметр {key} не должен повторяться")
            params[key] = value
        return params

    def load_state(self):
        raw = catalog.load_catalog(Path(self.directory))
        products = catalog.normalize_products(raw["products"])
        return raw, products, pricing.prices_for(products, raw.get("offers", []))

    @staticmethod
    def number_param(params, key):
        value = params.get(key, "")
        if value == "":
            return None
        try:
            number = float(value)
        except ValueError as error:
            raise APIError(f"Параметр {key} должен быть числом") from error
        if not math.isfinite(number) or number < 0:
            raise APIError(f"Параметр {key} должен быть конечным неотрицательным числом")
        return number

    @staticmethod
    def build_results(raw, products, prices):
        results = {}
        for index, build in enumerate(raw["builds"]):
            parts = build_parts(build, products)
            results[f"b{index}"] = {
                "parts": parts,
                "check": compatibility.check(parts, products),
                "budget": pricing.budget(parts, products, prices),
            }
        return results

    def products_payload(self, params, products, prices):
        category = params.get("cat", "")
        if category and category not in CATEGORIES:
            raise APIError("Неизвестная категория товара")
        if params.get("sort", "name") not in ("", "name", "asc", "desc"):
            raise APIError("Неизвестный порядок сортировки")
        if params.get("compat", "") not in ("", "all"):
            raise APIError("Параметр compat допускает только значение all")
        minimum = self.number_param(params, "min")
        maximum = self.number_param(params, "max")
        if minimum is not None and maximum is not None and minimum > maximum:
            raise APIError("Минимальная цена не может быть больше максимальной")
        parts = parts_from_query(params["parts"], products) if "parts" in params else {}
        candidates = products
        if "ids" in params:
            ids = params["ids"].split(",") if params["ids"] else []
            if len(ids) > len(products) or any(
                not re.fullmatch(r"p(?:0|[1-9][0-9]*)", item) for item in ids
            ):
                raise APIError("ids должен содержать идентификаторы товаров через запятую")
            selected = set(ids)
            if selected - {product["id"] for product in products}:
                raise APIError("В ids указан несуществующий товар")
            candidates = [product for product in products if product["id"] in selected]
        filtered = catalog.filter_products(candidates, params, category=category, price_map=prices)
        rows = filtered if params.get("compat") == "all" else [
            product for product in filtered
            if compatibility.assess(product, parts, products)["allowed"]
        ]
        return {
            "ids": [product["id"] for product in rows],
            "total": len(candidates),
            "filteredTotal": len(filtered),
            "hidden": len(filtered) - len(rows),
        }

    def builds_payload(self, params, raw, products, prices):
        maximum = self.number_param(params, "budget")
        if maximum is not None and (maximum != int(maximum) or maximum > 9007199254740991):
            raise APIError("Бюджет должен быть неотрицательным целым числом тенге")
        task = params.get("task", "")
        results = self.build_results(raw, products, prices)
        return {"ids": [
            f"b{index}" for index, build in enumerate(raw["builds"])
            if (not task or build[1] == task)
            and (maximum is None or results[f"b{index}"]["budget"]["value"] <= maximum)
        ]}

    def read_configuration(self, products):
        if self.headers.get_content_type() != "application/json":
            raise APIError("Требуется Content-Type: application/json")
        value = self.headers.get("Content-Length")
        if value is None or not re.fullmatch(r"[0-9]+", value):
            raise APIError("Нужна корректная длина тела запроса Content-Length")
        if len(value.lstrip("0")) > 5:
            self.close_connection = True
            raise APIError("Тело запроса не должно превышать 65536 байт", 413)
        length = int(value.lstrip("0") or "0")
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            raise APIError("Тело запроса не должно превышать 65536 байт", 413)
        if length == 0:
            raise APIError("Нужно непустое тело JSON")
        try:
            payload = json.loads(
                self.rfile.read(length).decode("utf-8"),
                object_pairs_hook=strict_object,
                parse_constant=reject_json_constant,
            )
        except (ValueError, UnicodeDecodeError) as error:
            raise APIError("Тело запроса содержит некорректный JSON") from error
        if not isinstance(payload, dict) or set(payload) != {"parts"}:
            raise APIError("Ожидается JSON-объект с единственным полем parts")
        return validated_parts(payload["parts"], products)

    def api_response(self, include_body=True, method="GET"):
        """True означает, что маршрут обработан, включая ошибки API."""
        path = urlsplit(self.path).path
        if path != "/runtime.json" and path != "/api" and not path.startswith("/api/"):
            return False
        try:
            if path == "/runtime.json":
                if method != "GET":
                    raise APIError("Для этого маршрута используется GET", 405)
                runtime = {"backend": "python", "apiBase": "api/"}
                if os.environ.get("SOBRANO_DEBUG") == "1":
                    # На точке останова запрос ждёт продолжения F5 без тайм-аута браузера.
                    runtime["requestTimeoutMs"] = 0
                self.send_json(runtime, include_body=include_body)
                return True
            routes = {"/api/health", "/api/catalog", "/api/products", "/api/builds", "/api/configuration"}
            if path not in routes:
                raise APIError("Маршрут API не найден", 404)
            expected_method = "POST" if path == "/api/configuration" else "GET"
            if method != expected_method:
                raise APIError("Метод не поддерживается этим маршрутом", 405)
            params = self.query_params()
            raw, products, prices = self.load_state()
            if path == "/api/health":
                payload = {
                    "status": "ok", "project": "СОБРАНО", "backend": "Python",
                    "pythonVersion": sys.version.split()[0],
                    "serverTime": datetime.now().astimezone().isoformat(timespec="seconds"),
                    "frontend": ["HTML", "CSS", "JavaScript"],
                    "purpose": "Catalog, price calculations and PC compatibility backend",
                    "products": len(products), "builds": len(raw["builds"]),
                    "offers": len(raw.get("offers", [])),
                }
            elif path == "/api/catalog":
                payload = {
                    "products": raw["products"], "builds": raw["builds"],
                    "photos": raw.get("photos", {}), "offers": raw.get("offers", []),
                    "prices": prices, "buildResults": self.build_results(raw, products, prices),
                }
            elif path == "/api/products":
                payload = self.products_payload(params, products, prices)
            elif path == "/api/builds":
                payload = self.builds_payload(params, raw, products, prices)
            else:
                parts = self.read_configuration(products)
                payload = {
                    "parts": parts,
                    "check": compatibility.check(parts, products),
                    "budget": pricing.budget(parts, products, prices),
                    "assessments": {
                        product["id"]: compatibility.assess(product, parts, products)
                        for product in products
                    },
                }
            self.send_json(payload, include_body=include_body)
        except APIError as error:
            self.send_json({"error": str(error)}, error.status, include_body=include_body)
        except Exception:
            self.log_error("Не удалось обработать запрос API")
            self.send_json({"error": "Не удалось обработать данные проекта"}, 500, include_body=include_body)
        return True

    def public_path(self):
        # Отдаём только ресурсы интерфейса. База аккаунтов и исходники не публичны
        # даже при случайном запуске старого Python-сервера вместо Node.js.
        path = unquote(urlsplit(self.path).path).replace("\\", "/")
        if path == "/runtime.json" or path == "/api" or path.startswith("/api/"):
            return True
        relative = "index.html" if path == "/" else path.lstrip("/")
        allowed = re.fullmatch(
            r"(?:[a-z]+\.html|js/[a-z-]+\.js|css/[a-z-]+\.css|data/[a-z-]+\.json|"
            r"assets/(?:favicon\.svg|fonts/[\w.-]+|products/[\w.-]+))", relative
        )
        root = Path(self.directory).resolve()
        target = (root / relative).resolve()
        if not allowed or not target.is_relative_to(root) or not target.is_file():
            self.send_error(404, "File not found")
            return False
        return True

    def do_GET(self):
        if self.public_path() and not self.api_response():
            super().do_GET()

    def do_HEAD(self):
        if self.public_path() and not self.api_response(include_body=False):
            super().do_HEAD()

    def do_POST(self):
        if not self.api_response(method="POST"):
            self.send_json({"error": "Маршрут API не найден"}, 404)

    def unsupported_method(self):
        if not self.api_response(method=self.command):
            self.send_json({"error": "Метод не поддерживается"}, 405)

    do_PUT = unsupported_method
    do_PATCH = unsupported_method
    do_DELETE = unsupported_method
    do_OPTIONS = unsupported_method


def create_server(port=8080, root=None, host="127.0.0.1"):
    """По умолчанию доступен только на этом ПК; LAN включается явно через --host."""
    handler = partial(SobranoHandler, directory=str(root or PROJECT_ROOT))
    return ThreadingHTTPServer((host, port), handler)


def main():
    parser = argparse.ArgumentParser(description="Локальный Python-сервер СОБРАНО")
    parser.add_argument("--port", type=int, default=8080, help="Порт, по умолчанию 8080")
    parser.add_argument("--host", choices=("127.0.0.1", "0.0.0.0"), default="127.0.0.1",
                        help="127.0.0.1 — этот ПК; 0.0.0.0 — доступ из локальной сети")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("порт должен быть от 1 до 65535")

    try:
        server = create_server(args.port, host=args.host)
    except OSError as error:
        print(f"Не удалось запустить сервер на порту {args.port}: {error}", file=sys.stderr)
        print("Остановите прежний сервер (Ctrl+C) или запустите: py server.py --port 8081", file=sys.stderr)
        return 1

    url = f"http://127.0.0.1:{server.server_port}"
    print(f"СОБРАНО — Python {sys.version.split()[0]}", flush=True)
    print(f"Папка проекта: {PROJECT_ROOT}", flush=True)
    print(f"Сайт: {url}/", flush=True)
    print(f"Каталог API: {url}/api/catalog", flush=True)
    print(f"Диагностика Python: {url}/api/health", flush=True)
    if args.host == "0.0.0.0":
        print("Локальная сеть включена. Подключите телефон к той же сети Wi-Fi.", flush=True)
        print(f"На телефоне откройте http://<IPv4-компьютера>:{server.server_port}/", flush=True)
        print("IPv4 смотрите в команде ipconfig (Windows). Разрешите Python для частной сети в брандмауэре.", flush=True)
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
