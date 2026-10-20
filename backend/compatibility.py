"""Подбор компонентов и проверка сборки без JavaScript и внешних пакетов.

products — нормализованный список словарей i/id/c/name/price/v/brand.
validate_parts используется на границе HTTP API и отклоняет неверный ввод.
assess и check сами не меняют переданный состав или каталог.
"""

from math import ceil, isfinite
import re


CATEGORIES = ("cpu", "gpu", "motherboard", "ram", "storage", "psu", "case", "cooling")


def _field(product, index):
    values = product.get("v", []) if product else []
    return values[index] if isinstance(values, (list, tuple)) and index < len(values) else None


def _present(value):
    return value is not None and str(value).strip() != ""


def _number(value):
    if not _present(value) or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (ValueError, TypeError):
        return None
    return number if isfinite(number) else None


def _positive(value):
    number = _number(value)
    return number is not None and number > 0


def _flag(value):
    if isinstance(value, bool):
        return None
    if type(value) in (int, float):
        return int(value) if value in (0, 1) else None
    return int(value) if value in ("0", "1") else None


def _normalized(value):
    return str(value if value is not None else "").strip().upper()


def _list(value):
    return [_normalized(item) for item in str(value).split(":")]


def _format(value):
    text = re.sub(r"[^A-Z0-9]", "", _normalized(value))
    return "MATX" if text == "MICROATX" else text


def _valid(index, products):
    return type(index) is int and 0 <= index < len(products) and isinstance(products[index], dict)


def _clean_parts(parts, products):
    if not isinstance(parts, dict):
        return {}
    return {
        category: parts[category]
        for category in CATEGORIES
        if _valid(parts.get(category), products)
        and products[parts[category]].get("c") == category
    }


def validate_parts(parts, products):
    """Проверить пользовательский JSON; неверный состав вызывает ValueError.

    Пустой словарь допустим. Индексы — целые числа, bool не является индексом.
    Строки, неизвестные категории и товар в чужой категории отклоняются.
    """
    if not isinstance(parts, dict):
        raise ValueError("Состав должен быть объектом категорий и номеров товаров.")
    for category, index in parts.items():
        if category not in CATEGORIES:
            raise ValueError("Неизвестная категория компонента: " + str(category))
        if not _valid(index, products):
            raise ValueError("Неверный номер компонента в категории " + category)
        if products[index].get("c") != category:
            raise ValueError("Компонент не принадлежит категории " + category)
    return {category: parts[category] for category in CATEGORIES if category in parts}


def _append(items, message):
    if message not in items:
        items.append(message)


def _pairs(parts, products, candidate_category=None):
    """Общие попарные ограничения; кандидат проверяет только связанные пары."""
    selected = {category: products[index] for category, index in parts.items()}
    cpu, board, ram, gpu, psu, box, cooler = (
        selected.get(category)
        for category in ("cpu", "motherboard", "ram", "gpu", "psu", "case", "cooling")
    )
    bad, unknown = [], []
    full = candidate_category is None

    def enabled(*categories):
        return full or candidate_category in categories

    def wording(whole, candidate):
        return whole if full else candidate

    def unsure(message):
        _append(unknown, message)

    def fail(message):
        _append(bad, message)

    def cpu_board():
        if not (cpu and board and enabled("cpu", "motherboard")):
            return
        if not _present(_field(cpu, 0)) or not _present(_field(board, 0)):
            unsure(wording("Не указан сокет процессора или материнской платы.", "Не указан сокет процессора или платы."))
        elif _normalized(_field(cpu, 0)) != _normalized(_field(board, 0)):
            fail(wording("Сокеты процессора и материнской платы отличаются.", "Сокет процессора не совпадает с сокетом материнской платы."))

    def cpu_ram():
        if not (cpu and ram and enabled("cpu", "ram")):
            return
        if not _present(_field(cpu, 1)) or not _present(_field(ram, 0)):
            unsure("Не указан поддерживаемый процессором тип памяти.")
        elif _normalized(_field(ram, 0)) not in _list(_field(cpu, 1)):
            fail(wording("Тип памяти не поддерживается процессором.", "Процессор не поддерживает выбранный тип памяти."))

    def board_ram():
        if not (board and ram and enabled("motherboard", "ram")):
            return
        if not _present(_field(board, 1)) or not _present(_field(ram, 0)):
            unsure(wording("Не указан тип памяти платы или выбранных модулей.", "Не указан тип памяти платы или модулей."))
        elif _normalized(_field(board, 1)) != _normalized(_field(ram, 0)):
            fail("Тип памяти не поддерживается материнской платой.")
        if not _positive(_field(ram, 1)) or not _positive(_field(board, 4)):
            unsure(wording("Не указан объём памяти или максимальный объём для платы.", "Не указан объём памяти или допустимый объём для платы."))
        elif _number(_field(ram, 1)) > _number(_field(board, 4)):
            fail(wording("Объём памяти превышает максимум материнской платы.", "Объём памяти превышает предел материнской платы."))
        if not _positive(_field(ram, 2)) or not _positive(_field(board, 3)):
            unsure(wording("Не указано число модулей памяти или слотов платы.", "Не указано количество слотов платы или модулей памяти."))
        elif _number(_field(ram, 2)) > _number(_field(board, 3)):
            fail(wording("На материнской плате недостаточно слотов памяти.", "Для выбранных модулей недостаточно слотов памяти."))

    def cpu_cooler():
        if not (cpu and cooler and enabled("cpu", "cooling")):
            return
        if not _present(_field(cpu, 0)) or not _present(_field(cooler, 0)):
            unsure(wording("Не указан сокет CPU или крепления кулера.", "Не указаны сокет CPU или крепления кулера."))
        elif _normalized(_field(cpu, 0)) not in _list(_field(cooler, 0)):
            fail(wording("Для кулера не заявлено крепление к выбранному сокету CPU.", "Для кулера не заявлено крепление к сокету процессора."))

    def board_box():
        if not (board and box and enabled("motherboard", "case")):
            return
        if not _present(_field(board, 2)) or not _present(_field(box, 0)):
            unsure("Не указан формат платы или поддерживаемые корпусом форматы.")
        elif _format(_field(board, 2)) not in [_format(value) for value in str(_field(box, 0)).split(":")]:
            fail(wording("Корпус не поддерживает форм-фактор выбранной материнской платы.", "Материнская плата не подходит по формату к корпусу."))

    def gpu_box():
        if not (gpu and box and enabled("gpu", "case")):
            return
        if not _positive(_field(gpu, 2)) or not _positive(_field(box, 1)):
            unsure(wording("Не указана длина видеокарты или допустимая длина для корпуса.", "Не указана длина видеокарты или предел корпуса: проверьте размеры."))
        elif _number(_field(gpu, 2)) > _number(_field(box, 1)):
            fail("Видеокарта длиннее допустимого размера для корпуса.")

    def cooler_box():
        if not (cooler and box and enabled("cooling", "case")):
            return
        if not _positive(_field(cooler, 1)) or not _positive(_field(box, 2)):
            unsure("Не указана высота кулера или допустимая высота для корпуса.")
        elif _number(_field(cooler, 1)) > _number(_field(box, 2)):
            fail("Кулер выше допустимого размера для корпуса.")

    def psu_box():
        if not (psu and box and enabled("psu", "case")):
            return
        if not _positive(_field(psu, 2)) or not _positive(_field(box, 3)):
            unsure(wording("Не указана длина блока питания или допустимая длина для корпуса.", "Не указана длина блока питания или предел корпуса."))
        elif _number(_field(psu, 2)) > _number(_field(box, 3)):
            fail("Блок питания длиннее допустимого размера для корпуса.")

    order = (
        (cpu_board, board_ram, cpu_ram, cpu_cooler, board_box, gpu_box, cooler_box, psu_box)
        if full else
        (cpu_board, cpu_ram, board_ram, board_box, cpu_cooler, cooler_box, gpu_box, psu_box)
    )
    for rule in order:
        rule()
    return bad, unknown


def assess(product, parts, products):
    """Оценить замену одной детали, не блокируя её из-за посторонних конфликтов."""
    index = product.get("i") if isinstance(product, dict) else product
    candidate = products[index] if _valid(index, products) else None
    if not candidate or (isinstance(product, dict) and product.get("c") != candidate.get("c")):
        return {"allowed": False, "status": "conflict", "conflicts": ["Компонент отсутствует в каталоге."], "unknown": []}
    selected = _clean_parts(parts, products)
    selected[candidate["c"]] = index
    conflicts, unknown = _pairs(selected, products, candidate["c"])
    get = lambda category: products[selected[category]] if category in selected else None
    cpu, gpu, psu = get("cpu"), get("gpu"), get("psu")

    if psu and (cpu or gpu) and candidate["c"] in ("cpu", "gpu", "psu"):
        psu_known = _positive(_field(psu, 0))
        if not psu_known:
            _append(unknown, "Не указана мощность выбранного блока питания.")
        known_load, has_known_load, recommendation = 0, False, 0
        if cpu:
            flag = _flag(_field(cpu, 7))
            if _positive(_field(cpu, 2)) and flag is not None:
                known_load += _number(_field(cpu, 2)) * (1 if flag == 1 else 1.5)
                has_known_load = True
            else:
                _append(unknown, "Недостаточно данных о мощности процессора для проверки блока питания.")
        if gpu:
            if _positive(_field(gpu, 0)):
                known_load += _number(_field(gpu, 0))
                has_known_load = True
            else:
                _append(unknown, "Не указано потребление видеокарты: окончательный подбор БП требует проверки.")
            if _positive(_field(gpu, 1)):
                recommendation = _number(_field(gpu, 1))
            else:
                _append(unknown, "Не указан рекомендованный производителем видеокарты блок питания.")
        # Это только нижняя граница известных нагрузок. Полный расчёт — check().
        load_bound = ceil((known_load + 75) * 1.25 / 50) * 50 if has_known_load else 0
        lower_bound = max(recommendation, load_bound)
        if psu_known and lower_bound > 0 and _number(_field(psu, 0)) < lower_bound:
            value = str(int(lower_bound)) if lower_bound == int(lower_bound) else str(lower_bound)
            _append(conflicts, "Мощность БП ниже расчётного порога или рекомендации видеокарты: " + value + " Вт.")
    return {
        "allowed": not conflicts,
        "status": "conflict" if conflicts else "unknown" if unknown else "compatible",
        "conflicts": conflicts,
        "unknown": unknown,
    }


def filter_products(candidates, parts, products):
    """Оставить допустимых кандидатов, сохранив порядок исходного списка."""
    return [product for product in candidates if assess(product, parts, products)["allowed"]]


def check(parts, products):
    """Проверить весь состав: конфликт, незавершённость, нехватка данных или OK."""
    selected = _clean_parts(parts, products)
    get = lambda category: products[selected[category]] if category in selected else None
    cpu, gpu, psu, cooler = (get(category) for category in ("cpu", "gpu", "psu", "cooling"))
    missing = [category for category in ("cpu", "motherboard", "ram", "storage", "psu", "case") if get(category) is None]
    unknown = []
    graphics = _flag(_field(cpu, 3)) if cpu else None
    included_cooler = _flag(_field(cpu, 4)) if cpu else None
    if cpu and not gpu:
        if graphics == 0:
            missing.append("gpu")
        elif graphics is None:
            _append(unknown, "Не указано, есть ли у процессора встроенная графика.")
    if cpu and not cooler:
        if included_cooler == 0:
            missing.append("cooling")
        elif included_cooler is None:
            _append(unknown, "Не указано, входит ли кулер в комплект процессора.")
    bad, pair_unknown = _pairs(selected, products)
    for message in pair_unknown:
        _append(unknown, message)
    if psu and not _positive(_field(psu, 0)):
        _append(unknown, "Не указана мощность выбранного блока питания.")
    need, power_known = None, cpu is not None
    power_kind = _flag(_field(cpu, 7)) if cpu else None
    if cpu and (not _positive(_field(cpu, 2)) or power_kind is None):
        _append(unknown, "Недостаточно данных о мощности CPU для расчёта блока питания.")
        power_known = False
    if gpu:
        if not _positive(_field(gpu, 0)):
            _append(unknown, "Не указано потребление видеокарты: расчёт блока питания недоступен.")
            power_known = False
        if not _positive(_field(gpu, 1)):
            _append(unknown, "Не указан рекомендованный производителем видеокарты блок питания.")
            power_known = False
    elif cpu is None or graphics != 1:
        power_known = False
    if power_known:
        cpu_power = _number(_field(cpu, 2)) * (1 if power_kind == 1 else 1.5)
        gpu_power = _number(_field(gpu, 0)) if gpu else 0
        recommendation = _number(_field(gpu, 1)) if gpu else 0
        need = ceil(max((cpu_power + gpu_power + 75) * 1.25, recommendation) / 50) * 50
        if psu and _positive(_field(psu, 0)) and _number(_field(psu, 0)) < need:
            formatted = format(need, ",").replace(",", "\u00a0")
            bad.append("Мощность блока питания ниже расчётного минимума: " + formatted + " Вт.")
    return {
        "bad": bad,
        "missing": missing,
        "unknown": unknown,
        "need": need,
        "status": "conflict" if bad else "incomplete" if missing else "unknown" if unknown else "ok",
    }
