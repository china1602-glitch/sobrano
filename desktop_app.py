"""СОБРАНО — отдельная программа расчёта ПК на Python/Tkinter.

Запуск: py desktop_app.py. Внешние пакеты и HTTP-сервер не нужны.
Расчёт и проверка используют те же backend-модули, что и сайт.
"""

from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from backend.catalog import CATEGORIES, build_parts, load_catalog, normalize_products
from backend.compatibility import assess, check
from backend.configuration_file import (
    configuration_text, money, read_configuration, save_configuration, write_text,
)
from backend.pricing import budget, prices_for


class SobranoApp:
    """Окно, выбор деталей и команды открытия/сохранения сборки."""

    def __init__(self, root):
        self.root = root
        self.raw = load_catalog()
        self.products = normalize_products(self.raw["products"])
        self.parts = {}
        self.path = None
        self.dirty = False
        self.options = {}
        self.combos = {}
        self.details = {}
        self.status = tk.StringVar(value="Выберите готовую сборку или начните с любой детали.")
        self.total = tk.StringVar()
        self.price_note = tk.StringVar()
        self.validation = tk.StringVar()
        root.title("СОБРАНО — расчёт сборки")
        root.geometry("1100x820")
        root.minsize(840, 680)
        root.protocol("WM_DELETE_WINDOW", self.close)
        self._create_widgets()
        self.refresh()

    def _create_widgets(self):
        style = ttk.Style(self.root)
        if "clam" in style.theme_names():
            style.theme_use("clam")
        style.configure(".", font=("Arial", 11))
        style.configure("Title.TLabel", font=("Arial", 22, "bold"))
        style.configure("Total.TLabel", font=("Arial", 20, "bold"))
        style.configure("TButton", padding=(10, 7))
        page = ttk.Frame(self.root, padding=20)
        page.pack(fill="both", expand=True)
        ttk.Label(page, text="СОБРАНО. Расчёт компьютера", style="Title.TLabel").pack(anchor="w")
        ttk.Label(page, text="Каталог, цены и правила совместимости общие с сайтом.").pack(anchor="w", pady=(3, 16))
        toolbar = ttk.Frame(page)
        toolbar.pack(fill="x")
        for label, command in [("Открыть JSON", self.open_file), ("Сохранить JSON", self.save_file),
                               ("Экспорт TXT", self.export_text), ("Очистить", self.clear)]:
            ttk.Button(toolbar, text=label, command=command).pack(side="left", padx=(0, 8))
        presets = ttk.Frame(page)
        presets.pack(fill="x", pady=14)
        ttk.Label(presets, text="Готовая сборка:").pack(side="left", padx=(0, 10))
        self.preset = ttk.Combobox(presets, values=[b[0] for b in self.raw["builds"]], state="readonly", width=43)
        self.preset.pack(side="left", fill="x", expand=True)
        ttk.Button(presets, text="Загрузить состав", command=self.load_preset).pack(side="left", padx=(8, 0))
        columns = ttk.Frame(page)
        columns.pack(fill="both", expand=True)
        columns.columnconfigure(0, weight=3)
        columns.columnconfigure(1, weight=2)
        columns.rowconfigure(0, weight=1)
        slot_panel = ttk.Frame(columns)
        slot_panel.grid(row=0, column=0, sticky="nsew", padx=(0, 20))
        slot_panel.rowconfigure(0, weight=1)
        slot_panel.columnconfigure(0, weight=1)
        canvas = tk.Canvas(slot_panel, highlightthickness=0, background=style.lookup("TFrame", "background"))
        canvas.grid(row=0, column=0, sticky="nsew")
        scroll = ttk.Scrollbar(slot_panel, orient="vertical", command=canvas.yview)
        scroll.grid(row=0, column=1, sticky="ns")
        canvas.configure(yscrollcommand=scroll.set)
        slots = ttk.Frame(canvas)
        window = canvas.create_window((0, 0), window=slots, anchor="nw")
        slots.bind("<Configure>", lambda _e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.bind("<Configure>", lambda event: canvas.itemconfigure(window, width=event.width))
        slots.columnconfigure(0, weight=1)
        for position, (category, label) in enumerate(CATEGORIES.items()):
            ttk.Label(slots, text=label).grid(row=position * 3, column=0, sticky="w", pady=(5, 2))
            combo = ttk.Combobox(slots, state="readonly", width=40)
            combo.grid(row=position * 3 + 1, column=0, sticky="ew")
            combo.bind("<<ComboboxSelected>>", lambda _event, c=category: self.choose(c))
            self.combos[category] = combo
            note = tk.StringVar()
            self.details[category] = note
            ttk.Label(slots, textvariable=note, font=("Arial", 10)).grid(row=position * 3 + 2, column=0, sticky="w")
        summary = ttk.Frame(columns, padding=(16, 10))
        summary.grid(row=0, column=1, sticky="nsew")
        ttk.Label(summary, text="Стоимость компонентов").pack(anchor="w")
        ttk.Label(summary, textvariable=self.total, style="Total.TLabel").pack(anchor="w", pady=(5, 8))
        ttk.Label(summary, textvariable=self.price_note, wraplength=300, justify="left").pack(anchor="w")
        ttk.Separator(summary).pack(fill="x", pady=18)
        ttk.Label(summary, textvariable=self.validation, wraplength=300, justify="left").pack(anchor="w")
        ttk.Label(summary, text="В списках скрываются детали с известным конфликтом. Проверяются параметры каталога; BIOS, разъёмы и монтаж зависят от исполнения.",
                  wraplength=300, justify="left").pack(anchor="w", pady=18)
        ttk.Label(summary, text="JSON сохраняет состав в выбранный файл. TXT — отчёт для чтения. Данные каталога программа не изменяет.",
                  wraplength=300, justify="left").pack(anchor="w")
        ttk.Separator(page).pack(fill="x", pady=(12, 8))
        ttk.Label(page, textvariable=self.status, wraplength=1020).pack(anchor="w")

    def refresh(self):
        """Пересчитать цены и доступность каждого списка после выбора."""
        self.prices = prices_for(self.products, self.raw["offers"])
        for category, combo in self.combos.items():
            candidates = [p for p in self.products if p["c"] == category and assess(p, self.parts, self.products)["allowed"]]
            self.options[category] = [None] + [p["i"] for p in candidates]
            combo["values"] = ["— Не выбрано —"] + [p["name"] + " — " + money(self.prices[p["id"]]["value"]) for p in candidates]
            selected = self.parts.get(category)
            combo.current(self.options[category].index(selected) if selected in self.options[category] else 0)
            info = self.prices[self.products[selected]["id"]] if selected is not None else None
            self.details[category].set("Сохранённая цена магазина" if info and info["kind"] == "snapshot" else "Расчётная цена" if info else f"Доступно моделей: {len(candidates)}")
        total = budget(self.parts, self.products, self.prices)
        self.total.set(money(total["value"]))
        self.price_note.set(f"Цен из предложений магазинов: {total['snapshots']}. Расчётных цен: {total['estimates']}.\nБез периферии, доставки и услуг сборки.")
        result = check(self.parts, self.products)
        if not self.parts:
            text = "Состав пока пуст."
        elif result["bad"]:
            text = "Конфликты:\n" + "\n".join(result["bad"])
        elif result["missing"]:
            text = "Не выбраны: " + ", ".join(CATEGORIES[c] for c in result["missing"]) + "."
        else:
            text = "Обязательные компоненты выбраны. Известных конфликтов не найдено."
        if result["need"]:
            text += f"\nРасчётный минимум БП: {result['need']} Вт."
        self.validation.set(text)

    def choose(self, category):
        index = self.combos[category].current()
        if not 0 <= index < len(self.options[category]):
            return
        selected = self.options[category][index]
        if selected is None:
            self.parts.pop(category, None)
        else:
            self.parts[category] = selected
        self.dirty = True
        self.status.set("Состав изменён. Сохраните JSON, чтобы открыть его при следующем запуске.")
        self.refresh()

    def _may_replace(self, action="Заменить текущий состав?"):
        return not self.dirty or messagebox.askyesno("Текущий состав", "Есть изменения без сохранения. " + action, parent=self.root)

    def load_preset(self):
        position = self.preset.current()
        if position < 0:
            self.status.set("Сначала выберите готовую сборку в списке.")
            return
        if self._may_replace():
            build = self.raw["builds"][position]
            self.parts = build_parts(build, self.products)
            self.path = None
            self.dirty = True
            self.status.set("Загружен состав: " + build[0])
            self.refresh()

    def clear(self):
        if self._may_replace():
            self.parts = {}
            self.path = None
            self.dirty = False
            self.preset.set("")
            self.status.set("Состав очищен. Сохранённые файлы не удалены.")
            self.refresh()

    def open_file(self):
        path = filedialog.askopenfilename(parent=self.root, title="Открыть сборку СОБРАНО", filetypes=[("Сборка JSON", "*.json")])
        if not path:
            return
        try:
            parts = read_configuration(path, self.products)
        except (OSError, ValueError) as error:
            messagebox.showerror("Не удалось открыть сборку", str(error), parent=self.root)
            return
        if self._may_replace():
            self.parts = parts
            self.path = Path(path)
            self.dirty = False
            self.preset.set("")
            self.status.set("Открыт файл: " + str(self.path))
            self.refresh()

    def _save_path(self, extension):
        return filedialog.asksaveasfilename(parent=self.root, title="Сохранить состав", defaultextension=extension,
                                          initialfile="sobrano-build" + extension, confirmoverwrite=False,
                                          filetypes=[("Состав", "*" + extension)])

    def _write(self, path, save):
        try:
            save(path)
        except FileExistsError:
            if not messagebox.askyesno("Файл существует", "Заменить существующий файл?\n" + path, parent=self.root):
                return False
            try:
                save(path, overwrite=True)
            except (OSError, ValueError) as error:
                messagebox.showerror("Не удалось сохранить", str(error), parent=self.root)
                return False
        except (OSError, ValueError) as error:
            messagebox.showerror("Не удалось сохранить", str(error), parent=self.root)
            return False
        self.status.set("Сохранено: " + path)
        return True

    def save_file(self):
        path = self._save_path(".json")
        if path and self._write(path, lambda p, **kw: save_configuration(p, self.parts, self.products, **kw)):
            self.path = Path(path)
            self.dirty = False

    def export_text(self):
        path = self._save_path(".txt")
        if path:
            self._write(path, lambda p, **kw: write_text(p, configuration_text(self.parts, self.products, self.prices), **kw))

    def close(self):
        if self._may_replace("Закрыть программу без сохранения?"):
            self.root.destroy()


def main():
    root = tk.Tk()
    try:
        SobranoApp(root)
    except (OSError, ValueError) as error:
        root.withdraw()
        messagebox.showerror("Не удалось загрузить каталог", str(error), parent=root)
        root.destroy()
        return 1
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
