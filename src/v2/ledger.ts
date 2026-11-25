/**
 * Room ledger for the chat-native (v2) pipeline: what an agent needs to know about a room to act like
 * a member of it. Everything here is derived from Matrix events this agent already receives, so each
 * agent keeps its own copy and no central coordinator is needed.
 */
import { isNarraAgent } from '../guard.js';
import type { HistoryTurn, InboundEvent, RoomMemberInfo } from '../types.js';

/** How often the agent speaks in this room. */
export type ReplyMode = 'ambient' | 'mention' | 'quiet';

export const REPLY_MODES: readonly ReplyMode[] = ['ambient', 'mention', 'quiet'];

/** Reaction an agent puts on a message it is about to answer ("I've got this"). */
export const CLAIM_REACTION = '👀';

/** A claim older than this no longer blocks other agents (the claimer crashed or went silent). */
export const CLAIM_TTL_MS = 90_000;

/** An agent that answered a person within this window is "in a conversation" with them. */
export const THREAD_WINDOW_MS = 3 * 60_000;

/** Human messages younger than this with no agent answer count as unanswered. */
export const OPEN_ASK_WINDOW_MS = 15 * 60_000;

export interface ClaimRecord {
  agentId: string;
  atMs: number;
  reactionEventId?: string;
}

export interface V2RoomState {
  mode?: ReplyMode;
  /** target event id -> who claimed it */
  claims: Record<string, ClaimRecord>;
  /** claim reaction event id -> target event id (so a redaction releases the claim) */
  claimReactions: Record<string, string>;
}

export function emptyRoomState(): V2RoomState {
  return { claims: {}, claimReactions: {} };
}

/** Records an agent's 👀 reaction as a claim on the message it reacts to. */
export function applyClaimReaction(state: V2RoomState, ev: InboundEvent, selfId: string | undefined): boolean {
  if (ev.kind !== 'reaction' || ev.reactionKey !== CLAIM_REACTION || !ev.replyToEventId) return false;
  const fromAgent = ev.senderId === selfId || isNarraAgent(ev.senderId);
  if (!fromAgent) return false;
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
export function applyClaimRedaction(state: V2RoomState, redactedEventId: string): boolean {
  const target = state.claimReactions[redactedEventId];
  if (!target) return false;
  delete state.claimReactions[redactedEventId];
  if (state.claims[target]?.reactionEventId === redactedEventId) delete state.claims[target];
  return true;
}

export function pruneClaims(state: V2RoomState, nowMs: number, keepMs = 30 * 60_000): void {
  for (const [target, claim] of Object.entries(state.claims)) {
    if (nowMs - claim.atMs > keepMs) {
      delete state.claims[target];
      if (claim.reactionEventId) delete state.claimReactions[claim.reactionEventId];
    }
  }
  const live = new Set(Object.values(state.claims).map((c) => c.reactionEventId));
  for (const reactionId of Object.keys(state.claimReactions)) {
    if (!live.has(reactionId)) delete state.claimReactions[reactionId];
  }
}

/** Another agent holding a live claim on any of these events, if one does. */
export function peerClaimHolder(
  state: V2RoomState,
  eventIds: string[],
  selfId: string | undefined,
  nowMs: number,
): string | undefined {
  for (const id of eventIds) {
    const claim = state.claims[id];
    if (claim && claim.agentId !== selfId && nowMs - claim.atMs <= CLAIM_TTL_MS) return claim.agentId;
  }
  return undefined;
}

function isAgentTurn(turn: HistoryTurn): boolean {
  return turn.isAgent || isNarraAgent(turn.senderId);
}

/** The agent turn that answers `target`, judged by the hidden answer marker or a quote. */
function answers(turn: HistoryTurn, targetId: string): boolean {
  return turn.answersEventId === targetId || turn.replyToEventId === targetId;
}

/**
 * The agent currently in a conversation with `senderId`: the last agent that answered one of their
 * messages within `windowMs`. Undefined when nobody is.
 */
export function threadPartner(
  history: HistoryTurn[],
  senderId: string,
  nowMs: number,
  windowMs = THREAD_WINDOW_MS,
): string | undefined {
  const senderMessageIds = new Set(history.filter((t) => t.senderId === senderId).map((t) => t.eventId));
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (nowMs - turn.timestampMs > windowMs) break;
    if (!isAgentTurn(turn) || turn.isBroadcast) continue;
    const target = turn.answersEventId ?? turn.replyToEventId;
    if (target && senderMessageIds.has(target)) return turn.senderId;
  }
  return undefined;
}

/** Recent human messages no agent has answered yet (oldest first). */
export function unansweredHumanMessages(
  history: HistoryTurn[],
  nowMs: number,
  windowMs = OPEN_ASK_WINDOW_MS,
): HistoryTurn[] {
  const answered = new Set<string>();
  for (const turn of history) {
    if (!isAgentTurn(turn) || turn.isBroadcast) continue;
    const target = turn.answersEventId ?? turn.replyToEventId;
    if (target) answered.add(target);
  }
  return history.filter(
    (t) => !isAgentTurn(t) && nowMs - t.timestampMs <= windowMs && t.text.trim() && !answered.has(t.eventId),
  );
}

/** Whether any agent other than `selfId` answered one of `eventIds`. */
export function peerAnswered(history: HistoryTurn[], eventIds: string[], selfId: string | undefined): string | undefined {
  for (const turn of history) {
    if (!isAgentTurn(turn) || turn.senderId === selfId || turn.isBroadcast) continue;
    if (eventIds.some((id) => answers(turn, id))) return turn.senderId;
  }
  return undefined;
}

/** Number of scheduled posts (`ai.narra.broadcast`) any agent made in this room since `sinceMs`. */
export function broadcastsSince(history: HistoryTurn[], sinceMs: number): number {
  return history.filter((t) => t.isBroadcast && t.timestampMs >= sinceMs).length;
}

function nameOf(id: string, members: RoomMemberInfo[], history: HistoryTurn[]): string {
  const member = members.find((m) => m.matrixId === id);
  if (member?.displayName) return member.displayName;
  const turn = history.find((t) => t.senderId === id && t.senderName);
  return turn?.senderName ?? id;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface LedgerSummaryInput {
  history: HistoryTurn[];
  members: RoomMemberInfo[];
  selfId: string | undefined;
  event: InboundEvent;
  nowMs: number;
  mode: ReplyMode;
  wakeReason: string;
}

/**
 * Compact, model-facing description of the room's state. Kept short on purpose: it rides on every
 * Manyfold call, so every line must change what a good group member would say.
 */
export function buildLedgerSummary(input: LedgerSummaryInput): Record<string, string> {
  const { history, members, selfId, event, nowMs } = input;
  const fields: Record<string, string> = {
    reply_mode: input.mode,
    why_you_were_woken: input.wakeReason,
  };

  const partner = threadPartner(history, event.senderId, nowMs);
  if (partner && partner !== selfId) {
    fields.sender_is_talking_with = `${nameOf(event.senderId, members, history)} is in a conversation with ${nameOf(partner, members, history)} (another agent).`;
  } else if (partner === selfId) {
    fields.sender_is_talking_with = `${nameOf(event.senderId, members, history)} is in a conversation with you.`;
  }

  const open = unansweredHumanMessages(history, nowMs).filter((t) => t.eventId !== event.eventId).slice(-4);
  if (open.length > 0) {
    fields.other_unanswered_messages = open
      .map((t) => `- ${nameOf(t.senderId, members, history)}: ${clip(t.text, 120)}`)
      .join('\n');
  }

  const mine = history.filter((t) => t.senderId === selfId && !t.isBroadcast).slice(-5);
  if (mine.length > 0) {
    fields.your_recent_messages_here = mine.map((t) => `- ${clip(t.text, 200)}`).join('\n');
  }
  return fields;
}
