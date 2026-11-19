import type { ChatType, LangCode, MemoryEntry, MemoryKind } from './types.js';

export const NARRA_MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS narra_user_memory (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  origin_chat_type TEXT NOT NULL DEFAULT 'group',
  origin_room_id TEXT,
  kind TEXT NOT NULL DEFAULT 'preference',
  memory_key TEXT NOT NULL,
  memory_value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_id, user_id, origin_chat_type, memory_key)
);

CREATE INDEX IF NOT EXISTS idx_narra_user_memory_lookup
  ON narra_user_memory (agent_id, user_id, origin_chat_type, updated_at);

CREATE TABLE IF NOT EXISTS narra_room_memory (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  memory_key TEXT NOT NULL,
  memory_value TEXT NOT NULL,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_id, room_id, memory_key)
);

CREATE INDEX IF NOT EXISTS idx_narra_room_memory_lookup
  ON narra_room_memory (agent_id, room_id, kind, updated_at);

CREATE TABLE IF NOT EXISTS narra_learning_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  user_id TEXT,
  event_id TEXT,
  signal TEXT NOT NULL,
  delta REAL NOT NULL DEFAULT 0,
  threshold_after REAL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_narra_learning_log_room
  ON narra_learning_log (agent_id, room_id, created_at);

CREATE TABLE IF NOT EXISTS narra_demand_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  user_id TEXT,
  query TEXT NOT NULL,
  category TEXT,
  outcome TEXT NOT NULL DEFAULT 'unanswered',
  lang TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_narra_demand_log_room
  ON narra_demand_log (agent_id, room_id, created_at);
`;

export const DEFAULT_ROOM_THRESHOLD = 0.55;
export const MIN_ROOM_THRESHOLD = 0.25;
export const MAX_ROOM_THRESHOLD = 0.95;

const INTERNAL_THRESHOLD_KEY = '__narra_threshold__';
const INTERNAL_MUTE_KEY = '__narra_muted__';

export class MemoryRejectionError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = 'MemoryRejectionError';
    this.reason = reason;
  }
}

const INJECTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+)?(?:previous|prior|above|system|earlier|safety)\s+(?:instructions?|prompts?|rules?|constraints?)\b/i,
    reason: 'instruction_override',
  },
  {
    pattern:
      /\b(?:new\s+system\s+prompt|system\s+override|developer\s+mode|jailbreak|do\s+anything\s+now|you\s+are\s+now\s+(?:a|an)\b)/i,
    reason: 'role_hijack',
  },
  {
    pattern:
      /(?:忽略|無視|无视|覆蓋|覆盖|繞過|绕过).{0,8}(?:之前|以前|所有|系統|系统|安全).{0,6}(?:指令|指示|規則|规则|提示詞|提示词|限制)/i,
    reason: 'cjk_instruction_override',
  },
  {
    pattern: /(?:你現在是|你现在是|切換成|切换成|進入越獄|进入越狱|系統提示詞|系统提示词)/i,
    reason: 'cjk_role_hijack',
  },
  {
    pattern:
      /(?:\[\s*channel message context\s*\]|<\/?\s*(?:system|instructions?|prompt|tool_call|narra-message|penny-message)\b|(?:^|\n)\s*(?:system|assistant|developer|gateway_verdict|actor_token|sender_id)\s*[:：])/i,
    reason: 'envelope_delimiter_spoof',
  },
  {
    pattern:
      /\b(?:reveal|print|dump|exfiltrate|send|post)\b.{0,30}\b(?:system\s+prompt|env(?:ironment)?|secrets?|NARRA_AGENT_TOKEN|MF_API_TOKEN|access_token|private\s+key|bearer\s+token)\b/i,
    reason: 'secret_exfiltration',
  },
  {
    pattern: /(?:;\s*DROP\s+TABLE|\$\([^)]+\)|`[^`]{2,}`|\b(?:eval|exec)\s*\()/i,
    reason: 'code_or_sql_injection',
  },
];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Validates memory keys and values against prompt-injection payloads, envelope spoofing,
 * secret exfiltration attempts, and malformed control characters.
 */
export function validateMemoryWrite(
  key: string,
  value: string,
): { safe: boolean; reason?: string } {
  if (typeof key !== 'string' || typeof value !== 'string') {
    return { safe: false, reason: 'invalid_type' };
  }
  const cleanKey = key.trim();
  const cleanVal = value.trim();
  if (!cleanKey || !cleanVal) {
    return { safe: false, reason: 'empty_content' };
  }
  if (cleanKey.length > 120 || cleanVal.length > 500) {
    return { safe: false, reason: 'exceeds_length_limit' };
  }
  if (cleanKey.startsWith('__narra_')) {
    return { safe: false, reason: 'reserved_internal_key' };
  }
  if (CONTROL_CHARS.test(cleanKey) || CONTROL_CHARS.test(cleanVal)) {
    return { safe: false, reason: 'control_characters' };
  }
  const combined = `${cleanKey}\n${cleanVal}`;
  for (const { pattern, reason } of INJECTION_PATTERNS) {
    if (pattern.test(combined)) {
      return { safe: false, reason };
    }
  }
  return { safe: true };
}

export function isInjectionAttempt(text: string): boolean {
  return !validateMemoryWrite('check', text).safe;
}

export interface MemoryStoreOptions {
  defaultRoomThreshold?: number;
  minThreshold?: number;
  maxThreshold?: number;
  now?: () => Date;
}

export interface RememberUserInput {
  userId: string;
  key: string;
  value: string;
  kind?: MemoryKind;
  originChatType: ChatType;
  originRoomId?: string;
  confidence?: number;
}

export interface RememberRoomInput {
  roomId: string;
  key: string;
  value: string;
  kind?: MemoryKind;
  updatedBy?: string;
}

export interface RecallTurnInput {
  roomId: string;
  userId?: string;
  chatType: ChatType;
  limit?: number;
}

export interface RecallTurnResult {
  userMemories: MemoryEntry[];
  roomMemories: MemoryEntry[];
  promptSafeLines: string[];
}

export interface RecordFeedbackInput {
  roomId: string;
  userId?: string;
  eventId?: string;
  signal: 'positive' | 'negative' | 'correction' | 'mute' | 'unmute';
  detail?: string;
  step?: number;
}

export interface LogDemandInput {
  roomId: string;
  userId?: string;
  query: string;
  category?: string;
  outcome?: 'gap' | 'fallback' | 'answered' | 'unanswered';
  lang?: LangCode;
}

interface UserMemoryRow {
  id: string;
  agent_id: string;
  user_id: string;
  origin_chat_type: ChatType;
  origin_room_id: string | null;
  kind: MemoryKind;
  memory_key: string;
  memory_value: string;
  confidence: number;
  created_at: string;
  updated_at: string;
}

interface RoomMemoryRow {
  id: string;
  agent_id: string;
  room_id: string;
  kind: MemoryKind;
  memory_key: string;
  memory_value: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * D1-backed 3-layer Self-Learning Engine:
 * 1. User memory (`narra_user_memory`) with strict DM-to-group privacy isolation.
 * 2. Room memory (`narra_room_memory`) for group facts, corrections, language, mute & threshold.
 * 3. Learning & demand logs (`narra_learning_log`, `narra_demand_log`) for adaptive noise control.
 */
export class MemoryStore {
  private readonly db: D1Database;
  private readonly agentId: string;
  private readonly defaultRoomThreshold: number;
  private readonly minThreshold: number;
  private readonly maxThreshold: number;
  private readonly now: () => Date;

  constructor(db: D1Database, agentId: string, options: MemoryStoreOptions = {}) {
    this.db = db;
    this.agentId = agentId;
    this.defaultRoomThreshold = options.defaultRoomThreshold ?? DEFAULT_ROOM_THRESHOLD;
    this.minThreshold = options.minThreshold ?? MIN_ROOM_THRESHOLD;
    this.maxThreshold = options.maxThreshold ?? MAX_ROOM_THRESHOLD;
    this.now = options.now ?? (() => new Date());
  }

  async ensureSchema(): Promise<void> {
    await this.db.exec(NARRA_MEMORY_SCHEMA);
  }

  private clampThreshold(value: number): number {
    const rounded = Math.round(value * 1000) / 1000;
    return Math.max(this.minThreshold, Math.min(this.maxThreshold, rounded));
  }

  private async logLearning(input: {
    roomId: string;
    userId?: string;
    eventId?: string;
    signal: string;
    delta?: number;
    thresholdAfter?: number | null;
    detail?: string;
  }): Promise<void> {
    const at = this.now().toISOString();
    await this.db
      .prepare(
        `INSERT INTO narra_learning_log
         (id, agent_id, room_id, user_id, event_id, signal, delta, threshold_after, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        this.agentId,
        input.roomId,
        input.userId ?? null,
        input.eventId ?? null,
        input.signal,
        input.delta ?? 0,
        input.thresholdAfter ?? null,
        (input.detail ?? '').slice(0, 300) || null,
        at,
      )
      .run();
  }

  async rememberUser(input: RememberUserInput): Promise<MemoryEntry> {
    const check = validateMemoryWrite(input.key, input.value);
    if (!check.safe) {
      await this.logLearning({
        roomId: input.originRoomId ?? `dm:${input.userId}`,
        userId: input.userId,
        signal: 'rejected_injection',
        detail: `${check.reason}: ${input.key}=${input.value}`.slice(0, 200),
      });
      throw new MemoryRejectionError(
        `Rejected unsafe user memory write (${check.reason}).`,
        check.reason ?? 'unsafe_content',
      );
    }

    const id = crypto.randomUUID();
    const at = this.now().toISOString();
    const kind = input.kind ?? 'preference';
    const key = input.key.trim();
    const value = input.value.trim();
    const confidence = input.confidence ?? 1.0;

    await this.db
      .prepare(
        `INSERT INTO narra_user_memory
         (id, agent_id, user_id, origin_chat_type, origin_room_id, kind, memory_key, memory_value, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, user_id, origin_chat_type, memory_key) DO UPDATE SET
           memory_value = excluded.memory_value,
           kind = excluded.kind,
           origin_room_id = excluded.origin_room_id,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`,
      )
      .bind(
        id,
        this.agentId,
        input.userId,
        input.originChatType,
        input.originRoomId ?? null,
        kind,
        key,
        value,
        confidence,
        at,
        at,
      )
      .run();

    if (kind === 'correction') {
      await this.logLearning({
        roomId: input.originRoomId ?? `dm:${input.userId}`,
        userId: input.userId,
        signal: 'correction',
        detail: `user:${key}=${value}`,
      });
    }

    return {
      id,
      scope: 'user',
      agentId: this.agentId,
      userId: input.userId,
      ...(input.originRoomId ? { roomId: input.originRoomId } : {}),
      originChatType: input.originChatType,
      kind,
      key,
      value,
      confidence,
      createdAt: at,
      updatedAt: at,
    };
  }

  async rememberRoom(input: RememberRoomInput): Promise<MemoryEntry> {
    const check = validateMemoryWrite(input.key, input.value);
    if (!check.safe) {
      await this.logLearning({
        roomId: input.roomId,
        userId: input.updatedBy,
        signal: 'rejected_injection',
        detail: `${check.reason}: ${input.key}=${input.value}`.slice(0, 200),
      });
      throw new MemoryRejectionError(
        `Rejected unsafe room memory write (${check.reason}).`,
        check.reason ?? 'unsafe_content',
      );
    }

    const id = crypto.randomUUID();
    const at = this.now().toISOString();
    const kind = input.kind ?? 'fact';
    const key = input.key.trim();
    const value = input.value.trim();

    await this.db
      .prepare(
        `INSERT INTO narra_room_memory
         (id, agent_id, room_id, kind, memory_key, memory_value, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, room_id, memory_key) DO UPDATE SET
           memory_value = excluded.memory_value,
           kind = excluded.kind,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .bind(id, this.agentId, input.roomId, kind, key, value, input.updatedBy ?? null, at, at)
      .run();

    if (kind === 'correction') {
      await this.logLearning({
        roomId: input.roomId,
        userId: input.updatedBy,
        signal: 'correction',
        detail: `room:${key}=${value}`,
      });
    }

    return {
      id,
      scope: 'room',
      agentId: this.agentId,
      roomId: input.roomId,
      kind,
      key,
      value,
      createdAt: at,
      updatedAt: at,
    };
  }

  /**
   * Recalls safe memories for a turn.
   * PRIVACY BOUNDARY: When `chatType === 'group'`, private DM user memories
   * (`origin_chat_type = 'dm'`) are STRICTLY excluded and never surfaced.
   */
  async recallForTurn(input: RecallTurnInput): Promise<RecallTurnResult> {
    const limit = input.limit ?? 20;
    const userMemories: MemoryEntry[] = [];
    const roomMemories: MemoryEntry[] = [];

    if (input.userId) {
      const sql =
        input.chatType === 'group'
          ? `SELECT id, agent_id, user_id, origin_chat_type, origin_room_id, kind, memory_key, memory_value, confidence, created_at, updated_at
             FROM narra_user_memory
             WHERE agent_id = ? AND user_id = ? AND origin_chat_type = 'group'
             ORDER BY updated_at DESC LIMIT ?`
          : `SELECT id, agent_id, user_id, origin_chat_type, origin_room_id, kind, memory_key, memory_value, confidence, created_at, updated_at
             FROM narra_user_memory
             WHERE agent_id = ? AND user_id = ?
             ORDER BY CASE WHEN origin_chat_type = 'dm' THEN 0 ELSE 1 END, updated_at DESC LIMIT ?`;

      const { results } = await this.db
        .prepare(sql)
        .bind(this.agentId, input.userId, limit)
        .all<UserMemoryRow>();

      for (const row of results ?? []) {
        if (!validateMemoryWrite(row.memory_key, row.memory_value).safe) continue;
        userMemories.push({
          id: row.id,
          scope: 'user',
          agentId: row.agent_id,
          userId: row.user_id,
          ...(row.origin_room_id ? { roomId: row.origin_room_id } : {}),
          originChatType: row.origin_chat_type,
          kind: row.kind,
          key: row.memory_key,
          value: row.memory_value,
          confidence: row.confidence,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      }
    }

    const { results: roomRows } = await this.db
      .prepare(
        `SELECT id, agent_id, room_id, kind, memory_key, memory_value, updated_by, created_at, updated_at
         FROM narra_room_memory
         WHERE agent_id = ? AND room_id = ?
           AND memory_key NOT IN (?, ?)
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .bind(this.agentId, input.roomId, INTERNAL_THRESHOLD_KEY, INTERNAL_MUTE_KEY, limit)
      .all<RoomMemoryRow>();

    for (const row of roomRows ?? []) {
      if (!validateMemoryWrite(row.memory_key, row.memory_value).safe) continue;
      roomMemories.push({
        id: row.id,
        scope: 'room',
        agentId: row.agent_id,
        roomId: row.room_id,
        kind: row.kind,
        key: row.memory_key,
        value: row.memory_value,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }

    const promptSafeLines: string[] = [
      ...userMemories.map((m) => `[user:${m.kind}] ${m.key}: ${m.value}`),
      ...roomMemories.map((m) => `[room:${m.kind}] ${m.key}: ${m.value}`),
    ];

    return { userMemories, roomMemories, promptSafeLines };
  }

  async forget(input: {
    scope: 'user' | 'room' | 'all';
    userId?: string;
    roomId?: string;
    key?: string;
  }): Promise<number> {
    let deleted = 0;

    if ((input.scope === 'user' || input.scope === 'all') && input.userId) {
      const res = input.key
        ? await this.db
            .prepare('DELETE FROM narra_user_memory WHERE agent_id = ? AND user_id = ? AND memory_key = ?')
            .bind(this.agentId, input.userId, input.key)
            .run()
        : await this.db
            .prepare('DELETE FROM narra_user_memory WHERE agent_id = ? AND user_id = ?')
            .bind(this.agentId, input.userId)
            .run();
      deleted += Number(res.meta.changes ?? 0);
    }

    if ((input.scope === 'room' || input.scope === 'all') && input.roomId) {
      const res = input.key
        ? await this.db
            .prepare('DELETE FROM narra_room_memory WHERE agent_id = ? AND room_id = ? AND memory_key = ?')
            .bind(this.agentId, input.roomId, input.key)
            .run()
        : await this.db
            .prepare('DELETE FROM narra_room_memory WHERE agent_id = ? AND room_id = ?')
            .bind(this.agentId, input.roomId)
            .run();
      deleted += Number(res.meta.changes ?? 0);
    }

    return deleted;
  }

  private async upsertInternalRoomState(roomId: string, key: string, value: string, updatedBy?: string): Promise<void> {
    const at = this.now().toISOString();
    await this.db
      .prepare(
        `INSERT INTO narra_room_memory
         (id, agent_id, room_id, kind, memory_key, memory_value, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, 'fact', ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, room_id, memory_key) DO UPDATE SET
           memory_value = excluded.memory_value,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .bind(crypto.randomUUID(), this.agentId, roomId, key, value, updatedBy ?? null, at, at)
      .run();
  }

  async getRoomThreshold(roomId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT memory_value FROM narra_room_memory WHERE agent_id = ? AND room_id = ? AND memory_key = ?')
      .bind(this.agentId, roomId, INTERNAL_THRESHOLD_KEY)
      .first<{ memory_value: string }>();
    if (!row) return this.defaultRoomThreshold;
    const parsed = Number(row.memory_value);
    return Number.isFinite(parsed) ? this.clampThreshold(parsed) : this.defaultRoomThreshold;
  }

  async isRoomMuted(roomId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT memory_value FROM narra_room_memory WHERE agent_id = ? AND room_id = ? AND memory_key = ?')
      .bind(this.agentId, roomId, INTERNAL_MUTE_KEY)
      .first<{ memory_value: string }>();
    return row?.memory_value === '1' || row?.memory_value === 'true';
  }

  async setRoomMute(roomId: string, muted: boolean, updatedBy?: string): Promise<void> {
    await this.upsertInternalRoomState(roomId, INTERNAL_MUTE_KEY, muted ? '1' : '0', updatedBy);
    await this.logLearning({
      roomId,
      userId: updatedBy,
      signal: muted ? 'mute' : 'unmute',
      detail: muted ? 'room muted' : 'room unmuted',
    });
  }

  /**
   * Records feedback and updates the room's adaptive silence threshold:
   * - `negative` feedback raises the silence threshold (agent speaks less often unmentioned).
   * - `positive` feedback gently lowers the silence threshold (within `minThreshold`).
   * - `mute` / `unmute` toggles room mute state.
   */
  async recordFeedback(input: RecordFeedbackInput): Promise<{ threshold: number; muted: boolean }> {
    const current = await this.getRoomThreshold(input.roomId);
    let next = current;
    let delta = 0;

    if (input.signal === 'negative') {
      const step = input.step ?? 0.1;
      next = this.clampThreshold(current + Math.abs(step));
      delta = next - current;
      await this.upsertInternalRoomState(input.roomId, INTERNAL_THRESHOLD_KEY, String(next), input.userId);
    } else if (input.signal === 'positive') {
      const step = input.step ?? 0.05;
      next = this.clampThreshold(current - Math.abs(step));
      delta = next - current;
      await this.upsertInternalRoomState(input.roomId, INTERNAL_THRESHOLD_KEY, String(next), input.userId);
    } else if (input.signal === 'mute') {
      await this.setRoomMute(input.roomId, true, input.userId);
      return { threshold: current, muted: true };
    } else if (input.signal === 'unmute') {
      await this.setRoomMute(input.roomId, false, input.userId);
      return { threshold: current, muted: false };
    }

    await this.logLearning({
      roomId: input.roomId,
      userId: input.userId,
      eventId: input.eventId,
      signal: input.signal,
      delta,
      thresholdAfter: next,
      detail: input.detail,
    });

    return {
      threshold: next,
      muted: await this.isRoomMuted(input.roomId),
    };
  }

  async logDemand(input: LogDemandInput): Promise<void> {
    const cleanQuery = (input.query ?? '').trim().slice(0, 500);
    if (!cleanQuery) return;
    await this.db
      .prepare(
        `INSERT INTO narra_demand_log
         (id, agent_id, room_id, user_id, query, category, outcome, lang, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        this.agentId,
        input.roomId,
        input.userId ?? null,
        cleanQuery,
        input.category ?? null,
        input.outcome ?? 'unanswered',
        input.lang ?? null,
        this.now().toISOString(),
      )
      .run();
  }

  async getLearningLog(
    roomId?: string,
    limit = 50,
  ): Promise<
    Array<{
      id: string;
      roomId: string;
      userId: string | null;
      signal: string;
      delta: number;
      thresholdAfter: number | null;
      detail: string | null;
      createdAt: string;
    }>
  > {
    const sql = roomId
      ? `SELECT id, room_id AS roomId, user_id AS userId, signal, delta, threshold_after AS thresholdAfter, detail, created_at AS createdAt
         FROM narra_learning_log WHERE agent_id = ? AND room_id = ? ORDER BY created_at DESC LIMIT ?`
      : `SELECT id, room_id AS roomId, user_id AS userId, signal, delta, threshold_after AS thresholdAfter, detail, created_at AS createdAt
         FROM narra_learning_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`;

    const stmt = roomId
      ? this.db.prepare(sql).bind(this.agentId, roomId, limit)
      : this.db.prepare(sql).bind(this.agentId, limit);
    const { results } = await stmt.all<{
      id: string;
      roomId: string;
      userId: string | null;
      signal: string;
      delta: number;
      thresholdAfter: number | null;
      detail: string | null;
      createdAt: string;
    }>();
    return results ?? [];
  }

  async getDemandLog(
    roomId?: string,
    limit = 50,
  ): Promise<
    Array<{
      id: string;
      roomId: string;
      userId: string | null;
      query: string;
      category: string | null;
      outcome: string;
      lang: string | null;
      createdAt: string;
    }>
  > {
    const sql = roomId
      ? `SELECT id, room_id AS roomId, user_id AS userId, query, category, outcome, lang, created_at AS createdAt
         FROM narra_demand_log WHERE agent_id = ? AND room_id = ? ORDER BY created_at DESC LIMIT ?`
      : `SELECT id, room_id AS roomId, user_id AS userId, query, category, outcome, lang, created_at AS createdAt
         FROM narra_demand_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`;

    const stmt = roomId
      ? this.db.prepare(sql).bind(this.agentId, roomId, limit)
      : this.db.prepare(sql).bind(this.agentId, limit);
    const { results } = await stmt.all<{
      id: string;
      roomId: string;
      userId: string | null;
      query: string;
      category: string | null;
      outcome: string;
      lang: string | null;
      createdAt: string;
    }>();
    return results ?? [];
  }
}
