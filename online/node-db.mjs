/* Локальная SQLite с тем же интерфейсом запросов, что у Cloudflare D1. */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createNodeDatabase(filename = ":memory:") {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new DatabaseSync(filename);
  sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const statements = new WeakMap();

  function prepared(sql, values = []) {
    const item = {
      bind(...nextValues) { return prepared(sql, nextValues); },
      async all() {
        const rows = sqlite.prepare(sql).all(...values).map(row => ({ ...row }));
        return { success: true, results: rows, meta: { changes: 0 } };
      },
      async first(column) {
        const value = sqlite.prepare(sql).get(...values);
        if (value === undefined) return null;
        if (column !== undefined) {
          if (!Object.hasOwn(value, column)) throw new Error("Столбец не найден: " + column);
          return value[column];
        }
        return { ...value };
      },
      async run() { return execute(sql, values); },
    };
    statements.set(item, { sql, values });
    return item;
  }

  function execute(sql, values) {
    const statement = sqlite.prepare(sql);
    if (statement.columns().length) {
      return { success: true, results: statement.all(...values).map(row => ({ ...row })), meta: { changes: 0 } };
    }
    const result = statement.run(...values);
    return { success: true, results: [], meta: {
      changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid),
    } };
  }

  return {
    prepare: prepared,
    // Только запуск/миграции приложения. Обработчики HTTP этот метод не используют.
    exec(sql) { sqlite.exec(sql); },
    async batch(items) {
      if (!Array.isArray(items)) throw new TypeError("batch ожидает массив запросов");
      const commands = items.map(item => {
        const value = statements.get(item);
        if (!value) throw new TypeError("Запрос batch принадлежит другой базе данных");
        return value;
      });
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = commands.map(({ sql, values }) => execute(sql, values));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    close() { sqlite.close(); },
  };
}
