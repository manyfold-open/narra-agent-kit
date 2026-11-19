import { isNarraAgent, isSilence, sanitizeMobileLinks } from './guard.js';
export const NARRA_BROADCAST_SCHEMA = `
CREATE TABLE IF NOT EXISTS narra_broadcast_log (
  agent_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  update_key TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, room_id, update_key)
);
`;
export class D1BroadcastStore {
    db;
    constructor(db) {
        this.db = db;
    }
    async ensureSchema() {
        await this.db.exec(NARRA_BROADCAST_SCHEMA);
    }
    async hasSentKey(agentId, roomId, updateKey) {
        const row = await this.db
            .prepare('SELECT 1 AS ok FROM narra_broadcast_log WHERE agent_id = ? AND room_id = ? AND update_key = ?')
            .bind(agentId, roomId, updateKey)
            .first();
        return Boolean(row);
    }
    async claimUpdateKey(agentId, roomId, updateKey, sentAtIso) {
        const res = await this.db
            .prepare(`INSERT OR IGNORE INTO narra_broadcast_log (agent_id, room_id, update_key, sent_at)
         VALUES (?, ?, ?, ?)`)
            .bind(agentId, roomId, updateKey, sentAtIso)
            .run();
        return Number(res.meta.changes ?? 0) > 0;
    }
}
export class InMemoryBroadcastStore {
    keys = new Set();
    async hasSentKey(agentId, roomId, updateKey) {
        return this.keys.has(`${agentId}::${roomId}::${updateKey}`);
    }
    async claimUpdateKey(agentId, roomId, updateKey, _sentAtIso) {
        const composite = `${agentId}::${roomId}::${updateKey}`;
        if (this.keys.has(composite))
            return false;
        this.keys.add(composite);
        return true;
    }
}
/**
 * Deterministic minute-within-window slot (`0..windowSizeMinutes-1`) per `(agentId, roomId)`
 * so multiple agents scheduled on the same cron never stampede a room simultaneously.
 */
export function staggerWindowMinute(agentId, roomId, windowSizeMinutes = 60) {
    const input = `${agentId}:${roomId}`;
    // FNV-1a 32-bit hash for uniform distribution across minutes.
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const size = Math.max(1, Math.floor(windowSizeMinutes));
    return hash % size;
}
export function isWithinStaggerWindow(agentId, roomId, nowMs = Date.now(), windowSizeMinutes = 60, toleranceMinutes = 5) {
    const slot = staggerWindowMinute(agentId, roomId, windowSizeMinutes);
    const minuteOfHour = new Date(nowMs).getUTCMinutes() % Math.max(1, windowSizeMinutes);
    const diff = (minuteOfHour - slot + windowSizeMinutes) % windowSizeMinutes;
    return diff < toleranceMinutes;
}
/**
 * Returns `true` when the room's trailing >= 2 messages are ALL from `@agent-*` bots
 * (an agent-only echo chamber with no recent human participation).
 */
export function hasOnlyTrailingAgentMessages(recentHistory, minAgentTail = 2) {
    if (recentHistory.length < minAgentTail)
        return false;
    let trailingAgents = 0;
    for (let i = recentHistory.length - 1; i >= 0; i--) {
        const turn = recentHistory[i];
        if (turn.isAgent || isNarraAgent(turn.senderId)) {
            trailingAgents++;
        }
        else {
            break;
        }
    }
    return trailingAgents >= minAgentTail;
}
/**
 * Staggered proactive update scheduler:
 * - Skips empty `updates` and empty/silent update text
 * - Strictly dedupes via stored `updateKey`
 * - Skips rooms whose last >=2 messages are all `@agent-*`
 * - Honors room mute (`MemoryStore.isRoomMuted`) and room opt-out
 * - Optionally enforces deterministic `staggerWindowMinute(agentId, roomId)`
 */
export class ProactiveBroadcastScheduler {
    opts;
    constructor(options) {
        this.opts = options;
    }
    async run(updates) {
        const result = { sent: [], skipped: [] };
        if (!Array.isArray(updates) || updates.length === 0)
            return result;
        const nowMs = this.opts.nowMs?.() ?? Date.now();
        const nowIso = new Date(nowMs).toISOString();
        for (const item of updates) {
            const cleaned = sanitizeMobileLinks(item.text ?? '');
            if (!cleaned || isSilence(cleaned)) {
                result.skipped.push({
                    roomId: item.roomId,
                    updateKey: item.updateKey,
                    reason: 'empty_text',
                });
                continue;
            }
            if (await this.opts.dedupeStore.hasSentKey(this.opts.agentId, item.roomId, item.updateKey)) {
                result.skipped.push({
                    roomId: item.roomId,
                    updateKey: item.updateKey,
                    reason: 'duplicate_update_key',
                });
                continue;
            }
            if (this.opts.memoryStore && (await this.opts.memoryStore.isRoomMuted(item.roomId))) {
                result.skipped.push({
                    roomId: item.roomId,
                    updateKey: item.updateKey,
                    reason: 'room_muted',
                });
                continue;
            }
            if (this.opts.isRoomOptedOut && (await this.opts.isRoomOptedOut(item.roomId))) {
                result.skipped.push({
                    roomId: item.roomId,
                    updateKey: item.updateKey,
                    reason: 'opted_out',
                });
                continue;
            }
            if (this.opts.getRecentHistory) {
                const history = await this.opts.getRecentHistory(item.roomId);
                if (hasOnlyTrailingAgentMessages(history, 2)) {
                    result.skipped.push({
                        roomId: item.roomId,
                        updateKey: item.updateKey,
                        reason: 'agent_only_recent_messages',
                    });
                    continue;
                }
            }
            if (this.opts.enforceStaggerWindow) {
                const win = this.opts.staggerWindowMinutes ?? 60;
                const tol = this.opts.staggerToleranceMinutes ?? 5;
                if (!isWithinStaggerWindow(this.opts.agentId, item.roomId, nowMs, win, tol)) {
                    result.skipped.push({
                        roomId: item.roomId,
                        updateKey: item.updateKey,
                        reason: 'outside_stagger_window',
                    });
                    continue;
                }
            }
            const claimed = await this.opts.dedupeStore.claimUpdateKey(this.opts.agentId, item.roomId, item.updateKey, nowIso);
            if (!claimed) {
                result.skipped.push({
                    roomId: item.roomId,
                    updateKey: item.updateKey,
                    reason: 'duplicate_update_key',
                });
                continue;
            }
            try {
                await this.opts.send(item, cleaned);
                result.sent.push({ roomId: item.roomId, updateKey: item.updateKey, text: cleaned });
            }
            catch {
                result.skipped.push({
                    roomId: item.roomId,
                    updateKey: item.updateKey,
                    reason: 'send_failed',
                });
            }
        }
        return result;
    }
}
//# sourceMappingURL=broadcast.js.map