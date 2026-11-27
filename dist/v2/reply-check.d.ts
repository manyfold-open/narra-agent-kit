/** First line of the system prompt (tests' fake models key on it). */
export declare const REPLY_CHECK_MARKER = "You check a reply an AI agent is about to post in a group chat.";
export interface ReplyCheckInput {
    question: string;
    reply: string;
    agentName: string;
    /** What the agent is for, so "I checked my own data and it is not there" reads as an answer. */
    agentDomain?: string;
    /** The reply is the start of a streamed answer and may be cut off mid-sentence. */
    partial?: boolean;
}
export declare function parseReplyVerdict(raw: unknown): boolean | undefined;
/**
 * true: the reply helps (post it). false: it only declines, says the agent cannot help, points
 * elsewhere, or offers something other than what was asked (drop it). undefined: the check is
 * unavailable or unclear; callers post the reply (fail open).
 */
export declare function checkReplyHelps(ai: unknown, input: ReplyCheckInput, options?: {
    model?: string;
    timeoutMs?: number;
}): Promise<boolean | undefined>;
//# sourceMappingURL=reply-check.d.ts.map