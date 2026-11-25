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

/** What is counted. `relevance` = Workers AI embedding calls; `brain` = Manyfold A2A calls. */
export type UsageKind = 'relevance' | 'brain';

export const DEFAULT_DAILY_RELEVANCE_LIMIT = 3_000;

export function usageDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
}

export class UsageBudget {
  constructor(
    private readonly db: D1Like | undefined,
    private readonly agentId: string,
  ) {}

  async used(kind: UsageKind, nowMs: number): Promise<number> {
    if (!this.db) return 0;
    try {
      const row = await this.db
        .prepare('SELECT units FROM narra_usage_daily WHERE agent_id = ? AND day = ? AND kind = ?')
        .bind(this.agentId, usageDay(nowMs), kind)
        .first<{ units: number }>();
      return Number(row?.units ?? 0);
    } catch {
      return 0;
    }
  }

  async add(kind: UsageKind, nowMs: number, units = 1): Promise<void> {
    if (!this.db) return;
    try {
      await this.db
        .prepare(
          'INSERT INTO narra_usage_daily (agent_id, day, kind, units) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(agent_id, day, kind) DO UPDATE SET units = units + excluded.units',
        )
        .bind(this.agentId, usageDay(nowMs), kind, units)
        .run();
    } catch {
      // Counting must never break a turn.
    }
  }

  /** True once today's relevance scoring has reached `limit`. */
  async relevanceExhausted(nowMs: number, limit: number): Promise<boolean> {
    if (!this.db || limit <= 0) return false;
    return (await this.used('relevance', nowMs)) >= limit;
  }
}

export function parseLimit(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n >= 0 && (raw ?? '').trim() !== '' ? Math.floor(n) : fallback;
}
