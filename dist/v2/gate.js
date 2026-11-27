/**
 * Wake gate for the chat-native (v2) pipeline. The Worker does not decide what to say: it only
 * decides, cheaply, whether this agent's Manyfold brain should look at a message at all, and how
 * long to wait first so the best-fitting agent in a group gets there first.
 */
import { isNarraAgent } from '../guard.js';
import { hashFraction, isAimedElsewhere, isSelfMentioned } from '../router.js';
import { conversationOwner } from './ledger.js';
/** Stop speaking once this many agent messages follow the last human one (platform rejects the 7th). */
export const V2_AGENT_TAIL_CAP = 5;
export const DEFAULT_WAKE_GATE_OPTIONS = {
    threshold: 0.5,
    peerConversationThreshold: 0.65,
    maxDelayMs: 4_000,
    minDelayMs: 600,
    fallbackThreshold: 0.3,
    fallbackDelayMs: 20_000,
    fallbackSpreadMs: 8_000,
    minRelevantMargin: 0.05,
};
/**
 * How strongly a decision holds the message, sent with the 👀 claim. The highest live claim answers;
 * arrival order only breaks ties. Continuing a conversation beats topical fit, and a confident fit
 * beats a stand-by fallback.
 */
/** Margin (own cosine minus best not-example cosine) at which an agent counts as a clear winner. */
const CLEAR_MARGIN = 0.3;
function marginFit(margin, fallback) {
    if (margin === undefined || !Number.isFinite(margin))
        return fallback;
    return Math.min(1, Math.max(0, margin / CLEAR_MARGIN));
}
/**
 * How strongly a decision holds the message, rounded to what the 👀 carries (`ai.narra.claim.priority`),
 * so an agent compares its own claim with its peers' on the same footing.
 */
export function claimPriority(decision) {
    return Math.round(rawClaimPriority(decision) * 1000) / 1000;
}
function rawClaimPriority(decision) {
    const score = Math.min(1, Math.max(0, decision.score ?? 0));
    if (decision.direct)
        return 5;
    switch (decision.reason) {
        case 'handoff':
            return 4;
        case 'answers_your_question':
        case 'your_conversation':
            return 3 + score * 0.5;
        case 'relevant':
            // Relevance saturates at 1 for every agent that fits at all, so two confident agents would tie
            // and the faster Worker would win. The margin over the other agents' asks separates them.
            return 1 + score * 0.5 + marginFit(decision.margin, score) * 0.5;
        case 'fallback':
            return score;
        default:
            return 1;
    }
}
function drop(reason, score) {
    return { wake: false, reason, delayMs: 0, claim: false, direct: false, ...(score !== undefined ? { score } : {}) };
}
function direct(reason, claim = false) {
    return { wake: true, reason, delayMs: 0, claim, direct: true };
}
/** An agent message that names this agent and hands it the question. */
function isHandoffToSelf(event, spec) {
    return isSelfMentioned(event, spec);
}
export async function decideWake(input) {
    const { event, context, spec, mode, nowMs } = input;
    const opts = { ...DEFAULT_WAKE_GATE_OPTIONS, ...(input.options ?? {}) };
    const selfId = spec.matrixId;
    if (event.kind === 'reaction') {
        const key = (event.reactionKey ?? event.text ?? '').replace(/[\uFE0F\u{1F3FB}-\u{1F3FF}]/gu, '').trim();
        const wanted = (opts.reactionsToSelf ?? []).map((r) => r.replace(/[\uFE0F\u{1F3FB}-\u{1F3FF}]/gu, '').trim());
        if (key &&
            wanted.includes(key) &&
            context.replyToTarget?.isSelf &&
            event.senderId !== selfId &&
            !isNarraAgent(event.senderId)) {
            return direct('reaction_to_you');
        }
        return drop('not_text');
    }
    if (event.kind !== 'text' && event.kind !== 'compound' && event.kind !== 'voice' && event.kind !== 'image') {
        return drop('not_text');
    }
    if (event.senderId === selfId)
        return drop('from_agent');
    if ((context.consecutiveAgentMessages ?? 0) >= V2_AGENT_TAIL_CAP)
        return drop('agent_tail_cap');
    if (isNarraAgent(event.senderId)) {
        // Agents only wake each other through an explicit handoff, and never in a DM chain here.
        if (context.chatType === 'group' && !event.isBroadcast && isHandoffToSelf(event, spec)) {
            return { wake: true, reason: 'handoff', delayMs: 0, claim: true, direct: false };
        }
        return drop('from_agent');
    }
    if (context.chatType === 'dm')
        return direct('dm');
    // Addressed in a group: show the 👀 at once, so people see it was picked up while the brain works.
    if (isSelfMentioned(event, spec))
        return direct('mentioned', true);
    if (context.replyToTarget?.isSelf)
        return direct('reply_to_you', true);
    if (isAimedElsewhere(event, context, spec))
        return drop('aimed_elsewhere');
    if (mode === 'quiet')
        return drop('mode_quiet');
    if (mode === 'mention')
        return drop('mode_mention');
    if (input.budgetExhausted)
        return drop('budget');
    /** A stand-by (fallback) decision for `fit`, or undefined when it is too far off. */
    const standBy = (fit, needed) => {
        if (!(opts.fallbackThreshold > 0) || fit < opts.fallbackThreshold)
            return undefined;
        // Below 1 on purpose: a stand-by never outranks an agent that goes first (claimPriority).
        const capped = Math.min(fit, 0.99);
        const closeness = Math.min(1, Math.max(0, (capped - opts.fallbackThreshold) / Math.max(0.01, needed - opts.fallbackThreshold)));
        const jitter = hashFraction(`fallback:${event.eventId}:${selfId ?? spec.id}`) * 500;
        const delayMs = Math.round(opts.fallbackDelayMs - closeness * opts.fallbackSpreadMs + jitter);
        return { wake: true, reason: 'fallback', delayMs, claim: true, direct: false, score: capped };
    };
    // Who this message most likely continues with, judged from the room (the same for every agent):
    // the agent whose question is still waiting for an answer, from anyone, else the agent that was
    // just talking with this sender.
    const owner = conversationOwner(context.recentHistory, event, nowMs);
    const partner = owner?.agentId;
    let scored;
    const getScore = async () => {
        if (!scored) {
            const raw = await input.score();
            scored = typeof raw === 'number' ? { score: raw } : raw;
        }
        return scored;
    };
    if (partner && partner === selfId) {
        // Short follow-ups ("Holborn", "the second one?") stay with this agent even when they look
        // unrelated, but not when the person clearly moved on to another agent's topic.
        const { score, notMine, rawScore } = await getScore();
        if (!notMine) {
            const reason = owner?.via === 'open_question' ? 'answers_your_question' : 'your_conversation';
            return { wake: true, reason, delayMs: 0, claim: true, direct: false, score };
        }
        // The person moved to another agent's topic: that agent goes first, but this one still stands by
        // in case nobody takes it (it knows the conversation).
        return standBy(rawScore ?? score, opts.threshold) ?? drop('topic_moved_on', score);
    }
    const { score, mine, notMine, rawScore, margin } = await getScore();
    // The sender talking with another agent raises the bar, so follow-ups stay in that thread. But when
    // this message is closer to this agent's asks than to the other agents' (the topic moved here, and
    // the partner drops it as `topic_moved_on`), the usual bar applies or nobody would answer.
    const inPeerThread = Boolean(partner) && !mine;
    const needed = inPeerThread ? opts.peerConversationThreshold : opts.threshold;
    if (score < needed) {
        // Not sure enough to go first, but close: stand by in case nobody else takes it. "Closer to another
        // agent's asks" only stops going first: the right agent is sometimes misjudged that way (a dataset
        // question scored as another agent's), and a room where every stand-by is zeroed answers nobody.
        const standByScore = notMine ? Math.max(score, rawScore ?? 0) : score;
        return standBy(standByScore, needed) ?? drop(inPeerThread ? 'peer_conversation' : 'low_relevance', score);
    }
    if (margin !== undefined && margin < opts.minRelevantMargin) {
        // Looks relevant, but no closer to this agent than to the others: chatter, or nobody's topic.
        return standBy(Math.min(score, rawScore ?? score), needed) ?? drop('low_margin', score);
    }
    // Higher relevance goes first. Relevance saturates at 1, so the margin over the other agents' asks
    // orders equally confident agents; a per-agent hash breaks exact ties.
    const span = Math.max(0, opts.maxDelayMs - opts.minDelayMs);
    const above = Math.min(1, Math.max(0, (score - needed) / Math.max(0.01, 1 - needed)));
    const clear = marginFit(margin, above);
    const jitter = hashFraction(`${event.eventId}:${selfId ?? spec.id}`) * 150;
    const delayMs = Math.round(opts.minDelayMs + (1 - above) * span + (1 - clear) * 400 + jitter);
    return { wake: true, reason: 'relevant', delayMs, claim: true, direct: false, score, ...(margin !== undefined ? { margin } : {}) };
}
//# sourceMappingURL=gate.js.map