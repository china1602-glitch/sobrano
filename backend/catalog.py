"""Загрузка JSON, поиск, фильтры характеристик и готовых конфигураций.

Товар сохраняет позиционный id pN: ссылки, предложения и состав сборок
используют один и тот же порядок. Изображения и цены не генерируются.
"""

import json
import math
from pathlib import Path
import re
import unicodedata

from .pricing import budget


PROJECT_ROOT = Path(__file__).resolve().parent.parent
CATEGORIES = {
    "cpu": "Процессоры", "gpu": "Видеокарты",
    "motherboard": "Материнские платы", "ram": "Оперативная память",
    "storage": "SSD и HDD", "psu": "Блоки питания",
    "case": "Корпуса", "cooling": "Охлаждение",
}
# key, подпись, поле v, разделять несколько значений, оформление значения.
_FACETS = {
    "cpu": [("socket", "Сокет", 0, False, ""),
            ("cores", "Количество ядер", 5, False, ""),
            ("graphics", "Встроенная графика", 3, False, "bool"),
            ("type", "Поддерживаемая память", 1, True, "")],
    "gpu": [("family", "Семейство GPU", None, False, "family"),
            ("vram", "Видеопамять", 3, False, "ГБ")],
    "motherboard": [("socket", "Сокет", 0, False, ""),
                    ("type", "Тип памяти", 1, False, ""),
                    ("format", "Форм-фактор", 2, False, "")],
    "ram": [("type", "Тип памяти", 0, False, ""),
            ("capacity", "Общий объём комплекта", 1, False, "ГБ"),
            ("modules", "Модулей в комплекте", 2, False, "number"),
            ("speed", "Скорость памяти", 3, False, "MT/s")],
    "storage": [("interface", "Интерфейс", 0, False, ""),
                ("capacity", "Объём накопителя", 1, False, "ГБ")],
    "psu": [("watts", "Мощность", 0, False, "Вт")],
    "case": [("format", "Поддерживаемые платы", 0, True, "")],
    "cooling": [("socket", "Поддерживаемый сокет", 0, True, "")],
}


def load_catalog(rootPath=None):
    """Читает канонический data/catalog.json относительно папки проекта."""
    path = (Path(rootPath) if rootPath is not None else PROJECT_ROOT) / "data" / "catalog.json"
    with path.open(encoding="utf-8-sig") as handle:
        raw = json.load(handle)
    if not isinstance(raw, dict) or not isinstance(raw.get("products"), list):
        raise ValueError("Каталог должен содержать массив products")
    if not isinstance(raw.get("builds", []), list):
        raise ValueError("builds должен быть массивом")
    offers_path = path.parent / "offers.json"
    if offers_path.exists():
        with offers_path.open(encoding="utf-8-sig") as handle:
            offers = json.load(handle)
        if not isinstance(offers, list):
            raise ValueError("offers должен быть массивом")
        raw["offers"] = offers
    else:
        raw["offers"] = []
    return raw


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(result):
        return None
    return int(result) if result.is_integer() else result


def normalize_products(rawrows):
    """Преобразует компактные строки данных в объекты для API и проверок."""
    if not isinstance(rawrows, list):
        return []
    products = []
    for i, row in enumerate(rawrows):
        if not isinstance(row, (list, tuple)) or len(row) < 4:
            raise ValueError(f"Некорректная строка товара p{i}")
        name = str(row[1])
        price = _number(row[2])
        products.append({
            "i": i, "id": f"p{i}", "c": row[0], "name": name,
            "price": price if price is not None and price >= 0 else None,
            "v": ["" if value is None else str(value) for value in row[3]] if isinstance(row[3], list) else [],
            "brand": name.split(" ")[0],
        })
    return products


def _param(params, key):
    value = params.get(key, "") if isinstance(params, dict) else ""
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ""
    return "" if value is None else str(value)


def _limit(params, key):
    text = _param(params, key).strip()
    value = _number(text) if text else None
    return value if value is not None and value >= 0 else None


def _natural_key(value):
    # Сортировка без изменения process-wide locale: цифры идут как числа,
    # регистр и диакритика не влияют на порядок (как Intl sensitivity: base).
    text = "".join(c for c in unicodedata.normalize("NFKD", str(value).casefold()) if not unicodedata.combining(c))
    return tuple((ord("0"), int(part)) if part.isascii() and part.isdigit() else (ord(part), 0) for part in re.findall(r"[0-9]+|[^0-9]", text))


def _values(product, definition):
    key, _, index, multiple, _ = definition
    if key == "family":
        name = product.get("name", "")
        if re.search(r"\b(?:GeForce|NVIDIA)\b", name, re.I | re.ASCII):
            return ["nvidia"]
        if re.search(r"\bRadeon\b", name, re.I | re.ASCII):
            return ["radeon"]
        if re.search(r"\bArc\b", name, re.I | re.ASCII):
            return ["arc"]
        return []
    fields = product.get("v", [])
    value = str(fields[index]).strip() if index < len(fields) and fields[index] is not None else ""
    return [part for part in value.split(":") if part] if multiple else ([value] if value else [])


def _display_price(product, price_map):
    info = price_map.get(product["id"]) if isinstance(price_map, dict) else None
    value = info.get("value") if isinstance(info, dict) else info
    if info is None:
        value = product.get("displayPrice", product.get("price"))
    return _number(value) or 0


def filter_products(products, params, category="", price_map=None):
    """Все слова поиска, бренд, цена и категорийные характеристики вместе."""
    category = category if category in CATEGORIES else ""
    tokens = _param(params, "search").lower().split()
    brand = _param(params, "brand")
    minimum, maximum = _limit(params, "min"), _limit(params, "max")
    active = [(definition, _param(params, definition[0])) for definition in _FACETS.get(category, []) if _param(params, definition[0])]
    rows = []
    for product in products:
        if category and product["c"] != category:
            continue
        product_brand = product.get("brand") or product["name"].split(" ")[0]
        if brand and brand != product_brand:
            continue
        price = _display_price(product, price_map)
        if minimum is not None and price < minimum or maximum is not None and price > maximum:
            continue
        text = " ".join([product["name"], product_brand, *map(str, product.get("v", []))]).lower()
        if not all(token in text for token in tokens):
            continue
        if not all(selected in _values(product, definition) for definition, selected in active):
            continue
        rows.append(product)
    order = _param(params, "sort")
    if order in ("asc", "desc"):
        direction = -1 if order == "desc" else 1
        rows.sort(key=lambda product: (direction * _display_price(product, price_map), _natural_key(product["name"])))
    else:
        rows.sort(key=lambda product: _natural_key(product["name"]))
    return rows


def _format_option(value, style):
    if style == "bool":
        return {"1": "Есть", "0": "Нет"}.get(value, value)
    if style == "family":
        return {"nvidia": "NVIDIA GeForce", "radeon": "AMD Radeon", "arc": "Intel Arc"}.get(value, value)
    if not style:
        return value
    number = _number(value)
    formatted = f"{number:,}".replace(",", "\u00a0") if number is not None else value
    return formatted if style == "number" else formatted + " " + style


def facets(category, products=None):
    """Варианты берутся из реальных непустых характеристик категории."""
    result = []
    rows = [product for product in (products or []) if product["c"] == category]
    for definition in _FACETS.get(category, []):
        key, label, _, _, style = definition
        values = sorted({value for product in rows for value in _values(product, definition)}, key=_natural_key)
        if values:
            result.append({"key": key, "label": label, "options": [{"value": value, "label": _format_option(value, style)} for value in values]})
    return result


def build_parts(build, products):
    if not isinstance(build, (list, tuple)) or len(build) < 4 or not isinstance(build[3], list):
        return {}
    result = {}
    for category, index in zip(CATEGORIES, build[3]):
        if type(index) is int and 0 <= index < len(products) and products[index]["c"] == category:
            result[category] = index
    return result


def filter_builds(builds, products, prices, task="", max_price=None):
    """Подбор готовых конфигураций по задаче и той же цене, что в бюджете."""
    maximum = _number(max_price)
    # Пустое поле и 0 в форме готовых сборок означают «без ограничения».
    if maximum is not None and maximum <= 0:
        maximum = None
    return [build for build in builds if (not task or build[1] == task) and (maximum is None or budget(build_parts(build, products), products, prices)["value"] <= maximum)]
