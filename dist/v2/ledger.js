/**
 * Room ledger for the chat-native (v2) pipeline: what an agent needs to know about a room to act like
 * a member of it. Everything here is derived from Matrix events this agent already receives, so each
 * agent keeps its own copy and no central coordinator is needed.
 */
import { isNarraAgent } from '../guard.js';
export const REPLY_MODES = ['ambient', 'mention', 'quiet'];
/** Reaction an agent puts on a message it is about to answer ("I've got this"). */
export const CLAIM_REACTION = '👀';
/** A claim older than this no longer blocks other agents (the claimer crashed or went silent). */
export const CLAIM_TTL_MS = 90_000;
/** An agent that answered a person within this window is "in a conversation" with them. */
export const THREAD_WINDOW_MS = 3 * 60_000;
/** Human messages younger than this with no agent answer count as unanswered. */
export const OPEN_ASK_WINDOW_MS = 15 * 60_000;
export function emptyRoomState() {
    return { claims: {}, claimReactions: {} };
}
/** Records an agent's 👀 reaction as a claim on the message it reacts to. */
export function applyClaimReaction(state, ev, selfId) {
    if (ev.kind !== 'reaction' || ev.reactionKey !== CLAIM_REACTION || !ev.replyToEventId)
        return false;
    const fromAgent = ev.senderId === selfId || isNarraAgent(ev.senderId);
    if (!fromAgent)
        return false;
    const existing = state.claims[ev.replyToEventId];
    // First claim wins; a later claim from another agent does not take it over.
    if (!existing || existing.agentId === ev.senderId) {
        state.claims[ev.replyToEventId] = {
            agentId: ev.senderId,
            atMs: ev.timestampMs,
            reactionEventId: ev.eventId,
        };
    }
    state.claimReactions[ev.eventId] = ev.replyToEventId;
    return true;
}
/** A redacted claim reaction releases the claim. */
export function applyClaimRedaction(state, redactedEventId) {
    const target = state.claimReactions[redactedEventId];
    if (!target)
        return false;
    delete state.claimReactions[redactedEventId];
    if (state.claims[target]?.reactionEventId === redactedEventId)
        delete state.claims[target];
    return true;
}
export function pruneClaims(state, nowMs, keepMs = 30 * 60_000) {
    for (const [target, claim] of Object.entries(state.claims)) {
        if (nowMs - claim.atMs > keepMs) {
            delete state.claims[target];
            if (claim.reactionEventId)
                delete state.claimReactions[claim.reactionEventId];
        }
    }
    const live = new Set(Object.values(state.claims).map((c) => c.reactionEventId));
    for (const reactionId of Object.keys(state.claimReactions)) {
        if (!live.has(reactionId))
            delete state.claimReactions[reactionId];
    }
}
/** Another agent holding a live claim on any of these events, if one does. */
export function peerClaimHolder(state, eventIds, selfId, nowMs) {
    for (const id of eventIds) {
        const claim = state.claims[id];
        if (claim && claim.agentId !== selfId && nowMs - claim.atMs <= CLAIM_TTL_MS)
            return claim.agentId;
    }
    return undefined;
}
function isAgentTurn(turn) {
    return turn.isAgent || isNarraAgent(turn.senderId);
}
/** The agent turn that answers `target`, judged by the hidden answer marker or a quote. */
function answers(turn, targetId) {
    return turn.answersEventId === targetId || turn.replyToEventId === targetId;
}
/**
 * The agent currently in a conversation with `senderId`: the last agent that answered one of their
 * messages within `windowMs`. Undefined when nobody is.
 */
export function threadPartner(history, senderId, nowMs, windowMs = THREAD_WINDOW_MS) {
    const senderMessageIds = new Set(history.filter((t) => t.senderId === senderId).map((t) => t.eventId));
    for (let i = history.length - 1; i >= 0; i--) {
        const turn = history[i];
        if (nowMs - turn.timestampMs > windowMs)
            break;
        if (!isAgentTurn(turn) || turn.isBroadcast)
            continue;
        const target = turn.answersEventId ?? turn.replyToEventId;
        if (target && senderMessageIds.has(target))
            return turn.senderId;
    }
    return undefined;
}
/** Recent human messages no agent has answered yet (oldest first). */
export function unansweredHumanMessages(history, nowMs, windowMs = OPEN_ASK_WINDOW_MS) {
    const answered = new Set();
    for (const turn of history) {
        if (!isAgentTurn(turn) || turn.isBroadcast)
            continue;
        const target = turn.answersEventId ?? turn.replyToEventId;
        if (target)
            answered.add(target);
    }
    return history.filter((t) => !isAgentTurn(t) && nowMs - t.timestampMs <= windowMs && t.text.trim() && !answered.has(t.eventId));
}
/** Whether any agent other than `selfId` answered one of `eventIds`. */
export function peerAnswered(history, eventIds, selfId) {
    for (const turn of history) {
        if (!isAgentTurn(turn) || turn.senderId === selfId || turn.isBroadcast)
            continue;
        if (eventIds.some((id) => answers(turn, id)))
            return turn.senderId;
    }
    return undefined;
}
/** Number of scheduled posts (`ai.narra.broadcast`) any agent made in this room since `sinceMs`. */
export function broadcastsSince(history, sinceMs) {
    return history.filter((t) => t.isBroadcast && t.timestampMs >= sinceMs).length;
}
function nameOf(id, members, history) {
    const member = members.find((m) => m.matrixId === id);
    if (member?.displayName)
        return member.displayName;
    const turn = history.find((t) => t.senderId === id && t.senderName);
    return turn?.senderName ?? id;
}
function clip(text, max) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
/**
 * Compact, model-facing description of the room's state. Kept short on purpose: it rides on every
 * Manyfold call, so every line must change what a good group member would say.
 */
export function buildLedgerSummary(input) {
    const { history, members, selfId, event, nowMs } = input;
    const fields = {
        reply_mode: input.mode,
        why_you_were_woken: input.wakeReason,
    };
    const partner = threadPartner(history, event.senderId, nowMs);
    if (partner && partner !== selfId) {
        fields.sender_is_talking_with = `${nameOf(event.senderId, members, history)} is in a conversation with ${nameOf(partner, members, history)} (another agent).`;
    }
    else if (partner === selfId) {
        fields.sender_is_talking_with = `${nameOf(event.senderId, members, history)} is in a conversation with you.`;
    }
    const open = unansweredHumanMessages(history, nowMs).filter((t) => t.eventId !== event.eventId).slice(-4);
    if (open.length > 0) {
        fields.earlier_unanswered_messages = open
            .map((t) => `- ${nameOf(t.senderId, members, history)}: ${clip(t.text, 120)}`)
            .join('\n');
    }
    // The last few turns in order (people and agents), so follow-ups like a place name answering
    // "where are you?" read naturally.
    const timeline = history.filter((t) => t.eventId !== event.eventId && t.text.trim()).slice(-8);
    if (timeline.length > 0) {
        fields.conversation_so_far = timeline
            .map((t) => {
            const who = t.senderId === selfId ? 'you' : nameOf(t.senderId, members, history);
            const mins = Math.max(0, Math.round((nowMs - t.timestampMs) / 60_000));
            return `- [${mins}m ago] ${who}${t.isBroadcast ? ' (scheduled post)' : ''}: ${clip(t.text, 160)}`;
        })
            .join('\n');
    }
    const mine = history.filter((t) => t.senderId === selfId && !t.isBroadcast).slice(-5);
    if (mine.length > 0) {
        fields.your_recent_messages_here = mine.map((t) => `- ${clip(t.text, 200)}`).join('\n');
    }
    return fields;
}
//# sourceMappingURL=ledger.js.map