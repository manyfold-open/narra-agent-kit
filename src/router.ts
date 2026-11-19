import { isNarraAgent } from './guard.js';
import { detectLang } from './lang.js';
import { shouldQuote } from './quote.js';
import type {
  AgentSpec,
  HistoryTurn,
  InboundEvent,
  LangCode,
  PeerAgentInfo,
  RoomContext,
  RoomMemberInfo,
  TriageDecision,
  TriageModel,
} from './types.js';

export const DEFAULT_SESSION_WINDOW_MS = 3 * 60_000;
export const DEFAULT_STALE_GROUP_MS = 15 * 60_000;
export const DEFAULT_SILENCE_THRESHOLD = 0.55;
export const DEFAULT_YIELD_DELAY_MS = 1_800;
export const AGENT_CHAIN_CAP = 6;
export const AGENT_CHAIN_RETRY_MS = [15_000, 45_000, 120_000] as const;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const QUESTION_OR_INTENT_RE =
  /[?？]|嗎|吗|呢|哪裡|哪里|推薦|推荐|介紹|介绍|請問|请问|有什麼|有什么|有沒有|有没有|多少|怎麼|怎么|\b(?:what|where|when|which|how|who|why|any|best|recommend|find|check|code|deals?|split|owe|news)\b/i;

/** Extracts peer `@agent-*` members from a room roster, excluding self. */
export function inspectRoomPeers(
  members: RoomMemberInfo[],
  selfMatrixId?: string,
): PeerAgentInfo[] {
  const peers: PeerAgentInfo[] = [];
  for (const m of members) {
    if (!m.matrixId || m.matrixId === selfMatrixId) continue;
    if (m.isAgent || isNarraAgent(m.matrixId)) {
      const aliases = m.displayName ? [m.displayName.trim()] : [];
      peers.push({
        matrixId: m.matrixId,
        ...(m.displayName ? { displayName: m.displayName } : {}),
        ...(aliases.length ? { aliases } : {}),
      });
    }
  }
  return peers;
}

function allNamesFor(name?: string, aliases?: string[]): string[] {
  const out = [name, ...(aliases ?? [])]
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0);
  return [...new Set(out)];
}

function nameMentionedInText(text: string, names: string[], requireAtPrefix = false): boolean {
  if (!text) return false;
  for (const rawName of names) {
    const escaped = escapeRegex(rawName);
    const prefix = requireAtPrefix ? '@' : '@?';
    const pattern = CJK_RE.test(rawName)
      ? new RegExp(`${prefix}${escaped}`, 'i')
      : new RegExp(`(?<![\\p{L}\\p{N}_])${prefix}${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
    if (pattern.test(text)) return true;
  }
  return false;
}

function textStartsWithName(text: string, names: string[], matrixId?: string): boolean {
  const trimmed = (text ?? '').trimStart();
  if (!trimmed.startsWith('@')) return false;
  if (matrixId && trimmed.toLowerCase().startsWith(matrixId.toLowerCase())) return true;
  for (const rawName of names) {
    const pattern = CJK_RE.test(rawName)
      ? new RegExp(`^@${escapeRegex(rawName)}`, 'i')
      : new RegExp(`^@${escapeRegex(rawName)}(?![\\p{L}\\p{N}_])`, 'iu');
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

export function isSelfMentioned(event: InboundEvent, spec: AgentSpec): boolean {
  if (spec.matrixId && event.mentions.includes(spec.matrixId)) return true;
  if (spec.matrixId && event.text.includes(spec.matrixId)) return true;
  return nameMentionedInText(event.text, allNamesFor(spec.name, spec.aliases), false);
}

export function findMentionedPeers(
  event: InboundEvent,
  spec: AgentSpec,
  peers: PeerAgentInfo[] = [],
): PeerAgentInfo[] {
  const found: PeerAgentInfo[] = [];
  for (const peer of peers) {
    if (peer.matrixId === spec.matrixId) continue;
    const hitById =
      event.mentions.includes(peer.matrixId) || event.text.includes(peer.matrixId);
    const peerNames = allNamesFor(peer.displayName, peer.aliases);
    const hitByName = peerNames.length > 0 && nameMentionedInText(event.text, peerNames, true);
    if (hitById || hitByName) {
      found.push(peer);
    }
  }
  return found;
}

/**
 * Determines whether a group message is `aimed_elsewhere` (talking to another user or
 * another agent rather than self). Multi-agent `@` prompts that explicitly include self
 * are NOT dropped here — they advance to Tier 1 semantic triage so the matching agent answers.
 */
export function isAimedElsewhere(
  event: InboundEvent,
  context: RoomContext,
  spec: AgentSpec,
): boolean {
  if (context.chatType === 'dm') return false;

  const selfMentioned = isSelfMentioned(event, spec);
  const peers = context.peers ?? inspectRoomPeers(context.members, spec.matrixId);
  const mentionedPeers = findMentionedPeers(event, spec, peers);

  // Explicit reply to someone else's message (human or peer agent) without mentioning self.
  if (context.replyToTarget && !context.replyToTarget.isSelf && !selfMentioned) {
    return true;
  }

  // Other Matrix IDs in m.mentions (humans or other agents) when self is NOT mentioned.
  const otherMentionIds = event.mentions.filter((id) => id !== spec.matrixId);
  if (!selfMentioned && (otherMentionIds.length > 0 || mentionedPeers.length > 0)) {
    return true;
  }

  // Leading `@Other` when self is not mentioned at all.
  const trimmed = event.text.trimStart();
  if (!selfMentioned && /^@[A-Za-z0-9._\-\u3400-\u9FFF]+/.test(trimmed)) {
    return true;
  }

  // Starts with `@Human` (non-agent) while mentioning self only later as a reference
  // (e.g., "@Alice look at what @Penny said").
  const otherHumans = otherMentionIds.filter((id) => !isNarraAgent(id));
  if (
    selfMentioned &&
    otherHumans.length > 0 &&
    mentionedPeers.length === 0 &&
    !textStartsWithName(event.text, allNamesFor(spec.name, spec.aliases), spec.matrixId)
  ) {
    return true;
  }

  return false;
}

/** Tracks active multi-turn sessions per `(roomId, userId)` for 3-minute follow-ups without re-`@`. */
export class ActiveSessionTracker {
  private readonly sessions = new Map<
    string,
    { lastAgentReplyAtMs: number; lastUserTurnAtMs: number; expiresAtMs: number }
  >();
  private readonly windowMs: number;

  constructor(windowMs = DEFAULT_SESSION_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  private key(roomId: string, userId: string): string {
    return `${roomId}::${userId}`;
  }

  recordAgentReply(roomId: string, userId: string, nowMs = Date.now()): void {
    const k = this.key(roomId, userId);
    const existing = this.sessions.get(k);
    this.sessions.set(k, {
      lastAgentReplyAtMs: nowMs,
      lastUserTurnAtMs: existing?.lastUserTurnAtMs ?? nowMs,
      expiresAtMs: nowMs + this.windowMs,
    });
  }

  recordUserTurn(roomId: string, userId: string, nowMs = Date.now()): void {
    const k = this.key(roomId, userId);
    const existing = this.sessions.get(k);
    if (!existing) return;
    this.sessions.set(k, {
      ...existing,
      lastUserTurnAtMs: nowMs,
      expiresAtMs: nowMs + this.windowMs,
    });
  }

  isActive(roomId: string, userId: string, nowMs = Date.now()): boolean {
    const s = this.sessions.get(this.key(roomId, userId));
    if (!s) return false;
    if (s.expiresAtMs < nowMs) {
      this.sessions.delete(this.key(roomId, userId));
      return false;
    }
    return true;
  }

  get(roomId: string, userId: string, nowMs = Date.now()) {
    if (!this.isActive(roomId, userId, nowMs)) return { active: false };
    const s = this.sessions.get(this.key(roomId, userId))!;
    return { active: true, ...s };
  }

  clear(roomId: string, userId?: string): void {
    if (userId) {
      this.sessions.delete(this.key(roomId, userId));
      return;
    }
    for (const key of this.sessions.keys()) {
      if (key.startsWith(`${roomId}::`)) this.sessions.delete(key);
    }
  }
}

/**
 * Tracks Synapse's `narra_agent_chain_guard` consecutive `@agent-*` message cap (6 in production)
 * and provides the `agent_chain_exhausted` retry schedule `[15_000, 45_000, 120_000]`.
 */
export class AgentChainTracker {
  private readonly counts = new Map<string, number>();
  private readonly cap: number;
  private readonly retryScheduleMs: readonly number[];

  constructor(cap = AGENT_CHAIN_CAP, retryScheduleMs: readonly number[] = AGENT_CHAIN_RETRY_MS) {
    this.cap = cap;
    this.retryScheduleMs = retryScheduleMs;
  }

  recordHuman(roomId: string): void {
    this.counts.set(roomId, 0);
  }

  recordAgent(roomId: string): number {
    const next = (this.counts.get(roomId) ?? 0) + 1;
    this.counts.set(roomId, next);
    return next;
  }

  syncFromHistory(roomId: string, history: HistoryTurn[]): number {
    let consecutive = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const turn = history[i];
      if (turn.isAgent || isNarraAgent(turn.senderId)) {
        consecutive++;
      } else {
        break;
      }
    }
    this.counts.set(roomId, consecutive);
    return consecutive;
  }

  count(roomId: string): number {
    return this.counts.get(roomId) ?? 0;
  }

  isExhausted(roomId: string): boolean {
    return this.count(roomId) >= this.cap;
  }

  /**
   * Returns retry delay in ms for attempt index (0-based, or 1-based via `attempt` >= 0):
   * attempt 0 -> 15_000, attempt 1 -> 45_000, attempt 2 -> 120_000, >= 3 -> null.
   */
  nextRetryDelayMs(failedAttempts: number): number | null {
    if (failedAttempts <= 0) return this.retryScheduleMs[0] ?? null;
    const idx = failedAttempts - 1;
    return idx < this.retryScheduleMs.length ? this.retryScheduleMs[idx] : null;
  }
}

export function isChainExhaustedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as Record<string, unknown>;
  const code = String(err.narraCode ?? err.code ?? err.errcode ?? '').toLowerCase();
  const status = Number(err.status ?? 0);
  const msg = String(err.message ?? '').toLowerCase();
  return (
    code === 'agent_chain_exhausted' ||
    code === 'matrix-membership-unverified' ||
    code === 'm_forbidden' ||
    (status === 403 && (msg.includes('chain') || msg.includes('forbidden') || msg.includes('membership')))
  );
}

/** Checks whether a peer `@agent-*` already replied after the trigger event in recent history. */
export function hasPeerRepliedAfter(
  event: InboundEvent,
  context: RoomContext,
  selfMatrixId?: string,
): boolean {
  const fromHistory = context.recentHistory.some(
    (turn) =>
      (turn.isAgent || isNarraAgent(turn.senderId)) &&
      turn.senderId !== selfMatrixId &&
      turn.timestampMs > event.timestampMs,
  );
  if (fromHistory) return true;
  if (Array.isArray(context.subsequentEvents)) {
    return context.subsequentEvents.some(
      (ev) =>
        ev.eventId !== event.eventId &&
        ev.senderId !== selfMatrixId &&
        isNarraAgent(ev.senderId),
    );
  }
  return false;
}

export interface PoliteYieldOptions {
  delayMs: number;
  checkPeerAnswered: () => Promise<boolean> | boolean;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Waits `delayMs` on unmentioned or multi-`@` turns, then yields if a peer agent
 * already answered the room so multiple bots do not pile on.
 */
export async function executePoliteYield(
  options: PoliteYieldOptions,
): Promise<{ yield: boolean; reason?: string }> {
  if (options.delayMs > 0) {
    const sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    await sleep(options.delayMs);
  }
  const answered = await options.checkPeerAnswered();
  if (answered) {
    return { yield: true, reason: 'peer_already_replied' };
  }
  return { yield: false };
}

function matchKeyword(text: string, lowerText: string, kw: string | RegExp): boolean {
  if (kw instanceof RegExp) return kw.test(text);
  const needle = kw.trim().toLowerCase();
  if (!needle) return false;
  if (CJK_RE.test(needle)) return lowerText.includes(needle);
  return new RegExp(`(?<![a-z0-9])${escapeRegex(needle)}(?![a-z0-9])`, 'i').test(text);
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'about',
  'agent',
  'help',
  'user',
  'users',
  'room',
  'narra',
]);

/**
 * Zero-LLM-key lightweight Tier 1 heuristic scorer matching `domainKeywords`,
 * `antiKeywords`, and `domainDescription` tokens against the inbound message.
 */
export function heuristicDomainScore(
  event: InboundEvent,
  spec: AgentSpec,
  _context?: RoomContext,
): number {
  const text = (event.text ?? '').trim();
  if (!text) return 0;
  const lower = text.toLowerCase();

  let antiHits = 0;
  for (const anti of spec.antiKeywords ?? []) {
    if (matchKeyword(text, lower, anti)) antiHits++;
  }

  let keywordHits = 0;
  for (const kw of spec.domainKeywords ?? []) {
    if (matchKeyword(text, lower, kw)) keywordHits++;
  }

  let descHits = 0;
  if ((spec.domainKeywords ?? []).length === 0 && spec.domainDescription) {
    const asciiWords = (spec.domainDescription.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter(
      (w) => !STOPWORDS.has(w),
    );
    const cjkBigrams: string[] = [];
    const cjkRuns = spec.domainDescription.match(/[\u3400-\u9FFF]{2,}/g) ?? [];
    for (const run of cjkRuns) {
      for (let i = 0; i < run.length - 1; i++) cjkBigrams.push(run.slice(i, i + 2));
    }
    for (const w of new Set(asciiWords)) {
      if (matchKeyword(text, lower, w)) descHits++;
    }
    for (const bg of new Set(cjkBigrams)) {
      if (text.includes(bg)) descHits++;
    }
  }

  const totalHits = keywordHits + descHits;
  if (totalHits === 0) {
    return antiHits > 0 ? 0.05 : 0.15;
  }

  let score = 0.56 + Math.min(0.32, (totalHits - 1) * 0.14);
  if (QUESTION_OR_INTENT_RE.test(text)) score += 0.08;
  if (antiHits > 0) score -= antiHits * 0.35;

  return Math.max(0, Math.min(0.99, Math.round(score * 1000) / 1000));
}

export interface RouteOptions {
  nowMs?: number;
  triageModel?: TriageModel;
  chainCap?: number;
}

/**
 * Stateless Two-Tier Decentralized Room-Aware Router:
 * - Tier 0 (~1ms, $0): drops self/agents/redactions/stale/aimed_elsewhere/muted,
 *   direct-routes DMs, explicit single `@`, replies to self, and active 3-min sessions.
 * - Tier 1: pluggable `TriageModel` or lightweight keyword/domain heuristic for
 *   unmentioned group turns and multi-`@` disambiguation.
 */
export async function routeEvent(
  event: InboundEvent,
  context: RoomContext,
  spec: AgentSpec,
  options: RouteOptions = {},
): Promise<TriageDecision> {
  const nowMs = options.nowMs ?? Date.now();
  const detectedLang: LangCode = detectLang(
    event.text,
    context.userLanguageHint,
    context.roomLanguageHint,
  );
  const quoteFlag = shouldQuote(event, {
    chatType: context.chatType,
    subsequentEvents: context.subsequentEvents,
    latestEventId: context.latestEventId,
    latestHumanEventId: context.latestHumanEventId,
  });

  // 1. Self / peer agent guard
  if (spec.matrixId && event.senderId === spec.matrixId) {
    return {
      shouldReply: false,
      tier: 0,
      reason: 'sender_is_self',
      confidence: 1,
      detectedLang,
      shouldQuote: false,
    };
  }
  if (isNarraAgent(event.senderId)) {
    return {
      shouldReply: false,
      tier: 0,
      reason: 'sender_is_agent',
      confidence: 1,
      detectedLang,
      shouldQuote: false,
    };
  }

  // 2. Redactions & irrelevant reactions
  if (event.kind === 'redaction') {
    return {
      shouldReply: false,
      tier: 0,
      reason: 'redaction',
      confidence: 1,
      detectedLang,
      shouldQuote: false,
    };
  }
  if (event.kind === 'reaction' && !context.replyToTarget?.isSelf) {
    return {
      shouldReply: false,
      tier: 0,
      reason: 'reaction_not_for_self',
      confidence: 1,
      detectedLang,
      shouldQuote: false,
    };
  }

  // 3. Stale group messages (>15 min default)
  const staleGroupMs = spec.staleGroupMs ?? DEFAULT_STALE_GROUP_MS;
  if (context.chatType === 'group' && nowMs - event.timestampMs > staleGroupMs) {
    return {
      shouldReply: false,
      tier: 0,
      reason: 'stale_group_message',
      confidence: 1,
      detectedLang,
      shouldQuote: false,
    };
  }

  // 4. 1v1 DM direct route
  if (context.chatType === 'dm') {
    return {
      shouldReply: true,
      tier: 0,
      reason: 'dm',
      confidence: 1,
      detectedLang,
      shouldQuote: false,
      directRoute: true,
    };
  }

  // 5. Aimed elsewhere (peer `@agent`, reply to another user/agent, or `@Human` first)
  if (isAimedElsewhere(event, context, spec)) {
    return {
      shouldReply: false,
      tier: 0,
      reason: 'aimed_elsewhere',
      confidence: 1,
      detectedLang,
      shouldQuote: false,
    };
  }

  const peers = context.peers ?? inspectRoomPeers(context.members, spec.matrixId);
  const selfMentioned = isSelfMentioned(event, spec);
  const mentionedPeers = findMentionedPeers(event, spec, peers);
  const isSingleExplicitMention = selfMentioned && mentionedPeers.length === 0;
  const isMultiAgentMention = selfMentioned && mentionedPeers.length > 0;

  // 6. Direct route: reply directly to self OR explicit single `@`
  if (context.replyToTarget?.isSelf && mentionedPeers.length === 0) {
    return {
      shouldReply: true,
      tier: 0,
      reason: 'reply_to_self',
      confidence: 1,
      detectedLang,
      shouldQuote: quoteFlag,
      directRoute: true,
    };
  }
  if (isSingleExplicitMention) {
    return {
      shouldReply: true,
      tier: 0,
      reason: 'explicit_mention',
      confidence: 1,
      detectedLang,
      shouldQuote: quoteFlag,
      directRoute: true,
    };
  }

  // 7. Muted room drops unmentioned, active-session, and multi-agent turns
  if (context.roomMuted) {
    return {
      shouldReply: false,
      tier: 0,
      reason: 'room_muted',
      confidence: 1,
      detectedLang,
      shouldQuote: false,
    };
  }

  // 8. Active 3-min multi-turn session (only when not multi-`@` disambiguation)
  if (!isMultiAgentMention && context.activeSession?.active) {
    const expires =
      context.activeSession.expiresAtMs ??
      (context.activeSession.lastAgentReplyAtMs !== undefined
        ? context.activeSession.lastAgentReplyAtMs + (spec.sessionWindowMs ?? DEFAULT_SESSION_WINDOW_MS)
        : Infinity);
    if (expires >= nowMs) {
      return {
        shouldReply: true,
        tier: 0,
        reason: 'active_session',
        confidence: 0.95,
        detectedLang,
        shouldQuote: quoteFlag,
        directRoute: true,
      };
    }
  }

  // 9. Peer-already-replied check before running Tier 1
  if (peers.length > 0 && hasPeerRepliedAfter(event, context, spec.matrixId)) {
    return {
      shouldReply: false,
      tier: 1,
      reason: 'peer_already_replied',
      confidence: 0.9,
      detectedLang,
      shouldQuote: false,
    };
  }

  // 10. Synapse consecutive agent chain cap check
  const chainCap = options.chainCap ?? AGENT_CHAIN_CAP;
  if ((context.consecutiveAgentMessages ?? 0) >= chainCap) {
    return {
      shouldReply: false,
      tier: 1,
      reason: 'chain_cap_exhausted',
      confidence: 1,
      detectedLang,
      shouldQuote: false,
    };
  }

  // 11. Tier 1 semantic triage (pluggable model or lightweight domain heuristic)
  const threshold = context.roomThreshold ?? spec.silenceThreshold ?? DEFAULT_SILENCE_THRESHOLD;
  let score: number;
  let triageReason: string | undefined;

  if (options.triageModel) {
    const res = await options.triageModel.score({ event, context, spec, detectedLang });
    score = Math.max(0, Math.min(1, res.score));
    triageReason = res.reason;
  } else {
    score = heuristicDomainScore(event, spec, context);
  }

  if (score >= threshold) {
    const yieldDelayMs =
      peers.length > 0 || isMultiAgentMention
        ? (spec.politeYieldDelayMs ?? DEFAULT_YIELD_DELAY_MS)
        : 0;
    return {
      shouldReply: true,
      tier: 1,
      reason:
        triageReason ??
        (isMultiAgentMention ? 'multi_mention_domain_match' : 'domain_match'),
      confidence: score,
      detectedLang,
      shouldQuote: quoteFlag,
      ...(yieldDelayMs > 0 ? { yieldDelayMs } : {}),
    };
  }

  return {
    shouldReply: false,
    tier: 1,
    reason:
      triageReason ??
      (isMultiAgentMention ? 'multi_mention_other_domain' : 'below_threshold'),
    confidence: score,
    detectedLang,
    shouldQuote: false,
  };
}

export interface RoomRouterConfig {
  spec: AgentSpec;
  triageModel?: TriageModel;
  chainCap?: number;
  now?: () => number;
}

/**
 * Stateful convenience wrapper managing `ActiveSessionTracker` and `AgentChainTracker`
 * across turns in a Worker or Durable Object.
 */
export class RoomRouter {
  readonly spec: AgentSpec;
  readonly sessions: ActiveSessionTracker;
  readonly chain: AgentChainTracker;
  private readonly triageModel?: TriageModel;
  private readonly chainCap: number;
  private readonly now: () => number;

  constructor(config: RoomRouterConfig) {
    this.spec = config.spec;
    this.sessions = new ActiveSessionTracker(config.spec.sessionWindowMs ?? DEFAULT_SESSION_WINDOW_MS);
    this.chain = new AgentChainTracker(config.chainCap ?? AGENT_CHAIN_CAP);
    this.triageModel = config.triageModel;
    this.chainCap = config.chainCap ?? AGENT_CHAIN_CAP;
    this.now = config.now ?? (() => Date.now());
  }

  async route(event: InboundEvent, context: RoomContext): Promise<TriageDecision> {
    const nowMs = this.now();
    if (!isNarraAgent(event.senderId) && event.kind !== 'reaction' && event.kind !== 'redaction') {
      this.chain.recordHuman(event.roomId);
    } else if (isNarraAgent(event.senderId)) {
      this.chain.recordAgent(event.roomId);
    }

    const activeSession =
      context.activeSession ?? this.sessions.get(event.roomId, event.senderId, nowMs);
    const consecutiveAgentMessages =
      context.consecutiveAgentMessages ?? this.chain.count(event.roomId);

    const decision = await routeEvent(
      event,
      {
        ...context,
        activeSession,
        consecutiveAgentMessages,
      },
      this.spec,
      {
        nowMs,
        triageModel: this.triageModel,
        chainCap: this.chainCap,
      },
    );

    if (decision.shouldReply && event.chatType === 'group') {
      this.sessions.recordUserTurn(event.roomId, event.senderId, nowMs);
    }
    return decision;
  }

  markAgentReplied(roomId: string, userId?: string, nowMs = this.now()): void {
    this.chain.recordAgent(roomId);
    if (userId) {
      this.sessions.recordAgentReply(roomId, userId, nowMs);
    }
  }
}
