export interface RenderedMention {
    body: string;
    /** `org.matrix.custom.html` payload, or `null` when there is no human pill mention. */
    html: string | null;
    /** Human Matrix user IDs to include in `m.mentions.user_ids`. NEVER contains `@agent-*` or self. */
    userIds: string[];
}
/**
 * Turns `[@Name](@user:server)` markup into Matrix pill mentions (`m.mentions` + `matrix.to` HTML pill).
 * NEVER creates Matrix `@mentions` for `@agent-*` or `selfMatrixId` (to avoid agent mention loops).
 */
export declare function renderMentions(text: string, selfMatrixId?: string): RenderedMention;
/** Plain text version (for APIs without HTML pills). */
export declare function plainMentions(text: string, selfMatrixId?: string): string;
export interface MessageContentOptions {
    selfMatrixId?: string;
    replyToEventId?: string;
    sanitizeLinks?: boolean;
    msgtype?: 'm.text' | 'm.notice';
}
/**
 * Builds a Matrix `m.room.message` content object with safe mentions and optional reply relation.
 * Accepts either an options object or `(text, selfMatrixId, replyToEventId)`.
 */
export declare function messageContent(text: string, optionsOrSelfId?: MessageContentOptions | string, replyToLegacy?: string): Record<string, unknown>;
/**
 * Builds a Matrix `m.replace` edit payload replacing one of the agent's own earlier messages.
 */
export declare function editContent(eventId: string, text: string, optionsOrSelfId?: MessageContentOptions | string): Record<string, unknown>;
//# sourceMappingURL=mentions.d.ts.map