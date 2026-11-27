/**
 * Wake gate for the chat-native (v2) pipeline. The Worker does not decide what to say: it only
 * decides, cheaply, whether this agent's Manyfold brain should look at a message at all, and how
 * long to wait first so the best-fitting agent in a group gets there first.
 */
import { isNarraAgent } from '../guard.js';
import { hashFraction, isAimedElsewhere, isSelfMentioned } from '../router.js';
import type { AgentSpec, InboundEvent, RoomContext } from '../types.js';
import { conversationOwner, type ReplyMode } from './ledger.js';

/** Stop speaking once this many agent messages follow the last human one (platform rejects the 7th). */
export const V2_AGENT_TAIL_CAP = 5;

export type WakeReason =
  | 'dm'
  | 'mentioned'
  | 'reply_to_you'
  | 'your_conversation'
  | 'answers_your_question'
  | 'handoff'
  | 'reaction_to_you'
  | 'proactive'
  | 'agent_hint'
  | 'relevant'
  | 'not_text'
  | 'from_agent'
  | 'aimed_elsewhere'
  | 'mode_mention'
  | 'mode_quiet'
  | 'agent_tail_cap'
  | 'peer_conversation'
  | 'topic_moved_on'
  | 'low_relevance'
  | 'budget';

export interface WakeDecision {
  wake: boolean;
  reason: WakeReason;
  /** Wait this long before claiming, so better-fitting agents go first. */
  delayMs: number;
  /** Post a 👀 claim before calling Manyfold (unaddressed group messages only). */
  claim: boolean;
  /** Addressed to this agent: always gets an answer, even after failures. */
  direct: boolean;
  score?: number;
  /** How clearly this agent beats the other agents' asks (cosine minus best not-example cosine). */
  margin?: number;
  /**
   * Relevant, but no clearer a fit than another agent's (low margin): chatter looks like this, and so
   * does a real ask that fits two agents. Claim only if the ask model says it is a real question or need.
   */
  askCheck?: boolean;
}

export interface WakeGateOptions {
  /** Relevance needed to wake on an unaddressed group message (0..1). */
  threshold: number;
  /** Relevance needed when the sender is already talking with another agent. */
  peerConversationThreshold: number;
  /** Longest wait before claiming, for a message scored exactly at the threshold. */
  maxDelayMs: number;
  /** Shortest wait before claiming an unaddressed message. */
  minDelayMs: number;
  /** Reactions on this agent's own messages that count as a reply to it (e.g. 👍 to confirm). */
  reactionsToSelf?: readonly string[];
  /**
   * Going first also needs this margin over the other agents' asks (cosine minus best not-example
   * cosine), when the agent has notExamples. Chatter ("哈哈好喔", "謝謝") sits at the same cosine to
   * every profile (bge-m3 gives it about 0.55), so its relevance looks high while the margin stays
   * near 0; real asks beat the other agents by 0.08 and more. Below it the agent stays silent.
   * Live data (zack test 2026-11-27): chatter and thanks up to 0.054, real asks from 0.078.
   */
  minRelevantMargin: number;
}

export const DEFAULT_WAKE_GATE_OPTIONS: WakeGateOptions = {
  threshold: 0.5,
  peerConversationThreshold: 0.65,
  maxDelayMs: 4_000,
  minDelayMs: 600,
  minRelevantMargin: 0.07,
};

export interface WakeGateInput {
  event: InboundEvent;
  context: RoomContext;
  spec: AgentSpec;
  mode: ReplyMode;
  nowMs: number;
  /** True when the daily Workers AI budget is used up: no relevance scoring, addressed messages only. */
  budgetExhausted?: boolean;
  /**
   * Relevance of the message to this agent (0..1), computed only when needed. `notMine` means the
   * message is closer to another agent's requests (`v2.notExamples`) than to this agent's profile;
   * `mine` means the opposite: other agents' requests were compared and this agent's profile won.
   */
  score: () => Promise<number | { score: number; notMine?: boolean; mine?: boolean; rawScore?: number; margin?: number }>;
  options?: Partial<WakeGateOptions>;
}

/**
 * How strongly a decision holds the message, sent with the 👀 claim. The highest live claim answers;
 * arrival order only breaks ties. Continuing a conversation beats topical fit.
 */
/** Margin (own cosine minus best not-example cosine) at which an agent counts as a clear winner. */
const CLEAR_MARGIN = 0.3;

function marginFit(margin: number | undefined, fallback: number): number {
  if (margin === undefined || !Number.isFinite(margin)) return fallback;
  return Math.min(1, Math.max(0, margin / CLEAR_MARGIN));
}

/**
 * How strongly a decision holds the message, rounded to what the 👀 carries (`ai.narra.claim.priority`),
 * so an agent compares its own claim with its peers' on the same footing.
 */
export function claimPriority(decision: Pick<WakeDecision, 'reason' | 'score' | 'direct' | 'margin'>): number {
  return Math.round(rawClaimPriority(decision) * 1000) / 1000;
}

function rawClaimPriority(decision: Pick<WakeDecision, 'reason' | 'score' | 'direct' | 'margin'>): number {
  const score = Math.min(1, Math.max(0, decision.score ?? 0));
  if (decision.direct) return 5;
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
    default:
      return 1;
  }
}

function drop(reason: WakeReason, score?: number): WakeDecision {
  return { wake: false, reason, delayMs: 0, claim: false, direct: false, ...(score !== undefined ? { score } : {}) };
}

function direct(reason: WakeReason, claim = false): WakeDecision {
  return { wake: true, reason, delayMs: 0, claim, direct: true };
}

/** An agent message that names this agent and hands it the question. */
function isHandoffToSelf(event: InboundEvent, spec: AgentSpec): boolean {
  return isSelfMentioned(event, spec);
}

export async function decideWake(input: WakeGateInput): Promise<WakeDecision> {
  const { event, context, spec, mode, nowMs } = input;
  const opts = { ...DEFAULT_WAKE_GATE_OPTIONS, ...(input.options ?? {}) };
  const selfId = spec.matrixId;

  if (event.kind === 'reaction') {
    const key = (event.reactionKey ?? event.text ?? '').replace(/[\uFE0F\u{1F3FB}-\u{1F3FF}]/gu, '').trim();
    const wanted = (opts.reactionsToSelf ?? []).map((r) => r.replace(/[\uFE0F\u{1F3FB}-\u{1F3FF}]/gu, '').trim());
    if (
      key &&
      wanted.includes(key) &&
      context.replyToTarget?.isSelf &&
      event.senderId !== selfId &&
      !isNarraAgent(event.senderId)
    ) {
      return direct('reaction_to_you');
    }
    return drop('not_text');
  }
  if (event.kind !== 'text' && event.kind !== 'compound' && event.kind !== 'voice' && event.kind !== 'image') {
    return drop('not_text');
  }

  if (event.senderId === selfId) return drop('from_agent');

  if ((context.consecutiveAgentMessages ?? 0) >= V2_AGENT_TAIL_CAP) return drop('agent_tail_cap');

  if (isNarraAgent(event.senderId)) {
    // Agents only wake each other through an explicit handoff, and never in a DM chain here.
    if (context.chatType === 'group' && !event.isBroadcast && isHandoffToSelf(event, spec)) {
      return { wake: true, reason: 'handoff', delayMs: 0, claim: true, direct: false };
    }
    return drop('from_agent');
  }

  if (context.chatType === 'dm') return direct('dm');

  // Addressed in a group: show the 👀 at once, so people see it was picked up while the brain works.
  if (isSelfMentioned(event, spec)) return direct('mentioned', true);
  if (context.replyToTarget?.isSelf) return direct('reply_to_you', true);
  if (isAimedElsewhere(event, context, spec)) return drop('aimed_elsewhere');

  if (mode === 'quiet') return drop('mode_quiet');
  if (mode === 'mention') return drop('mode_mention');
  if (input.budgetExhausted) return drop('budget');

  // Who this message most likely continues with, judged from the room (the same for every agent):
  // the agent whose question is still waiting for an answer, from anyone, else the agent that was
  // just talking with this sender.
  const owner = conversationOwner(context.recentHistory, event, nowMs);
  const partner = owner?.agentId;
  let scored: { score: number; notMine?: boolean; mine?: boolean; rawScore?: number; margin?: number } | undefined;
  const getScore = async (): Promise<{ score: number; notMine?: boolean; mine?: boolean; rawScore?: number; margin?: number }> => {
    if (!scored) {
      const raw = await input.score();
      scored = typeof raw === 'number' ? { score: raw } : raw;
    }
    return scored;
  };
  if (partner && partner === selfId) {
    // Short follow-ups ("Holborn", "the second one?") stay with this agent even when they look
    // unrelated, but not when the person clearly moved on to another agent's topic.
    const { score, notMine } = await getScore();
    if (!notMine) {
      const reason = owner?.via === 'open_question' ? 'answers_your_question' : 'your_conversation';
      return { wake: true, reason, delayMs: 0, claim: true, direct: false, score };
    }
    // The person moved to another agent's topic: that agent answers, or nobody does.
    return drop('topic_moved_on', score);
  }

  const { score, mine, margin } = await getScore();
  // The sender talking with another agent raises the bar, so follow-ups stay in that thread. But when
  // this message is closer to this agent's asks than to the other agents' (the topic moved here, and
  // the partner drops it as `topic_moved_on`), the usual bar applies or nobody would answer.
  const inPeerThread = Boolean(partner) && !mine;
  const needed = inPeerThread ? opts.peerConversationThreshold : opts.threshold;
  if (score < needed) {
    // Not this agent's ask. Nobody stands in for the right agent: an unowned message gets no answer
    // unless someone @mentions an agent (Zack, 2026-11-27: "沒人 ＠ 就不回").
    return drop(inPeerThread ? 'peer_conversation' : 'low_relevance', score);
  }
  if (margin !== undefined && margin < opts.minRelevantMargin) {
    // Looks relevant, but no closer to this agent than to the others: chatter, or a real ask that fits
    // two agents. Go after the clear fits, and only once the ask model says it is a real ask.
    const jitter = hashFraction(`${event.eventId}:${selfId ?? spec.id}`) * 150;
    return { wake: true, reason: 'relevant', delayMs: Math.round(opts.maxDelayMs + 400 + jitter), claim: true, direct: false, score, margin, askCheck: true };
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
