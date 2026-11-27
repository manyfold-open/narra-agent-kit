import { type ReplyMode } from './ledger.js';
/** Reactions the brain may use instead of a text reply. */
export declare const ALLOWED_REACTIONS: readonly ["❤️", "👍", "😂", "🙏", "🎉", "😮"];
export type BrainAction = {
    kind: 'silent';
} | {
    kind: 'react';
    emoji: string;
} | {
    kind: 'reply';
    text: string;
    mode?: ReplyMode;
};
/**
 * Parses the brain's output. A leading `[NO_REPLY]`, `[REACT ❤️]` or `[MODE mention]` line is a
 * directive; anything else is the reply text. Unknown or malformed directives are treated as text
 * with the directive stripped, so a model slip never leaks brackets into the chat.
 */
export declare function parseBrainOutput(raw: string): BrainAction;
/** Instructions sent with every v2 turn. English on purpose: the brain replies in the user's language. */
export declare function chatBehaviourNote(opts: {
    chatType: 'dm' | 'group';
    direct: boolean;
    replyLanguage?: string;
    proactive?: boolean;
    /** Another agent's reply to current_message pointed to this agent. */
    handoff?: boolean;
}): string;
//# sourceMappingURL=actions.d.ts.map