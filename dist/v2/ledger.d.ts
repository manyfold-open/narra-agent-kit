import type { HistoryTurn, InboundEvent, RoomMemberInfo } from '../types.js';
/** How often the agent speaks in this room. */
export type ReplyMode = 'ambient' | 'mention' | 'quiet';
export declare const REPLY_MODES: readonly ReplyMode[];
/** Reaction an agent puts on a message it is about to answer ("I've got this"). */
export declare const CLAIM_REACTION = "\uD83D\uDC40";
/** A claim older than this no longer blocks other agents (the claimer crashed or went silent). */
export declare const CLAIM_TTL_MS = 90000;
/** An agent that answered a person within this window is "in a conversation" with them. */
export declare const THREAD_WINDOW_MS: number;
/** Human messages younger than this with no agent answer count as unanswered. */
export declare const OPEN_ASK_WINDOW_MS: number;
export interface ClaimRecord {
    agentId: string;
    atMs: number;
    reactionEventId?: string;
}
export interface V2RoomState {
    mode?: ReplyMode;
    /** target event id -> who claimed it */
    claims: Record<string, ClaimRecord>;
    /** claim reaction event id -> target event id (so a redaction releases the claim) */
    claimReactions: Record<string, string>;
}
export declare function emptyRoomState(): V2RoomState;
/** Records an agent's 👀 reaction as a claim on the message it reacts to. */
export declare function applyClaimReaction(state: V2RoomState, ev: InboundEvent, selfId: string | undefined): boolean;
/** A redacted claim reaction releases the claim. */
export declare function applyClaimRedaction(state: V2RoomState, redactedEventId: string): boolean;
export declare function pruneClaims(state: V2RoomState, nowMs: number, keepMs?: number): void;
/** Another agent holding a live claim on any of these events, if one does. */
export declare function peerClaimHolder(state: V2RoomState, eventIds: string[], selfId: string | undefined, nowMs: number): string | undefined;
/**
 * The agent currently in a conversation with `senderId`: the last agent that answered one of their
 * messages within `windowMs`. Undefined when nobody is.
 */
export declare function threadPartner(history: HistoryTurn[], senderId: string, nowMs: number, windowMs?: number): string | undefined;
/** Recent human messages no agent has answered yet (oldest first). */
export declare function unansweredHumanMessages(history: HistoryTurn[], nowMs: number, windowMs?: number): HistoryTurn[];
/** Whether any agent other than `selfId` answered one of `eventIds`. */
export declare function peerAnswered(history: HistoryTurn[], eventIds: string[], selfId: string | undefined): string | undefined;
/** Number of scheduled posts (`ai.narra.broadcast`) any agent made in this room since `sinceMs`. */
export declare function broadcastsSince(history: HistoryTurn[], sinceMs: number): number;
export interface LedgerSummaryInput {
    history: HistoryTurn[];
    members: RoomMemberInfo[];
    selfId: string | undefined;
    event: InboundEvent;
    nowMs: number;
    mode: ReplyMode;
    wakeReason: string;
}
/**
 * Compact, model-facing description of the room's state. Kept short on purpose: it rides on every
 * Manyfold call, so every line must change what a good group member would say.
 */
export declare function buildLedgerSummary(input: LedgerSummaryInput): Record<string, string>;
//# sourceMappingURL=ledger.d.ts.map