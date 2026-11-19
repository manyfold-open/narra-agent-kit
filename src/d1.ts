export interface D1PreparedStatementLike {
  run(): Promise<unknown>;
}

export interface D1DatabaseLike<
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
> {
  prepare(query: string): TStatement;
  batch?(statements: TStatement[]): Promise<unknown>;
}

/**
 * Splits a multi-statement SQL script into trimmed single-line statements,
 * stripping `--` line comments and block comments while preserving quoted literals.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let pendingSpace = false;

  const pushChar = (ch: string): void => {
    if (pendingSpace && current.length > 0) {
      current += ' ';
    }
    pendingSpace = false;
    current += ch;
  };

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inSingle) {
      current += ch;
      if (ch === "'" && next === "'") {
        current += next;
        i++;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      current += ch;
      if (ch === '"' && next === '"') {
        current += next;
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') {
        i++;
      }
      pendingSpace = true;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i++;
      }
      i++;
      pendingSpace = true;
      continue;
    }

    if (ch === "'") {
      pushChar(ch);
      inSingle = true;
      continue;
    }

    if (ch === '"') {
      pushChar(ch);
      inDouble = true;
      continue;
    }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = '';
      pendingSpace = false;
      continue;
    }

    if (/\s/.test(ch)) {
      pendingSpace = true;
      continue;
    }

    pushChar(ch);
  }

  const tail = current.trim();
  if (tail.length > 0) {
    statements.push(tail);
  }

  return statements;
}

/**
 * Executes a multi-statement SQL schema via `db.batch(stmts.map((s) => db.prepare(s)))`,
 * with sequential `db.prepare(s).run()` fallback for minimal mocks lacking `batch`.
 * Avoids `db.exec()`, which in Cloudflare D1 splits on `\n` and throws `D1_EXEC_ERROR`
 * on multi-line DDL statements.
 */
export async function runSchemaStatements<
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
>(db: D1DatabaseLike<TStatement>, sql: string): Promise<void> {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) return;

  if (typeof db.batch === 'function') {
    await db.batch(statements.map((stmt) => db.prepare(stmt)));
    return;
  }

  for (const stmt of statements) {
    await db.prepare(stmt).run();
  }
}
