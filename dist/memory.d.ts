import type { AgentSpec, ChatType, InboundEvent, LangCode, MemoryEntry, MemoryKind, RoomContext, TriageDecision } from './types.js';
export declare const NARRA_MEMORY_SCHEMA = "\nCREATE TABLE IF NOT EXISTS narra_user_memory (\n  id TEXT PRIMARY KEY,\n  agent_id TEXT NOT NULL,\n  user_id TEXT NOT NULL,\n  origin_chat_type TEXT NOT NULL DEFAULT 'group',\n  origin_room_id TEXT,\n  kind TEXT NOT NULL DEFAULT 'preference',\n  memory_key TEXT NOT NULL,\n  memory_value TEXT NOT NULL,\n  confidence REAL NOT NULL DEFAULT 1.0,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  UNIQUE(agent_id, user_id, origin_chat_type, memory_key)\n);\n\nCREATE INDEX IF NOT EXISTS idx_narra_user_memory_lookup\n  ON narra_user_memory (agent_id, user_id, origin_chat_type, updated_at);\n\nCREATE TABLE IF NOT EXISTS narra_room_memory (\n  id TEXT PRIMARY KEY,\n  agent_id TEXT NOT NULL,\n  room_id TEXT NOT NULL,\n  kind TEXT NOT NULL DEFAULT 'fact',\n  memory_key TEXT NOT NULL,\n  memory_value TEXT NOT NULL,\n  updated_by TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  UNIQUE(agent_id, room_id, memory_key)\n);\n\nCREATE INDEX IF NOT EXISTS idx_narra_room_memory_lookup\n  ON narra_room_memory (agent_id, room_id, kind, updated_at);\n\nCREATE TABLE IF NOT EXISTS narra_learning_log (\n  id TEXT PRIMARY KEY,\n  agent_id TEXT NOT NULL,\n  room_id TEXT NOT NULL,\n  user_id TEXT,\n  event_id TEXT,\n  signal TEXT NOT NULL,\n  delta REAL NOT NULL DEFAULT 0,\n  threshold_after REAL,\n  detail TEXT,\n  created_at TEXT NOT NULL\n);\n\nCREATE INDEX IF NOT EXISTS idx_narra_learning_log_room\n  ON narra_learning_log (agent_id, room_id, created_at);\n\nCREATE TABLE IF NOT EXISTS narra_demand_log (\n  id TEXT PRIMARY KEY,\n  agent_id TEXT NOT NULL,\n  room_id TEXT NOT NULL,\n  user_id TEXT,\n  query TEXT NOT NULL,\n  category TEXT,\n  outcome TEXT NOT NULL DEFAULT 'unanswered',\n  lang TEXT,\n  created_at TEXT NOT NULL\n);\n\nCREATE INDEX IF NOT EXISTS idx_narra_demand_log_room\n  ON narra_demand_log (agent_id, room_id, created_at);\n";
export declare const DEFAULT_ROOM_THRESHOLD = 0.55;
export declare const MIN_ROOM_THRESHOLD = 0.25;
export declare const MAX_ROOM_THRESHOLD = 0.95;
export declare class MemoryRejectionError extends Error {
    readonly reason: string;
    constructor(message: string, reason: string);
}
/**
 * Validates memory keys and values against prompt-injection payloads, envelope spoofing,
 * secret exfiltration attempts, and malformed control characters.
 */
export declare function validateMemoryWrite(key: string, value: string): {
    safe: boolean;
    reason?: string;
};
export declare function isInjectionAttempt(text: string): boolean;
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
/**
 * D1-backed 3-layer Self-Learning Engine:
 * 1. User memory (`narra_user_memory`) with strict DM-to-group privacy isolation.
 * 2. Room memory (`narra_room_memory`) for group facts, corrections, language, mute & threshold.
 * 3. Learning & demand logs (`narra_learning_log`, `narra_demand_log`) for adaptive noise control.
 */
export declare class MemoryStore {
    private readonly db;
    private readonly agentId;
    private readonly defaultRoomThreshold;
    private readonly minThreshold;
    private readonly maxThreshold;
    private readonly now;
    constructor(db: D1Database, agentId: string, options?: MemoryStoreOptions);
    ensureSchema(): Promise<void>;
    private clampThreshold;
    private logLearning;
    rememberUser(input: RememberUserInput): Promise<MemoryEntry>;
    rememberRoom(input: RememberRoomInput): Promise<MemoryEntry>;
    /**
     * Recalls safe memories for a turn.
     * PRIVACY BOUNDARY: When `chatType === 'group'`, private DM user memories
     * (`origin_chat_type = 'dm'`) are STRICTLY excluded and never surfaced.
     * Explicit group notes are visible only in the room that saved them.
     */
    recallForTurn(input: RecallTurnInput): Promise<RecallTurnResult>;
    forget(input: {
        scope: 'user' | 'room' | 'all';
        userId?: string;
        roomId?: string;
        key?: string;
        originChatType?: ChatType;
        noteRoomId?: string;
    }): Promise<number>;
    private upsertInternalRoomState;
    getRoomThreshold(roomId: string): Promise<number>;
    isRoomMuted(roomId: string): Promise<boolean>;
    setRoomMute(roomId: string, muted: boolean, updatedBy?: string): Promise<void>;
    /**
     * Records feedback and updates the room's adaptive silence threshold:
     * - `negative` feedback raises the silence threshold (agent speaks less often unmentioned).
     * - `positive` feedback gently lowers the silence threshold (within `minThreshold`).
     * - `mute` / `unmute` toggles room mute state.
     */
    recordFeedback(input: RecordFeedbackInput): Promise<{
        threshold: number;
        muted: boolean;
    }>;
    logDemand(input: LogDemandInput): Promise<void>;
    getLearningLog(roomId?: string, limit?: number): Promise<Array<{
        id: string;
        roomId: string;
        userId: string | null;
        signal: string;
        delta: number;
        thresholdAfter: number | null;
        detail: string | null;
        createdAt: string;
    }>>;
    getDemandLog(roomId?: string, limit?: number): Promise<Array<{
        id: string;
        roomId: string;
        userId: string | null;
        query: string;
        category: string | null;
        outcome: string;
        lang: string | null;
        createdAt: string;
    }>>;
    getPreferredLang(userId: string, chatType: ChatType): Promise<LangCode | undefined>;
}
export interface StandardMemoryCommandInput {
    store: MemoryStore;
    event: InboundEvent;
    context: RoomContext;
    decision: TriageDecision;
    memories: RecallTurnResult;
    spec: AgentSpec;
}
/**
 * Handles universal D1 3-layer memory commands (`先安靜`/`恢復`, `忘掉`, `你記得什麼`, `記住...`)
 * on directly addressed turns (`dm`, `explicit_mention`, `reply_to_self`) with strict
 * DM-to-group privacy isolation and prompt-injection rejection.
 */
export declare function handleStandardMemoryCommand(input: StandardMemoryCommandInput): Promise<string | null>;
//# sourceMappingURL=memory.d.ts.map