import type { MemoryStore } from './memory.js';
import type { AgentUpdateItem, HistoryTurn } from './types.js';
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
export type BroadcastSkipReason = 'empty_text' | 'duplicate_update_key' | 'room_muted' | 'opted_out' | 'agent_only_recent_messages' | 'outside_stagger_window' | 'send_failed';
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