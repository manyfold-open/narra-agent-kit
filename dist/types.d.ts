export type LangCode = 'zh-Hant' | 'zh-Hans' | 'en';
export type ChatType = 'dm' | 'group';
export type EventKind = 'text' | 'notice' | 'image' | 'reaction' | 'edit' | 'redaction' | 'voice' | 'compound' | 'other';
export interface AgentCapabilities {
    supportsVoice?: boolean;
    supportsImages?: boolean;
    supportsProactiveDm?: boolean;
}
export interface AgentSpec {
    id: string;
    matrixId?: string;
    name: string;
    aliases?: string[];
    domainDescription: string;
    domainKeywords?: Array<string | RegExp>;
    antiKeywords?: Array<string | RegExp>;
    silenceThreshold?: number;
    sessionWindowMs?: number;
    staleGroupMs?: number;
    politeYieldDelayMs?: number;
    cooldownMs?: number;
    capabilities?: AgentCapabilities;
}
export interface PeerAgentInfo {
    matrixId: string;
    displayName?: string;
    aliases?: string[];
    roleHint?: string;
}
export interface VoiceMeta {
    rtcSessionId?: string;
    turnId?: string;
    transcript?: string;
}
export interface InboundEvent {
    roomId: string;
    roomName?: string;
    chatType: ChatType;
    eventId: string;
    senderId: string;
    senderName?: string;
    type: string;
    kind: EventKind;
    msgtype?: string;
    text: string;
    timestampMs: number;
    timeIso: string;
    mentions: string[];
    replyToEventId?: string;
    replacesEventId?: string;
    redactsEventId?: string;
    reactionKey?: string;
    isVoice?: boolean;
    voiceMeta?: VoiceMeta;
    mediaUrl?: string;
    coalescedEventIds?: string[];
    raw?: Record<string, unknown>;
}
export interface RoomMemberInfo {
    matrixId: string;
    displayName?: string;
    isAgent: boolean;
}
export interface HistoryTurn {
    eventId: string;
    senderId: string;
    senderName?: string;
    isAgent: boolean;
    isSelf?: boolean;
    text: string;
    timestampMs: number;
}
export interface ReplyTargetContext {
    eventId: string;
    senderId: string;
    senderName?: string;
    isSelf: boolean;
    isAgent: boolean;
    text: string;
}
export interface ActiveSessionInfo {
    active: boolean;
    lastAgentReplyAtMs?: number;
    lastUserTurnAtMs?: number;
    expiresAtMs?: number;
}
export interface RoomContext {
    roomId: string;
    roomName?: string;
    chatType: ChatType;
    members: RoomMemberInfo[];
    peers?: PeerAgentInfo[];
    recentHistory: HistoryTurn[];
    replyToTarget?: ReplyTargetContext;
    consecutiveAgentMessages?: number;
    roomLanguageHint?: LangCode;
    userLanguageHint?: LangCode;
    roomMuted?: boolean;
    roomThreshold?: number;
    activeSession?: ActiveSessionInfo;
    lastUnmentionedReplyAtMs?: number;
    subsequentEvents?: Array<{
        eventId: string;
        senderId: string;
        kind?: string;
    }>;
    latestEventId?: string;
    latestHumanEventId?: string;
}
export interface TriageDecision {
    shouldReply: boolean;
    tier: 0 | 1;
    reason: string;
    confidence: number;
    detectedLang: LangCode;
    shouldQuote: boolean;
    directRoute?: boolean;
    yieldDelayMs?: number;
    triageSource?: 'heuristic' | 'model' | 'fast_path';
}
export type MemoryScope = 'user' | 'room';
export type MemoryKind = 'preference' | 'correction' | 'fact' | 'language' | 'feedback';
export interface MemoryEntry {
    id: string;
    scope: MemoryScope;
    agentId: string;
    userId?: string;
    roomId?: string;
    originChatType?: ChatType;
    kind: MemoryKind;
    key: string;
    value: string;
    confidence?: number;
    createdAt: string;
    updatedAt: string;
}
export interface AgentUpdateItem {
    updateKey: string;
    roomId: string;
    chatType?: ChatType;
    title?: string;
    text: string;
    lang?: LangCode;
    priority?: 'normal' | 'high';
    createdAt?: string;
    metadata?: Record<string, unknown>;
}
export interface TriageModel {
    name?: string;
    score(input: {
        event: InboundEvent;
        context: RoomContext;
        spec: AgentSpec;
        detectedLang: LangCode;
    }): Promise<{
        score: number;
        reason?: string;
    }>;
}
export interface FastPathModel {
    name?: string;
    tryRespond(input: {
        envelope: string;
        event: InboundEvent;
        context: RoomContext;
        decision: TriageDecision;
        signal?: AbortSignal;
    }): Promise<{
        handled: boolean;
        text?: string;
    } | null>;
}
export interface KeyValueStore {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    list<T>(options: {
        prefix: string;
        limit?: number;
    }): Promise<Map<string, T>>;
}
//# sourceMappingURL=types.d.ts.map