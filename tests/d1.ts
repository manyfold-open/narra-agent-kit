import { DatabaseSync } from 'node:sqlite';

/**
 * In-memory SQLite-backed D1Database test double so real SQL schemas, unique constraints,
 * ON CONFLICT upserts, and transactions run identically to Cloudflare D1.
 */
export function createD1(): D1Database {
  const sqlite = new DatabaseSync(':memory:');

  const statement = (sql: string, params: unknown[] = []) => {
    const allSync = () => ({
      results: sqlite.prepare(sql).all(...params),
      success: true,
      meta: {},
    });
    const runSync = () => {
      const info = sqlite.prepare(sql).run(...params);
      return {
        results: [],
        success: true,
        meta: {
          changes: Number(info.changes),
          last_row_id: Number(info.lastInsertRowid),
        },
      };
    };

    return {
      sql,
      allSync,
      runSync,
      bind: (...values: unknown[]) => statement(sql, values),
      first: async (column?: string) => {
        const row = sqlite.prepare(sql).get(...params);
        if (!row) return null;
        return column ? row[column] : row;
      },
      all: async () => allSync(),
      run: async () => runSync(),
      raw: async () =>
        sqlite
          .prepare(sql)
          .all(...params)
          .map((row) => Object.values(row)),
    };
  };

  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReturnType<typeof statement>[]) => {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((item) =>
          /^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(item.sql) ? item.allSync() : item.runSync(),
        );
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}
