import type { AgentSpec, InboundEvent, RoomContext } from '../types.js';
import { type ReplyMode } from './ledger.js';
/** Stop speaking once this many agent messages follow the last human one (platform rejects the 7th). */
export declare const V2_AGENT_TAIL_CAP = 5;
export type WakeReason = 'dm' | 'mentioned' | 'reply_to_you' | 'your_conversation' | 'answers_your_question' | 'handoff' | 'reaction_to_you' | 'proactive' | 'agent_hint' | 'relevant' | 'fallback' | 'not_text' | 'from_agent' | 'aimed_elsewhere' | 'mode_mention' | 'mode_quiet' | 'agent_tail_cap' | 'peer_conversation' | 'topic_moved_on' | 'low_relevance' | 'low_margin' | 'budget';
export interface WakeDecision {
    wake: boolean;
    reason: WakeReason;
    /** Wait this long before claiming, so better-fitting agents go first. */
    delayMs: number;
    /** Post a 👀 claim before calling Manyfold (unaddressed group messages only). */
    claim: boolean;
    /** Addressed to this agent: always gets an answer, even after failures. */
    direct: boolean;
    score?: number;
    /** How clearly this agent beats the other agents' asks (cosine minus best not-example cosine). */
    margin?: number;
}
export interface WakeGateOptions {
    /** Relevance needed to wake on an unaddressed group message (0..1). */
    threshold: number;
    /** Relevance needed when the sender is already talking with another agent. */
    peerConversationThreshold: number;
    /** Longest wait before claiming, for a message scored exactly at the threshold. */
    maxDelayMs: number;
    /** Shortest wait before claiming an unaddressed message. */
    minDelayMs: number;
    /** Reactions on this agent's own messages that count as a reply to it (e.g. 👍 to confirm). */
    reactionsToSelf?: readonly string[];
    /**
     * Below the wake bar but at least this relevant: if no agent has answered or claimed the message
     * after `fallbackDelayMs`, this agent takes it (the closest fit goes first). 0 turns it off.
     */
    fallbackThreshold: number;
    /** Wait before a fallback agent takes an unanswered message, for a score right at the threshold... */
    fallbackDelayMs: number;
    /** ...minus up to this much for a better fit, so the closest agent goes first. */
    fallbackSpreadMs: number;
    /**
     * Going first also needs this margin over the other agents' asks (cosine minus best not-example
     * cosine), when the agent has notExamples. Chatter ("哈哈好喔", "謝謝") sits at the same cosine to
     * every profile (bge-m3 gives it about 0.55), so its relevance looks high while the margin stays
     * near 0; real asks beat the other agents by 0.08 and more. Below it the agent only stands by.
     */
    minRelevantMargin: number;
}
export declare const DEFAULT_WAKE_GATE_OPTIONS: WakeGateOptions;
export interface WakeGateInput {
    event: InboundEvent;
    context: RoomContext;
    spec: AgentSpec;
    mode: ReplyMode;
    nowMs: number;
    /** True when the daily Workers AI budget is used up: no relevance scoring, addressed messages only. */
    budgetExhausted?: boolean;
    /**
     * Relevance of the message to this agent (0..1), computed only when needed. `notMine` means the
     * message is closer to another agent's requests (`v2.notExamples`) than to this agent's profile;
     * `mine` means the opposite: other agents' requests were compared and this agent's profile won.
     */
    score: () => Promise<number | {
        score: number;
        notMine?: boolean;
        mine?: boolean;
        rawScore?: number;
        margin?: number;
    }>;
    options?: Partial<WakeGateOptions>;
}
/**
 * How strongly a decision holds the message, rounded to what the 👀 carries (`ai.narra.claim.priority`),
 * so an agent compares its own claim with its peers' on the same footing.
 */
export declare function claimPriority(decision: Pick<WakeDecision, 'reason' | 'score' | 'direct' | 'margin'>): number;
export declare function decideWake(input: WakeGateInput): Promise<WakeDecision>;
//# sourceMappingURL=gate.d.ts.map