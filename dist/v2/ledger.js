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
/**
 * A claim that carries no priority comes from an older kit, which cannot step back for a better fit:
 * it holds the message as before (first claim wins), so a mixed rollout never double-answers.
 */
export const LEGACY_CLAIM_PRIORITY = Number.MAX_SAFE_INTEGER;
/** Redaction reason for a claim given up only to retry later (not "I chose not to answer"). */
export const CLAIM_RETRY_REASON = 'narra:claim-retry';
export function emptyRoomState() {
    return { claims: {}, claimReactions: {} };
}
/** Live claims on `target`, in the order they were made. */
export function claimsOn(state, target) {
    const v = state.claims[target];
    return !v ? [] : Array.isArray(v) ? v : [v];
}
function priorityOf(claim) {
    return typeof claim.priority === 'number' && Number.isFinite(claim.priority) ? claim.priority : LEGACY_CLAIM_PRIORITY;
}
/** Records an agent's 👀 reaction as a claim on the message it reacts to. */
export function applyClaimReaction(state, ev, selfId) {
    if (ev.kind !== 'reaction' || ev.reactionKey !== CLAIM_REACTION || !ev.replyToEventId)
        return false;
    const fromAgent = ev.senderId === selfId || isNarraAgent(ev.senderId);
    if (!fromAgent)
        return false;
    const list = claimsOn(state, ev.replyToEventId).filter((c) => c.agentId !== ev.senderId);
    list.push({
        agentId: ev.senderId,
        atMs: ev.timestampMs,
        reactionEventId: ev.eventId,
        ...(typeof ev.claimPriority === 'number' ? { priority: ev.claimPriority } : {}),
    });
    state.claims[ev.replyToEventId] = list;
    state.claimReactions[ev.eventId] = ev.replyToEventId;
    return true;
}
/**
 * A redacted claim reaction releases the claim. It counts as "looked and chose not to answer"
 * unless the agent said it only stepped back to retry (`CLAIM_RETRY_REASON`).
 */
export function applyClaimRedaction(state, redactedEventId, reason) {
    const target = state.claimReactions[redactedEventId];
    if (!target)
        return false;
    delete state.claimReactions[redactedEventId];
    const releasedClaim = claimsOn(state, target).find((c) => c.reactionEventId === redactedEventId);
    const releasedPriority = releasedClaim && typeof releasedClaim.priority === 'number' ? releasedClaim.priority : undefined;
    const left = claimsOn(state, target).filter((c) => c.reactionEventId !== redactedEventId);
    if (left.length > 0)
        state.claims[target] = left;
    else
        delete state.claims[target];
    if (reason !== CLAIM_RETRY_REASON) {
        state.released = { ...(state.released ?? {}), [target]: (state.released?.[target] ?? 0) + 1 };
        if (releasedPriority !== undefined && releasedPriority < 1) {
            state.releasedFallback = { ...(state.releasedFallback ?? {}), [target]: (state.releasedFallback?.[target] ?? 0) + 1 };
        }
    }
    return true;
}
export function pruneClaims(state, nowMs, keepMs = 30 * 60_000) {
    for (const target of Object.keys(state.claims)) {
        const left = claimsOn(state, target).filter((c) => nowMs - c.atMs <= keepMs);
        if (left.length > 0)
            state.claims[target] = left;
        else
            delete state.claims[target];
    }
    // Released counts only matter while the message is fresh; keep the newest few.
    for (const map of [state.released, state.releasedFallback]) {
        if (!map)
            continue;
        const keys = Object.keys(map);
        for (const k of keys.slice(0, Math.max(0, keys.length - 200)))
            delete map[k];
    }
    const live = new Set(Object.keys(state.claims).flatMap((t) => claimsOn(state, t).map((c) => c.reactionEventId)));
    for (const reactionId of Object.keys(state.claimReactions)) {
        if (!live.has(reactionId))
            delete state.claimReactions[reactionId];
    }
}
/**
 * Another agent whose live claim on one of these events beats this agent, if any. Before this agent
 * claims (`ownClaimAtMs` undefined), any peer claim at least as strong holds the message. After it
 * claimed, only a stronger one, or an equally strong one made earlier, does.
 */
export function peerClaimHolder(state, eventIds, selfId, nowMs, ownPriority = Number.POSITIVE_INFINITY, ownClaimAtMs) {
    let best;
    for (const id of eventIds) {
        for (const claim of claimsOn(state, id)) {
            if (claim.agentId === selfId || nowMs - claim.atMs > CLAIM_TTL_MS)
                continue;
            const p = priorityOf(claim);
            const beats = ownPriority === Number.POSITIVE_INFINITY
                ? true
                : p > ownPriority ||
                    (p === ownPriority &&
                        (ownClaimAtMs === undefined ||
                            claim.atMs < ownClaimAtMs ||
                            // Same priority, same moment: a fixed order, so exactly one of the two goes on.
                            (claim.atMs === ownClaimAtMs && selfId !== undefined && claim.agentId < selfId)));
            if (beats && (!best || p > priorityOf(best)))
                best = claim;
        }
    }
    return best?.agentId;
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
/** An agent question stays open for answers from anyone this long. */
export const OPEN_QUESTION_WINDOW_MS = 15 * 60_000;
/** After this many human messages without the agent speaking again, the question is stale. */
const OPEN_QUESTION_MAX_REPLIES = 3;
/**
 * Whether an agent message puts a question to the room. Question marks inside list items do not count:
 * "you could also ask: • …？ • …？" offers follow-ups the person may ask, it does not wait for an
 * answer, so a later "謝謝" is not an answer to it.
 */
export function asksSomething(text) {
    const prose = text
        .replace(/https?:\/\/\S+/g, '')
        .split('\n')
        .filter((line) => !/^\s*(?:[•·\-*–—]|\d+[.)、]|[a-zA-Z][.)])\s*/.test(line))
        .join('\n');
    return /[?？]/.test(prose);
}
/**
 * The question an agent put to the room and is still waiting on: the latest agent message, if it
 * asks something, is recent, and has had only a few human messages after it. Anyone may answer it,
 * not only the person it was asked to: in a group, friends answer for each other, and people come
 * back to a question minutes later. This is room state, so every agent derives the same answer.
 */
export function openQuestion(history, nowMs, excludeEventId) {
    let humansAfter = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        const turn = history[i];
        if (turn.eventId === excludeEventId)
            continue;
        if (nowMs - turn.timestampMs > OPEN_QUESTION_WINDOW_MS)
            return undefined;
        if (!isAgentTurn(turn)) {
            if (turn.text.trim())
                humansAfter++;
            if (humansAfter > OPEN_QUESTION_MAX_REPLIES)
                return undefined;
            continue;
        }
        if (turn.isBroadcast)
            continue;
        if (!asksSomething(turn.text))
            return undefined;
        const target = turn.answersEventId ?? turn.replyToEventId;
        const askedTo = target ? history.find((t) => t.eventId === target && !isAgentTurn(t))?.senderId : undefined;
        return {
            agentId: turn.senderId,
            eventId: turn.eventId,
            text: turn.text,
            atMs: turn.timestampMs,
            ...(askedTo ? { askedTo } : {}),
        };
    }
    return undefined;
}
/**
 * The agent this message most likely continues with: the agent whose open question it follows
 * (anyone may answer it), else the agent that was just talking with this sender.
 */
export function conversationOwner(history, event, nowMs) {
    const question = openQuestion(history, nowMs, event.eventId);
    if (question)
        return { agentId: question.agentId, via: 'open_question', question };
    const partner = threadPartner(history, event.senderId, nowMs);
    return partner ? { agentId: partner, via: 'thread' } : undefined;
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
/**
 * Whether any agent other than `selfId` answered one of `eventIds`. A reply that only points to this
 * agent ("@London Chinese Food knows this better") is a handoff, not an answer: pass `pointsHere`
 * to leave those out, so the agent that was pointed to still answers.
 */
export function peerAnswered(history, eventIds, selfId, pointsHere) {
    for (const turn of history) {
        if (!isAgentTurn(turn) || turn.senderId === selfId || turn.isBroadcast)
            continue;
        if (!eventIds.some((id) => answers(turn, id)))
            continue;
        if (pointsHere?.(turn.text))
            continue;
        return turn.senderId;
    }
    return undefined;
}
/** The peer reply to one of `eventIds` that points to this agent, if any (see `peerAnswered`). */
export function peerHandoff(history, eventIds, selfId, pointsHere) {
    for (const turn of history) {
        if (!isAgentTurn(turn) || turn.senderId === selfId || turn.isBroadcast)
            continue;
        if (eventIds.some((id) => answers(turn, id)) && pointsHere(turn.text))
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
    const sender = nameOf(event.senderId, members, history);
    const owner = conversationOwner(history, event, nowMs);
    if (owner?.question) {
        const q = owner.question;
        const mins = Math.max(0, Math.round((nowMs - q.atMs) / 60_000));
        const to = q.askedTo ? (q.askedTo === event.senderId ? sender : nameOf(q.askedTo, members, history)) : 'the room';
        if (q.agentId === selfId) {
            fields.your_open_question =
                `${mins} min ago you asked ${to}: "${clip(q.text, 200)}". Nobody has answered it yet. current_message from ${sender} came after it ` +
                    `and is probably the answer${q.askedTo && q.askedTo !== event.senderId ? ` (in a group, friends answer for each other, so it counts even though you asked ${to})` : ''}.`;
        }
        else {
            fields.sender_is_talking_with = `${nameOf(q.agentId, members, history)} (another agent) asked ${to} a question ${mins} min ago; current_message is probably the answer to it.`;
        }
    }
    else if (owner && owner.agentId !== selfId) {
        fields.sender_is_talking_with = `${sender} is in a conversation with ${nameOf(owner.agentId, members, history)} (another agent).`;
    }
    else if (owner?.agentId === selfId) {
        fields.sender_is_talking_with = `${sender} is in a conversation with you.`;
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