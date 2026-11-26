/**
 * Wake gate for the chat-native (v2) pipeline. The Worker does not decide what to say: it only
 * decides, cheaply, whether this agent's Manyfold brain should look at a message at all, and how
 * long to wait first so the best-fitting agent in a group gets there first.
 */
import { isNarraAgent } from '../guard.js';
import { hashFraction, isAimedElsewhere, isSelfMentioned } from '../router.js';
import type { AgentSpec, InboundEvent, RoomContext } from '../types.js';
import { THREAD_WINDOW_MS, threadPartner, type ReplyMode } from './ledger.js';

/** Stop speaking once this many agent messages follow the last human one (platform rejects the 7th). */
export const V2_AGENT_TAIL_CAP = 5;

export type WakeReason =
  | 'dm'
  | 'mentioned'
  | 'reply_to_you'
  | 'your_conversation'
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
}

export const DEFAULT_WAKE_GATE_OPTIONS: WakeGateOptions = {
  threshold: 0.5,
  peerConversationThreshold: 0.65,
  maxDelayMs: 4_000,
  minDelayMs: 600,
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
  score: () => Promise<number | { score: number; notMine?: boolean; mine?: boolean }>;
  options?: Partial<WakeGateOptions>;
}

function drop(reason: WakeReason, score?: number): WakeDecision {
  return { wake: false, reason, delayMs: 0, claim: false, direct: false, ...(score !== undefined ? { score } : {}) };
}

function direct(reason: WakeReason): WakeDecision {
  return { wake: true, reason, delayMs: 0, claim: false, direct: true };
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

  if (isSelfMentioned(event, spec)) return direct('mentioned');
  if (context.replyToTarget?.isSelf) return direct('reply_to_you');
  if (isAimedElsewhere(event, context, spec)) return drop('aimed_elsewhere');

  if (mode === 'quiet') return drop('mode_quiet');
  if (mode === 'mention') return drop('mode_mention');
  if (input.budgetExhausted) return drop('budget');

  const partner = threadPartner(context.recentHistory, event.senderId, nowMs, THREAD_WINDOW_MS);
  let scored: { score: number; notMine?: boolean; mine?: boolean } | undefined;
  const getScore = async (): Promise<{ score: number; notMine?: boolean; mine?: boolean }> => {
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
      return { wake: true, reason: 'your_conversation', delayMs: 0, claim: true, direct: false, score };
    }
    return drop('topic_moved_on', score);
  }

  const { score, mine } = await getScore();
  // The sender talking with another agent raises the bar, so follow-ups stay in that thread. But when
  // this message is closer to this agent's asks than to the other agents' (the topic moved here, and
  // the partner drops it as `topic_moved_on`), the usual bar applies or nobody would answer.
  const inPeerThread = Boolean(partner) && !mine;
  const needed = inPeerThread ? opts.peerConversationThreshold : opts.threshold;
  if (score < needed) return drop(inPeerThread ? 'peer_conversation' : 'low_relevance', score);

  // Higher relevance goes first; a per-agent hash breaks ties so two agents never collide exactly.
  const span = Math.max(0, opts.maxDelayMs - opts.minDelayMs);
  const fit = Math.min(1, Math.max(0, (score - needed) / Math.max(0.01, 1 - needed)));
  const jitter = hashFraction(`${event.eventId}:${selfId ?? spec.id}`) * 300;
  const delayMs = Math.round(opts.minDelayMs + (1 - fit) * span + jitter);
  return { wake: true, reason: 'relevant', delayMs, claim: true, direct: false, score };
}
