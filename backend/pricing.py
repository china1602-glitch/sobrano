"""Цены и бюджет: зафиксированные предложения отдельно от учебных оценок.

Сетевых запросов здесь нет. Источник — data/offers.json; дату фиксации
нельзя заменять временем запуска сервера. Правила совпадают с js/pricing.js.
"""

from collections import defaultdict
from datetime import datetime, timedelta, timezone
import math
import re
from urllib.parse import urlsplit


MAX_SNAPSHOT_AGE = timedelta(days=30)
FUTURE_TOLERANCE = timedelta(minutes=5)
_PRODUCT_ID = re.compile(r"p[0-9]+\Z")


def _finite_number(value):
    """JSON boolean и числовая строка не являются магазинной ценой."""
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _checked_at(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        result = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    # Набор данных использует явный +05:00; без смещения считаем время UTC.
    if result.tzinfo is None:
        result = result.replace(tzinfo=timezone.utc)
    return result.astimezone(timezone.utc)


def valid_offers(offers):
    """Проверенные по структуре снимки, включая устаревшие для истории."""
    result = []
    for offer in offers if isinstance(offers, list) else []:
        if not isinstance(offer, dict):
            continue
        product_id = offer.get("productId")
        if not isinstance(product_id, str) or not _PRODUCT_ID.fullmatch(product_id):
            continue
        price = offer.get("price")
        url = offer.get("url")
        if offer.get("currency") != "KZT" or not _finite_number(price) or price <= 0:
            continue
        if not isinstance(url, str) or not url.startswith("https://"):
            continue
        try:
            if not urlsplit(url).netloc:
                continue
        except ValueError:
            continue
        if _checked_at(offer.get("checkedAt")) is None:
            continue
        result.append(offer)
    return result


def offers_for(product, offers):
    """История предложений модели; срок и наличие не скрывают источник."""
    return [offer for offer in valid_offers(offers) if offer["productId"] == product["id"]]


def prices_for(products, offers, now=None):
    """Цена каждой модели: минимум свежих снимков либо расчётная оценка.

    now — datetime для воспроизводимой проверки. Известное отсутствие
    исключает снимок; отсутствие сведений о наличии не превращается в «есть».
    """
    moment = datetime.now(timezone.utc) if now is None else now
    if not isinstance(moment, datetime):
        raise TypeError("now должен быть datetime")
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    moment = moment.astimezone(timezone.utc)
    eligible = defaultdict(list)
    for offer in valid_offers(offers):
        age = moment - _checked_at(offer["checkedAt"])
        if -FUTURE_TOLERANCE <= age <= MAX_SNAPSHOT_AGE and offer.get("availability") != "out-of-stock":
            eligible[offer["productId"]].append(offer)
    result = {}
    for product in products:
        current = eligible.get(product["id"], [])
        if current:
            selected = min(current, key=lambda offer: offer["price"])
            result[product["id"]] = {
                "value": selected["price"], "kind": "snapshot",
                "offer": selected, "count": len(current),
            }
        else:
            result[product["id"]] = {
                "value": product.get("price"), "kind": "estimate",
                "offer": None, "count": 0,
            }
    return result


def budget(parts, products, prices):
    """Суммирует выбранные позиции, сохраняя состав цены видимым."""
    value = 0
    snapshots = 0
    estimates = 0
    for index in parts.values() if isinstance(parts, dict) else []:
        if type(index) is not int or not 0 <= index < len(products):
            continue
        product = products[index]
        info = prices.get(product["id"], {}) if isinstance(prices, dict) else {}
        amount = info.get("value", product.get("price"))
        if _finite_number(amount):
            value += amount
        if info.get("kind") == "snapshot":
            snapshots += 1
        else:
            estimates += 1
    return {"value": value, "snapshots": snapshots, "estimates": estimates}
