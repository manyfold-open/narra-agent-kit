/**
 * Per-agent daily usage counters for the v2 pipeline. Cloudflare bills overage instead of stopping,
 * so each agent stops its own optional Workers AI work once its daily budget is spent.
 * Counters live in the agent's own D1 database: no shared service.
 */
export const NARRA_USAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS narra_usage_daily (
  agent_id TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day, kind)
);
`;
export const DEFAULT_DAILY_RELEVANCE_LIMIT = 3_000;
export function usageDay(nowMs) {
    return new Date(nowMs).toISOString().slice(0, 10);
}
export class UsageBudget {
    db;
    agentId;
    constructor(db, agentId) {
        this.db = db;
        this.agentId = agentId;
    }
    async used(kind, nowMs) {
        if (!this.db)
            return 0;
        try {
            const row = await this.db
                .prepare('SELECT units FROM narra_usage_daily WHERE agent_id = ? AND day = ? AND kind = ?')
                .bind(this.agentId, usageDay(nowMs), kind)
                .first();
            return Number(row?.units ?? 0);
        }
        catch {
            return 0;
        }
    }
    async add(kind, nowMs, units = 1) {
        if (!this.db)
            return;
        try {
            await this.db
                .prepare('INSERT INTO narra_usage_daily (agent_id, day, kind, units) VALUES (?, ?, ?, ?) ' +
                'ON CONFLICT(agent_id, day, kind) DO UPDATE SET units = units + excluded.units')
                .bind(this.agentId, usageDay(nowMs), kind, units)
                .run();
        }
        catch {
            // Counting must never break a turn.
        }
    }
    /** True once today's relevance scoring has reached `limit`. */
    async relevanceExhausted(nowMs, limit) {
        if (!this.db || limit <= 0)
            return false;
        return (await this.used('relevance', nowMs)) >= limit;
    }
}
export function parseLimit(raw, fallback) {
    const n = Number((raw ?? '').trim());
    return Number.isFinite(n) && n >= 0 && (raw ?? '').trim() !== '' ? Math.floor(n) : fallback;
}
//# sourceMappingURL=budget.js.map