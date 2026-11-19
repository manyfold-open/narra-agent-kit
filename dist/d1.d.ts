export interface D1PreparedStatementLike {
    run(): Promise<unknown>;
}
export interface D1DatabaseLike<TStatement extends D1PreparedStatementLike = D1PreparedStatementLike> {
    prepare(query: string): TStatement;
    batch?(statements: TStatement[]): Promise<unknown>;
}
/**
 * Splits a multi-statement SQL script into trimmed single-line statements,
 * stripping `--` line comments and block comments while preserving quoted literals.
 */
export declare function splitSqlStatements(sql: string): string[];
/**
 * Executes a multi-statement SQL schema via `db.batch(stmts.map((s) => db.prepare(s)))`,
 * with sequential `db.prepare(s).run()` fallback for minimal mocks lacking `batch`.
 * Avoids `db.exec()`, which in Cloudflare D1 splits on `\n` and throws `D1_EXEC_ERROR`
 * on multi-line DDL statements.
 */
export declare function runSchemaStatements<TStatement extends D1PreparedStatementLike = D1PreparedStatementLike>(db: D1DatabaseLike<TStatement>, sql: string): Promise<void>;
//# sourceMappingURL=d1.d.ts.map