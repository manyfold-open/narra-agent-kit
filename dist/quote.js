import { isNarraAgent } from './guard.js';
/**
 * Determines whether the agent's reply should quote (`m.in_reply_to`) the trigger event.
 *
 * Returns `true` ONLY for human group messages when newer non-agent messages intervened
 * after the target event or when replying to a non-latest message.
 * Returns `false` for the latest message, DMs, nudges, reactions, redactions,
 * and NEVER quotes `@agent-*`.
 */
export function shouldQuote(event, state = {}) {
    if (!event.eventId || !event.senderId)
        return false;
    if (isNarraAgent(event.senderId))
        return false;
    if (state.isNudge || event.eventId.startsWith('nudge:'))
        return false;
    if (event.kind === 'reaction' || event.kind === 'redaction')
        return false;
    const chatType = state.chatType ?? event.chatType;
    if (chatType !== 'group')
        return false;
    if (state.replyingToNonLatest === true)
        return true;
    if (typeof state.intervenedNonAgentCount === 'number' && state.intervenedNonAgentCount > 0) {
        return true;
    }
    if (Array.isArray(state.subsequentEvents)) {
        return state.subsequentEvents.some((later) => later.eventId !== event.eventId &&
            Boolean(later.senderId) &&
            !isNarraAgent(later.senderId) &&
            later.kind !== 'reaction' &&
            later.kind !== 'redaction');
    }
    if (state.latestHumanEventId) {
        return state.latestHumanEventId !== event.eventId;
    }
    if (state.latestEventId) {
        return state.latestEventId !== event.eventId;
    }
    return false;
}
//# sourceMappingURL=quote.js.map