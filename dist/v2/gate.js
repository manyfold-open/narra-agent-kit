/**
 * Wake gate for the chat-native (v2) pipeline. The Worker does not decide what to say: it only
 * decides, cheaply, whether this agent's Manyfold brain should look at a message at all, and how
 * long to wait first so the best-fitting agent in a group gets there first.
 */
import { isNarraAgent } from '../guard.js';
import { hashFraction, isAimedElsewhere, isSelfMentioned } from '../router.js';
import { THREAD_WINDOW_MS, threadPartner } from './ledger.js';
/** Stop speaking once this many agent messages follow the last human one (platform rejects the 7th). */
export const V2_AGENT_TAIL_CAP = 5;
export const DEFAULT_WAKE_GATE_OPTIONS = {
    threshold: 0.5,
    peerConversationThreshold: 0.8,
    maxDelayMs: 4_000,
    minDelayMs: 600,
};
function drop(reason, score) {
    return { wake: false, reason, delayMs: 0, claim: false, direct: false, ...(score !== undefined ? { score } : {}) };
}
function direct(reason) {
    return { wake: true, reason, delayMs: 0, claim: false, direct: true };
}
/** An agent message that names this agent and hands it the question. */
function isHandoffToSelf(event, spec) {
    return isSelfMentioned(event, spec);
}
export async function decideWake(input) {
    const { event, context, spec, mode, nowMs } = input;
    const opts = { ...DEFAULT_WAKE_GATE_OPTIONS, ...(input.options ?? {}) };
    const selfId = spec.matrixId;
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
    if (isSelfMentioned(event, spec))
        return direct('mentioned');
    if (context.replyToTarget?.isSelf)
        return direct('reply_to_you');
    if (isAimedElsewhere(event, context, spec))
        return drop('aimed_elsewhere');
    if (mode === 'quiet')
        return drop('mode_quiet');
    if (mode === 'mention')
        return drop('mode_mention');
    if (input.budgetExhausted)
        return drop('budget');
    const partner = threadPartner(context.recentHistory, event.senderId, nowMs, THREAD_WINDOW_MS);
    if (partner && partner === selfId) {
        return { wake: true, reason: 'your_conversation', delayMs: 0, claim: true, direct: false };
    }
    const score = await input.score();
    const needed = partner ? opts.peerConversationThreshold : opts.threshold;
    if (score < needed)
        return drop(partner ? 'peer_conversation' : 'low_relevance', score);
    // Higher relevance goes first; a per-agent hash breaks ties so two agents never collide exactly.
    const span = Math.max(0, opts.maxDelayMs - opts.minDelayMs);
    const fit = Math.min(1, Math.max(0, (score - needed) / Math.max(0.01, 1 - needed)));
    const jitter = hashFraction(`${event.eventId}:${selfId ?? spec.id}`) * 300;
    const delayMs = Math.round(opts.minDelayMs + (1 - fit) * span + jitter);
    return { wake: true, reason: 'relevant', delayMs, claim: true, direct: false, score };
}
//# sourceMappingURL=gate.js.map