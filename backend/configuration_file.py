"""Чтение и запись пользовательской сборки без изменения каталога.

Файл хранит номера и названия моделей, а не введённые пользователем цены.
При открытии стоимость заново вычисляется из каталога и предложений.
"""

import json
from pathlib import Path

from .catalog import CATEGORIES
from .compatibility import assess, check, validate_parts
from .pricing import budget


MAX_FILE_BYTES = 128 * 1024
FILE_FORMAT = "sobrano.configuration"


def validate_configuration(document, products):
    """Вернуть проверенный состав; неизвестные модели и конфликты запрещены."""
    if not isinstance(document, dict) or set(document) != {"format", "version", "parts"}:
        raise ValueError("Файл должен содержать format, version и parts.")
    if document["format"] != FILE_FORMAT or type(document["version"]) is not int or document["version"] != 1:
        raise ValueError("Это не поддерживаемый файл сборки СОБРАНО (версия 1).")
    rows = document["parts"]
    if not isinstance(rows, dict):
        raise ValueError("Поле parts должно содержать категории и модели.")
    parts = {}
    for category, item in rows.items():
        if category not in CATEGORIES or not isinstance(item, dict) or set(item) != {"id", "name"}:
            raise ValueError("Некорректная категория или описание модели в файле.")
        identifier = item["id"]
        if not isinstance(identifier, str) or not identifier.startswith("p") or not identifier[1:].isascii() or not identifier[1:].isdigit():
            raise ValueError("Неверный идентификатор модели.")
        index = int(identifier[1:])
        if not 0 <= index < len(products) or products[index]["id"] != identifier:
            raise ValueError("Модель отсутствует в текущем каталоге: " + identifier)
        if item["name"] != products[index]["name"]:
            raise ValueError("Название модели изменилось в каталоге: " + identifier)
        parts[category] = index
    parts = validate_parts(parts, products)
    conflicts = check(parts, products)["bad"]
    # assess также проверяет нижнюю границу мощности в неполной сборке,
    # например «RTX 4090 + БП 550 Вт», когда CPU ещё не выбран.
    for index in parts.values():
        for conflict in assess(index, parts, products)["conflicts"]:
            if conflict not in conflicts:
                conflicts.append(conflict)
    if conflicts:
        raise ValueError("Несовместимые детали: " + " ".join(conflicts))
    return parts


def configuration_document(parts, products):
    """Сформировать переносимый документ без копии цен и личных данных."""
    clean = validate_parts(parts, products)
    document = {
        "format": FILE_FORMAT,
        "version": 1,
        "parts": {category: {"id": products[index]["id"], "name": products[index]["name"]}
                  for category, index in clean.items()},
    }
    validate_configuration(document, products)
    return document


def _unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Поле повторяется в JSON: " + key)
        result[key] = value
    return result


def read_configuration(path, products):
    """Открыть небольшой JSON; ошибка не меняет текущую сборку приложения."""
    with Path(path).open("rb") as handle:
        raw = handle.read(MAX_FILE_BYTES + 1)
    if len(raw) > MAX_FILE_BYTES:
        raise ValueError("Файл слишком большой: допустимо не более 128 КБ.")
    try:
        document = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=_unique_keys)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise ValueError("Не удалось прочитать JSON сборки. Выберите файл, сохранённый в СОБРАНО.") from error
    return validate_configuration(document, products)


def write_text(path, text, *, overwrite=False):
    """По умолчанию не заменяет существующий пользовательский файл."""
    with Path(path).open("w" if overwrite else "x", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def save_configuration(path, parts, products, *, overwrite=False):
    text = json.dumps(configuration_document(parts, products), ensure_ascii=False, indent=2) + "\n"
    write_text(path, text, overwrite=overwrite)


def money(value):
    return f"{value:,.0f}".replace(",", " ") + " ₸"


def configuration_text(parts, products, prices):
    """Отчёт с явным разделением расчётных цен и снимков магазинов."""
    clean = validate_parts(parts, products)
    lines = ["СОБРАНО — состав компьютера", ""]
    for category, index in clean.items():
        product = products[index]
        price = prices[product["id"]]
        source = "расчётная цена"
        if price["kind"] == "snapshot":
            offer = price["offer"]
            source = "цена из сохранённого предложения, " + offer["checkedAt"][:10]
        lines.append(f"{CATEGORIES[category]}: {product['name']} — {money(price['value'])} ({source})")
    total = budget(clean, products, prices)
    lines.extend(["", "Итого: " + money(total["value"]),
                  f"Сохранённых цен магазинов: {total['snapshots']}; расчётных: {total['estimates']}."])
    result = check(clean, products)
    if result["bad"]:
        lines.append("Конфликты: " + " ".join(result["bad"]))
    if result["missing"]:
        lines.append("Не выбраны: " + ", ".join(CATEGORIES[c] for c in result["missing"]))
    lines.append("Проверяются известные параметры каталога; BIOS, разъёмы и монтаж зависят от конкретного исполнения.")
    return "\n".join(lines) + "\n"
