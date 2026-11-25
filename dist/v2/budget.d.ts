/**
 * Per-agent daily usage counters for the v2 pipeline. Cloudflare bills overage instead of stopping,
 * so each agent stops its own optional Workers AI work once its daily budget is spent.
 * Counters live in the agent's own D1 database: no shared service.
 */
export declare const NARRA_USAGE_SCHEMA = "\nCREATE TABLE IF NOT EXISTS narra_usage_daily (\n  agent_id TEXT NOT NULL,\n  day TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  units INTEGER NOT NULL DEFAULT 0,\n  PRIMARY KEY (agent_id, day, kind)\n);\n";
/** What is counted. `relevance` = Workers AI embedding calls; `brain` = Manyfold A2A calls. */
export type UsageKind = 'relevance' | 'brain';
export declare const DEFAULT_DAILY_RELEVANCE_LIMIT = 3000;
export declare function usageDay(nowMs: number): string;
interface D1Like {
    prepare(query: string): {
        bind(...values: unknown[]): {
            run(): Promise<unknown>;
            first<T = Record<string, unknown>>(): Promise<T | null>;
        };
    };
}
export declare class UsageBudget {
    private readonly db;
    private readonly agentId;
    constructor(db: D1Like | undefined, agentId: string);
    used(kind: UsageKind, nowMs: number): Promise<number>;
    add(kind: UsageKind, nowMs: number, units?: number): Promise<void>;
    /** True once today's relevance scoring has reached `limit`. */
    relevanceExhausted(nowMs: number, limit: number): Promise<boolean>;
}
export declare function parseLimit(raw: string | undefined, fallback: number): number;
export {};
//# sourceMappingURL=budget.d.ts.map