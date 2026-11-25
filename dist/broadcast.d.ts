import type { MemoryStore } from './memory.js';
import type { AgentUpdateItem, HistoryTurn, LangCode } from './types.js';
export declare const NARRA_BROADCAST_SCHEMA = "\nCREATE TABLE IF NOT EXISTS narra_broadcast_log (\n  agent_id TEXT NOT NULL,\n  room_id TEXT NOT NULL,\n  update_key TEXT NOT NULL,\n  sent_at TEXT NOT NULL,\n  PRIMARY KEY (agent_id, room_id, update_key)\n);\n";
export interface BroadcastDedupeStore {
    claimUpdateKey(agentId: string, roomId: string, updateKey: string, sentAtIso: string): Promise<boolean>;
    hasSentKey(agentId: string, roomId: string, updateKey: string): Promise<boolean>;
}
export declare class D1BroadcastStore implements BroadcastDedupeStore {
    private readonly db;
    constructor(db: D1Database);
    ensureSchema(): Promise<void>;
    hasSentKey(agentId: string, roomId: string, updateKey: string): Promise<boolean>;
    claimUpdateKey(agentId: string, roomId: string, updateKey: string, sentAtIso: string): Promise<boolean>;
}
export declare class InMemoryBroadcastStore implements BroadcastDedupeStore {
    private readonly keys;
    hasSentKey(agentId: string, roomId: string, updateKey: string): Promise<boolean>;
    claimUpdateKey(agentId: string, roomId: string, updateKey: string, _sentAtIso: string): Promise<boolean>;
}
/**
 * Deterministic minute-within-window slot (`0..windowSizeMinutes-1`) per `(agentId, roomId)`
 * so multiple agents scheduled on the same cron never stampede a room simultaneously.
 */
export declare function staggerWindowMinute(agentId: string, roomId: string, windowSizeMinutes?: number): number;
export declare function isWithinStaggerWindow(agentId: string, roomId: string, nowMs?: number, windowSizeMinutes?: number, toleranceMinutes?: number): boolean;
/**
 * Returns `true` when the room's trailing >= 2 messages are ALL from `@agent-*` bots
 * (an agent-only echo chamber with no recent human participation).
 */
export declare function hasOnlyTrailingAgentMessages(recentHistory: HistoryTurn[], minAgentTail?: number): boolean;
/**
 * The language people in the room have been writing in: the most common of the last `sample`
 * human messages (agents excluded). `null` when nobody has written yet.
 */
export declare function roomLanguage(recentHistory: HistoryTurn[], sample?: number): LangCode | null;
export type BroadcastSkipReason = 'duplicate_items' | 'empty_text' | 'duplicate_update_key' | 'room_muted' | 'opted_out' | 'agent_only_recent_messages' | 'outside_stagger_window' | 'room_daily_cap' | 'room_busy' | 'outside_hours' | 'send_failed';
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
export declare const DEFAULT_ROOM_POSTING_RULES: RoomPostingRules;
/** Why a room should not get a scheduled post right now, or null when it may. */
export declare function roomPostingBlock(history: HistoryTurn[], nowMs: number, rules: RoomPostingRules): 'room_daily_cap' | 'room_busy' | 'outside_hours' | null;
export interface BroadcastScheduleResult {
    sent: Array<{
        roomId: string;
        updateKey: string;
        text: string;
    }>;
    skipped: Array<{
        roomId: string;
        updateKey: string;
        reason: BroadcastSkipReason;
    }>;
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
export declare class ProactiveBroadcastScheduler {
    private readonly opts;
    constructor(options: BroadcastSchedulerOptions);
    run(updates: AgentUpdateItem[]): Promise<BroadcastScheduleResult>;
}
//# sourceMappingURL=broadcast.d.ts.map