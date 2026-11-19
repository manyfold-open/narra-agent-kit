import type { AgentSpec, HistoryTurn, InboundEvent, PeerAgentInfo, RoomContext, RoomMemberInfo, TriageDecision, TriageModel } from './types.js';
export declare const DEFAULT_SESSION_WINDOW_MS: number;
export declare const DEFAULT_STALE_GROUP_MS: number;
export declare const DEFAULT_SILENCE_THRESHOLD = 0.55;
export declare const DEFAULT_YIELD_DELAY_MS = 1800;
export declare const AGENT_CHAIN_CAP = 6;
export declare const AGENT_CHAIN_RETRY_MS: readonly [15000, 45000, 120000];
/** Extracts peer `@agent-*` members from a room roster, excluding self. */
export declare function inspectRoomPeers(members: RoomMemberInfo[], selfMatrixId?: string): PeerAgentInfo[];
export declare function isSelfMentioned(event: InboundEvent, spec: AgentSpec): boolean;
export declare function findMentionedPeers(event: InboundEvent, spec: AgentSpec, peers?: PeerAgentInfo[]): PeerAgentInfo[];
/**
 * Determines whether a group message is `aimed_elsewhere` (talking to another user or
 * another agent rather than self). Multi-agent `@` prompts that explicitly include self
 * are NOT dropped here — they advance to Tier 1 semantic triage so the matching agent answers.
 */
export declare function isAimedElsewhere(event: InboundEvent, context: RoomContext, spec: AgentSpec): boolean;
/** Tracks active multi-turn sessions per `(roomId, userId)` for 3-minute follow-ups without re-`@`. */
export declare class ActiveSessionTracker {
    private readonly sessions;
    private readonly windowMs;
    constructor(windowMs?: number);
    private key;
    recordAgentReply(roomId: string, userId: string, nowMs?: number): void;
    recordUserTurn(roomId: string, userId: string, nowMs?: number): void;
    isActive(roomId: string, userId: string, nowMs?: number): boolean;
    get(roomId: string, userId: string, nowMs?: number): {
        active: boolean;
    } | {
        lastAgentReplyAtMs: number;
        lastUserTurnAtMs: number;
        expiresAtMs: number;
        active: boolean;
    };
    clear(roomId: string, userId?: string): void;
}
/**
 * Tracks Synapse's `narra_agent_chain_guard` consecutive `@agent-*` message cap (6 in production)
 * and provides the `agent_chain_exhausted` retry schedule `[15_000, 45_000, 120_000]`.
 */
export declare class AgentChainTracker {
    private readonly counts;
    private readonly cap;
    private readonly retryScheduleMs;
    constructor(cap?: number, retryScheduleMs?: readonly number[]);
    recordHuman(roomId: string): void;
    recordAgent(roomId: string): number;
    syncFromHistory(roomId: string, history: HistoryTurn[]): number;
    count(roomId: string): number;
    isExhausted(roomId: string): boolean;
    /**
     * Returns retry delay in ms for attempt index (0-based, or 1-based via `attempt` >= 0):
     * attempt 0 -> 15_000, attempt 1 -> 45_000, attempt 2 -> 120_000, >= 3 -> null.
     */
    nextRetryDelayMs(failedAttempts: number): number | null;
}
export declare function isChainExhaustedError(error: unknown): boolean;
/** Checks whether a peer `@agent-*` already replied after the trigger event in recent history. */
export declare function hasPeerRepliedAfter(event: InboundEvent, context: RoomContext, selfMatrixId?: string): boolean;
export interface PoliteYieldOptions {
    delayMs: number;
    checkPeerAnswered: () => Promise<boolean> | boolean;
    sleep?: (ms: number) => Promise<void>;
}
/**
 * Waits `delayMs` on unmentioned or multi-`@` turns, then yields if a peer agent
 * already answered the room so multiple bots do not pile on.
 */
export declare function executePoliteYield(options: PoliteYieldOptions): Promise<{
    yield: boolean;
    reason?: string;
}>;
/**
 * Zero-LLM-key lightweight Tier 1 heuristic scorer matching `domainKeywords`,
 * `antiKeywords`, and `domainDescription` tokens against the inbound message.
 */
export declare function heuristicDomainScore(event: InboundEvent, spec: AgentSpec, _context?: RoomContext): number;
export interface RouteOptions {
    nowMs?: number;
    triageModel?: TriageModel;
    chainCap?: number;
}
/**
 * Stateless Two-Tier Decentralized Room-Aware Router:
 * - Tier 0 (~1ms, $0): drops self/agents/redactions/stale/aimed_elsewhere/muted,
 *   direct-routes DMs, explicit single `@`, replies to self, and active 3-min sessions.
 * - Tier 1: pluggable `TriageModel` or lightweight keyword/domain heuristic for
 *   unmentioned group turns and multi-`@` disambiguation.
 */
export declare function routeEvent(event: InboundEvent, context: RoomContext, spec: AgentSpec, options?: RouteOptions): Promise<TriageDecision>;
export declare const routeInboundEvent: typeof routeEvent;
export interface RoomRouterConfig {
    spec: AgentSpec;
    triageModel?: TriageModel;
    chainCap?: number;
    now?: () => number;
}
/**
 * Stateful convenience wrapper managing `ActiveSessionTracker` and `AgentChainTracker`
 * across turns in a Worker or Durable Object.
 */
export declare class RoomRouter {
    readonly spec: AgentSpec;
    readonly sessions: ActiveSessionTracker;
    readonly chain: AgentChainTracker;
    private readonly triageModel?;
    private readonly chainCap;
    private readonly now;
    constructor(config: RoomRouterConfig);
    route(event: InboundEvent, context: RoomContext): Promise<TriageDecision>;
    markAgentReplied(roomId: string, userId?: string, nowMs?: number): void;
}
//# sourceMappingURL=router.d.ts.map