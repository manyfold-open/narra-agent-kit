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
    /**
     * How strongly the agent fits the message (see `claimPriority` in gate.ts), sent with the 👀 as
     * `ai.narra.claim.priority`. The highest live claim holds the message, whoever reacted first:
     * Workers receive events seconds apart, so arrival order says nothing about fit.
     */
    priority?: number;
}
/**
 * A claim that carries no priority comes from an older kit, which cannot step back for a better fit:
 * it holds the message as before (first claim wins), so a mixed rollout never double-answers.
 */
export declare const LEGACY_CLAIM_PRIORITY: number;
/** Redaction reason for a claim given up only to retry later (not "I chose not to answer"). */
export declare const CLAIM_RETRY_REASON = "narra:claim-retry";
export interface V2RoomState {
    mode?: ReplyMode;
    /** target event id -> live claims on it (older state stored a single record) */
    claims: Record<string, ClaimRecord[] | ClaimRecord>;
    /** claim reaction event id -> target event id (so a redaction releases the claim) */
    claimReactions: Record<string, string>;
    /** target event id -> how many claims on it were released without an answer */
    released?: Record<string, number>;
}
export declare function emptyRoomState(): V2RoomState;
/** Live claims on `target`, in the order they were made. */
export declare function claimsOn(state: V2RoomState, target: string): ClaimRecord[];
/** Records an agent's 👀 reaction as a claim on the message it reacts to. */
export declare function applyClaimReaction(state: V2RoomState, ev: InboundEvent, selfId: string | undefined): boolean;
/**
 * A redacted claim reaction releases the claim. It counts as "looked and chose not to answer"
 * unless the agent said it only stepped back to retry (`CLAIM_RETRY_REASON`).
 */
export declare function applyClaimRedaction(state: V2RoomState, redactedEventId: string, reason?: string): boolean;
export declare function pruneClaims(state: V2RoomState, nowMs: number, keepMs?: number): void;
/**
 * Another agent whose live claim on one of these events beats this agent, if any. Before this agent
 * claims (`ownClaimAtMs` undefined), any peer claim at least as strong holds the message. After it
 * claimed, only a stronger one, or an equally strong one made earlier, does.
 */
export declare function peerClaimHolder(state: V2RoomState, eventIds: string[], selfId: string | undefined, nowMs: number, ownPriority?: number, ownClaimAtMs?: number): string | undefined;
/**
 * The agent currently in a conversation with `senderId`: the last agent that answered one of their
 * messages within `windowMs`. Undefined when nobody is.
 */
export declare function threadPartner(history: HistoryTurn[], senderId: string, nowMs: number, windowMs?: number): string | undefined;
/** An agent question stays open for answers from anyone this long. */
export declare const OPEN_QUESTION_WINDOW_MS: number;
export interface OpenQuestion {
    agentId: string;
    eventId: string;
    text: string;
    atMs: number;
    /** The person whose message the question answered, when known. */
    askedTo?: string;
}
/**
 * The question an agent put to the room and is still waiting on: the latest agent message, if it
 * asks something, is recent, and has had only a few human messages after it. Anyone may answer it,
 * not only the person it was asked to: in a group, friends answer for each other, and people come
 * back to a question minutes later. This is room state, so every agent derives the same answer.
 */
export declare function openQuestion(history: HistoryTurn[], nowMs: number, excludeEventId?: string): OpenQuestion | undefined;
/**
 * The agent this message most likely continues with: the agent whose open question it follows
 * (anyone may answer it), else the agent that was just talking with this sender.
 */
export declare function conversationOwner(history: HistoryTurn[], event: Pick<InboundEvent, 'eventId' | 'senderId'>, nowMs: number): {
    agentId: string;
    via: 'open_question' | 'thread';
    question?: OpenQuestion;
} | undefined;
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