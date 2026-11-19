import type { ChatType, InboundEvent } from './types.js';
/** Narra assigns every agent a Matrix ID of the form `@agent-<hex>:<server>`. */
export declare function isNarraAgent(matrixId: string): boolean;
/**
 * Defuses spoofed context header lines inside user-supplied text by quoting them (`> ...`),
 * preventing prompt-envelope spoofing inside A2A messages.
 */
export declare function defuse(text: string): string;
/** Strips Matrix's quoted reply fallback lines (`> <@user> ...`) from the start of a reply body. */
export declare function stripReplyFallback(body: string): string;
export interface ParseMatrixEventDefaults {
    roomId?: string;
    roomName?: string;
    chatType?: ChatType;
    senderName?: string;
    maxTextLength?: number;
}
/**
 * Parses a raw Matrix/Narra event envelope into a normalized `InboundEvent`.
 * Handles `m.text`, `m.notice`, `m.image`, `m.reaction`, `m.replace` edits,
 * `m.room.redaction`, `ai.netmind.compound`, and `ai.netmind.rtc.agent.*` voice turns.
 * Strips Matrix reply fallbacks cleanly. Returns `null` for unsupported/ignored events.
 */
export declare function parseMatrixEvent(raw: unknown, defaults?: ParseMatrixEventDefaults): InboundEvent | null;
/**
 * Returns `true` when an agent answer represents intentional silence
 * (`(empty response)`, `[NO_REPLY]`, `[silent]`, `...`, whitespace, etc.).
 */
export declare function isSilence(answer: string): boolean;
/**
 * Strips leaked internal agent notes or reasoning tags glued ahead of the real user-facing answer.
 * Preserves URLs and currency amounts cleanly.
 */
export declare function stripLeakedNotes(answer: string): {
    text: string;
    cut: string;
};
/**
 * Ensures URLs stay bare for Narra mobile rendering:
 * - Unwraps Markdown `[text](url)` links into plain text + bare URL
 * - Unwraps brackets/quotes around `(https://...)` or `（https://...）`
 * - Detaches trailing punctuation and adds spacing around bare URLs so clients tap cleanly
 */
export declare function sanitizeMobileLinks(text: string): string;
//# sourceMappingURL=guard.d.ts.map