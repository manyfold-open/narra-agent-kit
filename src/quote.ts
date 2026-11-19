import { isNarraAgent } from './guard.js';
import type { ChatType, InboundEvent } from './types.js';

export interface QuoteState {
  chatType?: ChatType;
  isNudge?: boolean;
  /** The newest message event_id in the room timeline. */
  latestEventId?: string;
  /** The newest human-authored message event_id in the room timeline. */
  latestHumanEventId?: string;
  /** Events observed in the room after the target event was posted. */
  subsequentEvents?: Array<{ eventId: string; senderId: string; kind?: string }>;
  /** Explicit count of non-agent messages intervening after the target event. */
  intervenedNonAgentCount?: number;
  /** Explicit override when the caller already determined target is non-latest. */
  replyingToNonLatest?: boolean;
}

/**
 * Determines whether the agent's reply should quote (`m.in_reply_to`) the trigger event.
 *
 * Returns `true` ONLY for human group messages when newer non-agent messages intervened
 * after the target event or when replying to a non-latest message.
 * Returns `false` for the latest message, DMs, nudges, reactions, redactions,
 * and NEVER quotes `@agent-*`.
 */
export function shouldQuote(event: InboundEvent, state: QuoteState = {}): boolean {
  if (!event.eventId || !event.senderId) return false;
  if (isNarraAgent(event.senderId)) return false;
  if (state.isNudge || event.eventId.startsWith('nudge:')) return false;
  if (event.kind === 'reaction' || event.kind === 'redaction') return false;

  const chatType = state.chatType ?? event.chatType;
  if (chatType !== 'group') return false;

  if (state.replyingToNonLatest === true) return true;
  if (typeof state.intervenedNonAgentCount === 'number' && state.intervenedNonAgentCount > 0) {
    return true;
  }

  if (Array.isArray(state.subsequentEvents)) {
    return state.subsequentEvents.some(
      (later) =>
        later.eventId !== event.eventId &&
        Boolean(later.senderId) &&
        !isNarraAgent(later.senderId) &&
        later.kind !== 'reaction' &&
        later.kind !== 'redaction',
    );
  }

  if (state.latestHumanEventId) {
    return state.latestHumanEventId !== event.eventId;
  }

  if (state.latestEventId) {
    return state.latestEventId !== event.eventId;
  }

  return false;
}
