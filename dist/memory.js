import { runSchemaStatements } from './d1.js';
import { stripAgentMentions } from './lang.js';
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
    reason;
    constructor(message, reason) {
        super(message);
        this.name = 'MemoryRejectionError';
        this.reason = reason;
    }
}
const INJECTION_PATTERNS = [
    {
        pattern: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+)?(?:previous|prior|above|system|earlier|safety)\s+(?:instructions?|prompts?|rules?|constraints?)\b/i,
        reason: 'instruction_override',
    },
    {
        pattern: /\b(?:new\s+system\s+prompt|system\s+override|developer\s+mode|jailbreak|do\s+anything\s+now|you\s+are\s+now\s+(?:a|an)\b)/i,
        reason: 'role_hijack',
    },
    {
        pattern: /(?:忽略|無視|无视|覆蓋|覆盖|繞過|绕过).{0,8}(?:之前|以前|所有|系統|系统|安全).{0,6}(?:指令|指示|規則|规则|提示詞|提示词|限制)/i,
        reason: 'cjk_instruction_override',
    },
    {
        pattern: /(?:你現在是|你现在是|切換成|切换成|進入越獄|进入越狱|系統提示詞|系统提示词)/i,
        reason: 'cjk_role_hijack',
    },
    {
        pattern: /(?:\[\s*channel message context\s*\]|<\/?\s*(?:system|instructions?|prompt|tool_call|narra-message|penny-message)\b|(?:^|\n)\s*(?:system|assistant|developer|gateway_verdict|actor_token|sender_id)\s*[:：])/i,
        reason: 'envelope_delimiter_spoof',
    },
    {
        pattern: /\b(?:reveal|print|dump|exfiltrate|send|post)\b.{0,30}\b(?:system\s+prompt|env(?:ironment)?|secrets?|NARRA_AGENT_TOKEN|MF_API_TOKEN|access_token|private\s+key|bearer\s+token)\b/i,
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
export function validateMemoryWrite(key, value) {
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
export function isInjectionAttempt(text) {
    return !validateMemoryWrite('check', text).safe;
}
/**
 * D1-backed 3-layer Self-Learning Engine:
 * 1. User memory (`narra_user_memory`) with strict DM-to-group privacy isolation.
 * 2. Room memory (`narra_room_memory`) for group facts, corrections, language, mute & threshold.
 * 3. Learning & demand logs (`narra_learning_log`, `narra_demand_log`) for adaptive noise control.
 */
export class MemoryStore {
    db;
    agentId;
    defaultRoomThreshold;
    minThreshold;
    maxThreshold;
    now;
    constructor(db, agentId, options = {}) {
        this.db = db;
        this.agentId = agentId;
        this.defaultRoomThreshold = options.defaultRoomThreshold ?? DEFAULT_ROOM_THRESHOLD;
        this.minThreshold = options.minThreshold ?? MIN_ROOM_THRESHOLD;
        this.maxThreshold = options.maxThreshold ?? MAX_ROOM_THRESHOLD;
        this.now = options.now ?? (() => new Date());
    }
    async ensureSchema() {
        await runSchemaStatements(this.db, NARRA_MEMORY_SCHEMA);
    }
    clampThreshold(value) {
        const rounded = Math.round(value * 1000) / 1000;
        return Math.max(this.minThreshold, Math.min(this.maxThreshold, rounded));
    }
    async logLearning(input) {
        const at = this.now().toISOString();
        await this.db
            .prepare(`INSERT INTO narra_learning_log
         (id, agent_id, room_id, user_id, event_id, signal, delta, threshold_after, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(crypto.randomUUID(), this.agentId, input.roomId, input.userId ?? null, input.eventId ?? null, input.signal, input.delta ?? 0, input.thresholdAfter ?? null, (input.detail ?? '').slice(0, 300) || null, at)
            .run();
    }
    async rememberUser(input) {
        const check = validateMemoryWrite(input.key, input.value);
        if (!check.safe) {
            await this.logLearning({
                roomId: input.originRoomId ?? `dm:${input.userId}`,
                userId: input.userId,
                signal: 'rejected_injection',
                detail: `${check.reason}: ${input.key}=${input.value}`.slice(0, 200),
            });
            throw new MemoryRejectionError(`Rejected unsafe user memory write (${check.reason}).`, check.reason ?? 'unsafe_content');
        }
        const id = crypto.randomUUID();
        const at = this.now().toISOString();
        const kind = input.kind ?? 'preference';
        const key = input.key.trim();
        const value = input.value.trim();
        const confidence = input.confidence ?? 1.0;
        await this.db
            .prepare(`INSERT INTO narra_user_memory
         (id, agent_id, user_id, origin_chat_type, origin_room_id, kind, memory_key, memory_value, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, user_id, origin_chat_type, memory_key) DO UPDATE SET
           memory_value = excluded.memory_value,
           kind = excluded.kind,
           origin_room_id = excluded.origin_room_id,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`)
            .bind(id, this.agentId, input.userId, input.originChatType, input.originRoomId ?? null, kind, key, value, confidence, at, at)
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
    async rememberRoom(input) {
        const check = validateMemoryWrite(input.key, input.value);
        if (!check.safe) {
            await this.logLearning({
                roomId: input.roomId,
                userId: input.updatedBy,
                signal: 'rejected_injection',
                detail: `${check.reason}: ${input.key}=${input.value}`.slice(0, 200),
            });
            throw new MemoryRejectionError(`Rejected unsafe room memory write (${check.reason}).`, check.reason ?? 'unsafe_content');
        }
        const id = crypto.randomUUID();
        const at = this.now().toISOString();
        const kind = input.kind ?? 'fact';
        const key = input.key.trim();
        const value = input.value.trim();
        await this.db
            .prepare(`INSERT INTO narra_room_memory
         (id, agent_id, room_id, kind, memory_key, memory_value, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, room_id, memory_key) DO UPDATE SET
           memory_value = excluded.memory_value,
           kind = excluded.kind,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`)
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
    async recallForTurn(input) {
        const limit = input.limit ?? 20;
        const userMemories = [];
        const roomMemories = [];
        if (input.userId) {
            const sql = input.chatType === 'group'
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
                .all();
            for (const row of results ?? []) {
                if (!validateMemoryWrite(row.memory_key, row.memory_value).safe)
                    continue;
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
            .prepare(`SELECT id, agent_id, room_id, kind, memory_key, memory_value, updated_by, created_at, updated_at
         FROM narra_room_memory
         WHERE agent_id = ? AND room_id = ?
           AND memory_key NOT IN (?, ?)
         ORDER BY updated_at DESC LIMIT ?`)
            .bind(this.agentId, input.roomId, INTERNAL_THRESHOLD_KEY, INTERNAL_MUTE_KEY, limit)
            .all();
        for (const row of roomRows ?? []) {
            if (!validateMemoryWrite(row.memory_key, row.memory_value).safe)
                continue;
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
        const promptSafeLines = [
            ...userMemories.map((m) => `[user:${m.kind}] ${m.key}: ${m.value}`),
            ...roomMemories.map((m) => `[room:${m.kind}] ${m.key}: ${m.value}`),
        ];
        return { userMemories, roomMemories, promptSafeLines };
    }
    async forget(input) {
        let deleted = 0;
        if ((input.scope === 'user' || input.scope === 'all') && input.userId) {
            const filters = ['agent_id = ?', 'user_id = ?'];
            const bindings = [this.agentId, input.userId];
            if (input.key) {
                filters.push('memory_key = ?');
                bindings.push(input.key);
            }
            if (input.originChatType) {
                filters.push('origin_chat_type = ?');
                bindings.push(input.originChatType);
            }
            const res = await this.db
                .prepare(`DELETE FROM narra_user_memory WHERE ${filters.join(' AND ')}`)
                .bind(...bindings)
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
    async upsertInternalRoomState(roomId, key, value, updatedBy) {
        const at = this.now().toISOString();
        await this.db
            .prepare(`INSERT INTO narra_room_memory
         (id, agent_id, room_id, kind, memory_key, memory_value, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, 'fact', ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, room_id, memory_key) DO UPDATE SET
           memory_value = excluded.memory_value,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`)
            .bind(crypto.randomUUID(), this.agentId, roomId, key, value, updatedBy ?? null, at, at)
            .run();
    }
    async getRoomThreshold(roomId) {
        const row = await this.db
            .prepare('SELECT memory_value FROM narra_room_memory WHERE agent_id = ? AND room_id = ? AND memory_key = ?')
            .bind(this.agentId, roomId, INTERNAL_THRESHOLD_KEY)
            .first();
        if (!row)
            return this.defaultRoomThreshold;
        const parsed = Number(row.memory_value);
        return Number.isFinite(parsed) ? this.clampThreshold(parsed) : this.defaultRoomThreshold;
    }
    async isRoomMuted(roomId) {
        const row = await this.db
            .prepare('SELECT memory_value FROM narra_room_memory WHERE agent_id = ? AND room_id = ? AND memory_key = ?')
            .bind(this.agentId, roomId, INTERNAL_MUTE_KEY)
            .first();
        return row?.memory_value === '1' || row?.memory_value === 'true';
    }
    async setRoomMute(roomId, muted, updatedBy) {
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
    async recordFeedback(input) {
        const current = await this.getRoomThreshold(input.roomId);
        let next = current;
        let delta = 0;
        if (input.signal === 'negative') {
            const step = input.step ?? 0.1;
            next = this.clampThreshold(current + Math.abs(step));
            delta = next - current;
            await this.upsertInternalRoomState(input.roomId, INTERNAL_THRESHOLD_KEY, String(next), input.userId);
        }
        else if (input.signal === 'positive') {
            const step = input.step ?? 0.05;
            next = this.clampThreshold(current - Math.abs(step));
            delta = next - current;
            await this.upsertInternalRoomState(input.roomId, INTERNAL_THRESHOLD_KEY, String(next), input.userId);
        }
        else if (input.signal === 'mute') {
            await this.setRoomMute(input.roomId, true, input.userId);
            return { threshold: current, muted: true };
        }
        else if (input.signal === 'unmute') {
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
    async logDemand(input) {
        const cleanQuery = (input.query ?? '').trim().slice(0, 500);
        if (!cleanQuery)
            return;
        await this.db
            .prepare(`INSERT INTO narra_demand_log
         (id, agent_id, room_id, user_id, query, category, outcome, lang, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(crypto.randomUUID(), this.agentId, input.roomId, input.userId ?? null, cleanQuery, input.category ?? null, input.outcome ?? 'unanswered', input.lang ?? null, this.now().toISOString())
            .run();
    }
    async getLearningLog(roomId, limit = 50) {
        const sql = roomId
            ? `SELECT id, room_id AS roomId, user_id AS userId, signal, delta, threshold_after AS thresholdAfter, detail, created_at AS createdAt
         FROM narra_learning_log WHERE agent_id = ? AND room_id = ? ORDER BY created_at DESC LIMIT ?`
            : `SELECT id, room_id AS roomId, user_id AS userId, signal, delta, threshold_after AS thresholdAfter, detail, created_at AS createdAt
         FROM narra_learning_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`;
        const stmt = roomId
            ? this.db.prepare(sql).bind(this.agentId, roomId, limit)
            : this.db.prepare(sql).bind(this.agentId, limit);
        const { results } = await stmt.all();
        return results ?? [];
    }
    async getDemandLog(roomId, limit = 50) {
        const sql = roomId
            ? `SELECT id, room_id AS roomId, user_id AS userId, query, category, outcome, lang, created_at AS createdAt
         FROM narra_demand_log WHERE agent_id = ? AND room_id = ? ORDER BY created_at DESC LIMIT ?`
            : `SELECT id, room_id AS roomId, user_id AS userId, query, category, outcome, lang, created_at AS createdAt
         FROM narra_demand_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`;
        const stmt = roomId
            ? this.db.prepare(sql).bind(this.agentId, roomId, limit)
            : this.db.prepare(sql).bind(this.agentId, limit);
        const { results } = await stmt.all();
        return results ?? [];
    }
}
const GROUP_MUTE_RE = /^(?:先安靜|先安静|靜音|静音|先別插嘴|先别插嘴|安靜一下|安静一下|先閉嘴|先闭嘴|mute(?:\s+(?:room|group|for\s+now))?|be\s+quiet|stay\s+quiet)[!！。.~～?？\s]*$/i;
const GROUP_UNMUTE_RE = /^(?:恢復|恢复|取消靜音|取消静音|解除靜音|解除静音|恢復主動回覆|恢复主动回复|可以說話了|可以说话了|unmute(?:\s+(?:room|group))?)[!！。.~～?？\s]*$/i;
const FORGET_CMD_RE = /^(?:(?:請|请)?(?:幫我|帮我)?(?:(?:忘掉|忘記|忘记)(?:全部|所有|這[件些段]?事?|这[件些段]?事?|我的(?:記憶|记忆|偏好|資料|资料|設定|设置)?|之前(?:說|说|記|记)的(?:事|內容|内容)?|剛剛|刚刚)?|(?:清除|清空|刪掉|删掉|刪除|删除)(?:我的)?(?:全部|所有)?(?:記憶|记忆|偏好))|(?:please\s+)?forget\s+(?:everything|all(?:\s+(?:of\s+)?(?:my\s+)?(?:memories|preferences|notes|that|it))?|my\s+(?:memories|preferences|notes)|what\s+i\s+(?:said|told\s+you)))(?:\s*(?:吧|好嗎|好吗|喔|哦|呀|please))?[!！。.~～?？\s]*$/i;
const RECALL_CMD_RE = /(?:你記得什麼|你记得什么|你還記得什麼|你还记得什么|你記得我|你记得我|你還記得我|你还记得我|記得我(?:之前|私訊|私聊|平常|說過|说过)?|记得我(?:之前|私信|私聊|平常|说过)?|你記了什麼|你记了什么|查(?:看)?我的記憶|查(?:看)?我的记忆|\bwhat\s+do\s+you\s+remember\b|\bdo\s+you\s+remember\b)/i;
const REMEMBER_CMD_RE = /^(?:(?:請|请)?(?:幫我|帮我)?(?:記住|记住|記一下|记一下|記下來|记下来)[：:，,\s]*|(?:please\s+)?remember(?:\s+that)?[：:,\s]+)/i;
const PRIVATE_DM_SUFFIX_RE = /[,，。\s]+(?:這件?事)?(?:請)?(?:只|僅)?記在私[訊信](?:裡|里)?[，,]?(?:不要|別|勿)?在?群[組组]?(?:說|说|提(?:及)?)?[!！。.]*$/i;
function isInternalMemoryKey(key) {
    return key.startsWith('__narra_') || key.startsWith('opt_in_') || key === 'lang';
}
async function shortNoteKey(fact) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fact.toLowerCase())));
    const hex = [...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `note_${hex}`;
}
/**
 * Handles universal D1 3-layer memory commands (`先安靜`/`恢復`, `忘掉`, `你記得什麼`, `記住...`)
 * on directly addressed turns (`dm`, `explicit_mention`, `reply_to_self`) with strict
 * DM-to-group privacy isolation and prompt-injection rejection.
 */
export async function handleStandardMemoryCommand(input) {
    const { store, event, context, decision, memories, spec } = input;
    const isDirect = context.chatType === 'dm' ||
        decision.reason === 'dm' ||
        decision.reason === 'explicit_mention' ||
        decision.reason === 'reply_to_self';
    if (!isDirect)
        return null;
    const mentionNames = [
        spec.name,
        ...(spec.aliases ?? []),
        ...(context.peers ?? []).flatMap((p) => [p.displayName, ...(p.aliases ?? [])]),
        ...context.members.map((m) => m.displayName),
    ].filter((s) => typeof s === 'string' && s.trim().length > 0);
    const cleaned = stripAgentMentions(event.text ?? '', mentionNames)
        .trim()
        .replace(/^[，,：:\s]+/, '')
        .trim();
    if (!cleaned)
        return null;
    const lang = decision.detectedLang;
    // 1. Group Mute / Unmute
    if (context.chatType === 'group') {
        if (GROUP_MUTE_RE.test(cleaned)) {
            await store.setRoomMute(event.roomId, true, event.senderId);
            if (lang === 'zh-Hant') {
                return '好的，我會先安靜，只在被 @ 或直接回覆我時才開口。想恢復時在群裡 @我說「恢復」就好。';
            }
            if (lang === 'zh-Hans') {
                return '好的，我会先安静，只在被 @ 或直接回复我时才开口。想恢复时在群里 @我说「恢复」就好。';
            }
            return 'Got it — I will stay quiet here and only reply when @mentioned or directly replied to. @mention me and say "unmute" anytime.';
        }
        if (GROUP_UNMUTE_RE.test(cleaned)) {
            await store.setRoomMute(event.roomId, false, event.senderId);
            if (lang === 'zh-Hant') {
                return '好的，已恢復群組主動參與，有需要我幫忙的話題時我會適時加入！';
            }
            if (lang === 'zh-Hans') {
                return '好的，已恢复群组主动参与，有需要我帮忙的话题时我会适时加入！';
            }
            return 'Back on — I will chime in naturally on relevant topics in this group again.';
        }
    }
    // 2. Forget
    if (FORGET_CMD_RE.test(cleaned)) {
        await store.forget({
            scope: 'user',
            userId: event.senderId,
            originChatType: context.chatType,
        });
        if (lang === 'zh-Hant') {
            return context.chatType === 'dm'
                ? '好的，已忘掉你在私訊讓我記住的偏好與紀錄。'
                : '好的，已清除我在群組模式為你記下的偏好與紀錄（私訊紀錄各自獨立保存）。';
        }
        if (lang === 'zh-Hans') {
            return context.chatType === 'dm'
                ? '好的，已忘掉你在私信让我记住的偏好与记录。'
                : '好的，已清除我在群组模式为你记下的偏好与记录（私信记录各自独立保存）。';
        }
        return context.chatType === 'dm'
            ? 'Done — I have cleared your private DM preferences and notes.'
            : 'Done — I have cleared your group preferences (private DM notes remain separate).';
    }
    // 3. Recall (strictly respecting DM-to-group privacy isolation from recallForTurn)
    if (RECALL_CMD_RE.test(cleaned)) {
        const visibleUser = memories.userMemories.filter((m) => !isInternalMemoryKey(m.key));
        const visibleRoom = context.chatType === 'group'
            ? memories.roomMemories.filter((m) => !isInternalMemoryKey(m.key))
            : [];
        if (visibleUser.length === 0 && visibleRoom.length === 0) {
            if (context.chatType === 'group') {
                if (lang === 'zh-Hant') {
                    return '我在群組裡還沒有記下你的個人偏好；為了保護隱私，私訊中的對話與偏好不會在群組中讀取或提及。';
                }
                if (lang === 'zh-Hans') {
                    return '我在群组里还没有记下你的个人偏好；为了保护隐私，私信中的对话与偏好不会在群组中读取或提及。';
                }
                return 'I have not saved any group preferences for you yet. Private DM conversations and preferences are strictly isolated and never shared in groups.';
            }
            if (lang === 'zh-Hant') {
                return '目前我還沒有特別記下你的個人偏好；直接跟我說「記住…」，我只會在私訊裡幫你記住！';
            }
            if (lang === 'zh-Hans') {
                return '目前我还没有特别记下你的个人偏好；直接跟我说“记住…”，我只会在私信里帮你记住！';
            }
            return 'I have not saved any personal preferences for you yet — say "remember ..." and I will keep it private in our DM.';
        }
        const lines = [...visibleUser, ...visibleRoom].slice(0, 8).map((m) => `• ${m.value}`);
        const header = lang === 'zh-Hant'
            ? context.chatType === 'dm'
                ? '我目前在私訊裡幫你記住了（不會在群組提及）：'
                : '我目前在這個群組裡記得：'
            : lang === 'zh-Hans'
                ? context.chatType === 'dm'
                    ? '我目前在私信里帮你记住了（不会在群组提及）：'
                    : '我目前在这个群组里记得：'
                : context.chatType === 'dm'
                    ? 'Here is what I remember privately in our DM (never shared in groups):'
                    : 'Here is what I remember in this group:';
        return [header, ...lines].join('\n');
    }
    // 4. Remember
    if (REMEMBER_CMD_RE.test(cleaned)) {
        const rawFact = cleaned.replace(REMEMBER_CMD_RE, '').trim();
        const trimmedSuffix = rawFact.replace(PRIVATE_DM_SUFFIX_RE, '').trim();
        const fact = (trimmedSuffix || rawFact).slice(0, 300).trim();
        if (!fact)
            return null;
        const key = await shortNoteKey(fact);
        try {
            await store.rememberUser({
                userId: event.senderId,
                key,
                value: fact,
                kind: 'preference',
                originChatType: context.chatType,
                originRoomId: event.roomId,
            });
        }
        catch (err) {
            if (err instanceof MemoryRejectionError) {
                if (lang === 'zh-Hant') {
                    return '這段內容包含不安全的系統格式或異常指令，為安全起見沒有寫入記憶。';
                }
                if (lang === 'zh-Hans') {
                    return '这段内容包含不安全的系统格式或异常指令，为安全起见没有写入记忆。';
                }
                return 'That note looks unsafe to store, so I skipped saving it to memory.';
            }
            throw err;
        }
        if (lang === 'zh-Hant') {
            return context.chatType === 'dm'
                ? `好的，已私訊記住「${fact}」——之後我會優先參考這項偏好，而且不會在群組中提及。`
                : `好的，已在群組筆記中記下「${fact}」。`;
        }
        if (lang === 'zh-Hans') {
            return context.chatType === 'dm'
                ? `好的，已私信记住「${fact}」——之后我会优先参考这项偏好，而且不会在群组中提及。`
                : `好的，已在群组笔记中记下「${fact}」。`;
        }
        return context.chatType === 'dm'
            ? `Got it — saved privately in our DM: "${fact}" (never shared in groups).`
            : `Got it — saved for this group: "${fact}".`;
    }
    return null;
}
//# sourceMappingURL=memory.js.map