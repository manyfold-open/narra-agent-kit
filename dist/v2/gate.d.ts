import type { AgentSpec, InboundEvent, RoomContext } from '../types.js';
import { type ReplyMode } from './ledger.js';
/** Stop speaking once this many agent messages follow the last human one (platform rejects the 7th). */
export declare const V2_AGENT_TAIL_CAP = 5;
export type WakeReason = 'dm' | 'mentioned' | 'reply_to_you' | 'your_conversation' | 'handoff' | 'relevant' | 'not_text' | 'from_agent' | 'aimed_elsewhere' | 'mode_mention' | 'mode_quiet' | 'agent_tail_cap' | 'peer_conversation' | 'topic_moved_on' | 'low_relevance' | 'budget';
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
     * message is closer to another agent's requests (`v2.notExamples`) than to this agent's profile.
     */
    score: () => Promise<number | {
        score: number;
        notMine?: boolean;
    }>;
    options?: Partial<WakeGateOptions>;
}
export declare function decideWake(input: WakeGateInput): Promise<WakeDecision>;
//# sourceMappingURL=gate.d.ts.map