import { runSchemaStatements } from './d1.js';
import { isNarraAgent, isSilence, sanitizeMobileLinks } from './guard.js';
import { detectLang } from './lang.js';
import type { MemoryStore } from './memory.js';
import type { AgentUpdateItem, HistoryTurn, LangCode } from './types.js';
import { localDayStartMs, localHour } from './v2/pipeline.js';

export const NARRA_BROADCAST_SCHEMA = `
CREATE TABLE IF NOT EXISTS narra_broadcast_log (
  agent_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  update_key TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, room_id, update_key)
);
`;

export interface BroadcastDedupeStore {
  claimUpdateKey(agentId: string, roomId: string, updateKey: string, sentAtIso: string): Promise<boolean>;
  hasSentKey(agentId: string, roomId: string, updateKey: string): Promise<boolean>;
}

export class D1BroadcastStore implements BroadcastDedupeStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async ensureSchema(): Promise<void> {
    await runSchemaStatements(this.db, NARRA_BROADCAST_SCHEMA);
  }

  async hasSentKey(agentId: string, roomId: string, updateKey: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        'SELECT 1 AS ok FROM narra_broadcast_log WHERE agent_id = ? AND room_id = ? AND update_key = ?',
      )
      .bind(agentId, roomId, updateKey)
      .first<{ ok: number }>();
    return Boolean(row);
  }

  async claimUpdateKey(
    agentId: string,
    roomId: string,
    updateKey: string,
    sentAtIso: string,
  ): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT OR IGNORE INTO narra_broadcast_log (agent_id, room_id, update_key, sent_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(agentId, roomId, updateKey, sentAtIso)
      .run();
    return Number(res.meta.changes ?? 0) > 0;
  }
}

export class InMemoryBroadcastStore implements BroadcastDedupeStore {
  private readonly keys = new Set<string>();

  async hasSentKey(agentId: string, roomId: string, updateKey: string): Promise<boolean> {
    return this.keys.has(`${agentId}::${roomId}::${updateKey}`);
  }

  async claimUpdateKey(
    agentId: string,
    roomId: string,
    updateKey: string,
    _sentAtIso: string,
  ): Promise<boolean> {
    const composite = `${agentId}::${roomId}::${updateKey}`;
    if (this.keys.has(composite)) return false;
    this.keys.add(composite);
    return true;
  }
}

/**
 * Deterministic minute-within-window slot (`0..windowSizeMinutes-1`) per `(agentId, roomId)`
 * so multiple agents scheduled on the same cron never stampede a room simultaneously.
 */
export function staggerWindowMinute(
  agentId: string,
  roomId: string,
  windowSizeMinutes = 60,
): number {
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

export function isWithinStaggerWindow(
  agentId: string,
  roomId: string,
  nowMs = Date.now(),
  windowSizeMinutes = 60,
  toleranceMinutes = 5,
): boolean {
  const slot = staggerWindowMinute(agentId, roomId, windowSizeMinutes);
  const minuteOfHour = new Date(nowMs).getUTCMinutes() % Math.max(1, windowSizeMinutes);
  const diff = (minuteOfHour - slot + windowSizeMinutes) % windowSizeMinutes;
  return diff < toleranceMinutes;
}

/**
 * Returns `true` when the room's trailing >= 2 messages are ALL from `@agent-*` bots
 * (an agent-only echo chamber with no recent human participation).
 */
export function hasOnlyTrailingAgentMessages(
  recentHistory: HistoryTurn[],
  minAgentTail = 2,
): boolean {
  if (recentHistory.length < minAgentTail) return false;
  let trailingAgents = 0;
  for (let i = recentHistory.length - 1; i >= 0; i--) {
    const turn = recentHistory[i];
    if (turn.isAgent || isNarraAgent(turn.senderId)) {
      trailingAgents++;
    } else {
      break;
    }
  }
  return trailingAgents >= minAgentTail;
}

/**
 * The language people in the room have been writing in: the most common of the last `sample`
 * human messages (agents excluded). `null` when nobody has written yet.
 */
export function roomLanguage(recentHistory: HistoryTurn[], sample = 10): LangCode | null {
  const human = recentHistory
    .filter((turn) => !turn.isAgent && !isNarraAgent(turn.senderId) && turn.text.trim())
    .slice(-sample);
  if (human.length === 0) return null;
  const counts = new Map<LangCode, number>();
  for (const turn of human) {
    const lang = detectLang(turn.text);
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  let best: LangCode | null = null;
  let bestCount = 0;
  // Ties go to the most recent message's language.
  for (const turn of [...human].reverse()) {
    const lang = detectLang(turn.text);
    const c = counts.get(lang) ?? 0;
    if (c > bestCount) {
      best = lang;
      bestCount = c;
    }
  }
  return best;
}

const ITEM_KEY_PREFIX = 'item:';

export type BroadcastSkipReason =
  | 'duplicate_items'
  | 'empty_text'
  | 'duplicate_update_key'
  | 'room_muted'
  | 'opted_out'
  | 'agent_only_recent_messages'
  | 'outside_stagger_window'
  | 'room_daily_cap'
  | 'room_busy'
  | 'outside_hours'
  | 'send_failed';

/**
 * Room-level manners for scheduled posts, shared by every agent in the room without coordination:
 * each agent counts the `ai.narra.broadcast` posts it can see in the room's history.
 */
export interface RoomPostingRules {
  /** All agents together post at most this many scheduled messages per room per local day. */
  dailyCap: number;
  /** Do not post within this long after the last human message (people are mid-conversation). */
  quietMs: number;
  /** Local posting hours [start, end) in `timeZone`. */
  startHour: number;
  endHour: number;
  timeZone: string;
}

export const DEFAULT_ROOM_POSTING_RULES: RoomPostingRules = {
  dailyCap: 3,
  quietMs: 10 * 60_000,
  startHour: 9,
  endHour: 21,
  timeZone: 'Europe/London',
};

/** Why a room should not get a scheduled post right now, or null when it may. */
export function roomPostingBlock(
  history: HistoryTurn[],
  nowMs: number,
  rules: RoomPostingRules,
): 'room_daily_cap' | 'room_busy' | 'outside_hours' | null {
  const hour = localHour(nowMs, rules.timeZone);
  if (hour < rules.startHour || hour >= rules.endHour) return 'outside_hours';
  const dayStart = localDayStartMs(nowMs, rules.timeZone);
  if (history.filter((t) => t.isBroadcast && t.timestampMs >= dayStart).length >= rules.dailyCap) {
    return 'room_daily_cap';
  }
  const lastHuman = [...history].reverse().find((t) => !t.isAgent && !isNarraAgent(t.senderId));
  if (lastHuman && nowMs - lastHuman.timestampMs < rules.quietMs) return 'room_busy';
  return null;
}

export interface BroadcastScheduleResult {
  sent: Array<{ roomId: string; updateKey: string; text: string }>;
  skipped: Array<{ roomId: string; updateKey: string; reason: BroadcastSkipReason }>;
}

export interface BroadcastSchedulerOptions {
  agentId: string;
  dedupeStore: BroadcastDedupeStore;
  memoryStore?: MemoryStore;
  isRoomOptedOut?: (roomId: string) => Promise<boolean> | boolean;
  getRecentHistory?: (roomId: string) => Promise<HistoryTurn[]> | HistoryTurn[];
  send: (item: AgentUpdateItem, sanitizedText: string) => Promise<void>;
  enforceStaggerWindow?: boolean;
  staggerWindowMinutes?: number;
  staggerToleranceMinutes?: number;
  /** When set, applies room-level posting manners (daily cap, quiet time, daytime hours). */
  roomRules?: RoomPostingRules | ((roomId: string) => RoomPostingRules | undefined);
  nowMs?: () => number;
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
  private readonly opts: BroadcastSchedulerOptions;

  constructor(options: BroadcastSchedulerOptions) {
    this.opts = options;
  }

  async run(updates: AgentUpdateItem[]): Promise<BroadcastScheduleResult> {
    const result: BroadcastScheduleResult = { sent: [], skipped: [] };
    if (!Array.isArray(updates) || updates.length === 0) return result;

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

      let history: HistoryTurn[] = [];
      if (this.opts.getRecentHistory) {
        history = await this.opts.getRecentHistory(item.roomId);
        if (hasOnlyTrailingAgentMessages(history, 2)) {
          result.skipped.push({
            roomId: item.roomId,
            updateKey: item.updateKey,
            reason: 'agent_only_recent_messages',
          });
          continue;
        }
      }

      const rules =
        typeof this.opts.roomRules === 'function' ? this.opts.roomRules(item.roomId) : this.opts.roomRules;
      if (rules) {
        const block = roomPostingBlock(history, nowMs, rules);
        if (block) {
          result.skipped.push({ roomId: item.roomId, updateKey: item.updateKey, reason: block });
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

      const itemKeys = [...new Set(item.itemKeys ?? [])];
      const freshItemKeys: string[] = [];
      for (const key of itemKeys) {
        if (!(await this.opts.dedupeStore.hasSentKey(this.opts.agentId, item.roomId, ITEM_KEY_PREFIX + key))) {
          freshItemKeys.push(key);
        }
      }
      if (itemKeys.length > 0 && freshItemKeys.length === 0) {
        result.skipped.push({ roomId: item.roomId, updateKey: item.updateKey, reason: 'duplicate_items' });
        continue;
      }
      let text = cleaned;
      if (item.render) {
        const lang = roomLanguage(history) ?? item.lang ?? 'en';
        let rendered = '';
        try {
          rendered = sanitizeMobileLinks(item.render(lang, itemKeys.length > 0 ? freshItemKeys : []));
        } catch {
          rendered = '';
        }
        if (rendered && !isSilence(rendered)) text = rendered;
      }

      const claimed = await this.opts.dedupeStore.claimUpdateKey(
        this.opts.agentId,
        item.roomId,
        item.updateKey,
        nowIso,
      );
      if (!claimed) {
        result.skipped.push({
          roomId: item.roomId,
          updateKey: item.updateKey,
          reason: 'duplicate_update_key',
        });
        continue;
      }

      try {
        await this.opts.send(item, text);
        result.sent.push({ roomId: item.roomId, updateKey: item.updateKey, text });
        for (const key of freshItemKeys) {
          await this.opts.dedupeStore
            .claimUpdateKey(this.opts.agentId, item.roomId, ITEM_KEY_PREFIX + key, nowIso)
            .catch(() => false);
        }
      } catch {
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
