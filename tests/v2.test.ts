import { describe, expect, it, vi } from 'vitest';
import {
  CLAIM_REACTION,
  UsageBudget,
  asksSomething,
  chatBehaviourNote,
  claimPriority,
  continuousStreamText,
  newStreamContinuity,
  sanitizeMobileLinks,
  toZhHant,
  NARRA_USAGE_SCHEMA,
  applyClaimReaction,
  applyClaimRedaction,
  buildLedgerSummary,
  createNarraWorkerGateway,
  kickNarraGateway,
  decideWake,
  emptyRoomState,
  parseBrainOutput,
  peerClaimHolder,
  shouldFlushStream,
  streamableText,
  replyLanguageFor,
  matchScript,
  toZhHans,
  pipelineForRoom,
  roomPostingBlock,
  runSchemaStatements,
  scoreRelevance,
  threadPartner,
  unansweredHumanMessages,
  DEFAULT_ROOM_POSTING_RULES,
  type AgentSpec,
  type HistoryTurn,
  type InboundEvent,
  type NarraGatewayConfig,
  type NarraGatewayEnv,
  type RoomContext,
} from '../src/index.js';
import { createD1 } from './d1.js';

const NOW = 1_795_600_000_000; // 2026-11-25, around 11:46 London
const ZACK = '@sp-zack:matrix.netmind.chat';
const CASSIE = '@sp-cassie:matrix.netmind.chat';
const NEWS = '@agent-3add8bb6:matrix.netmind.chat';
const SPOTTED = '@agent-f9388b28:matrix.netmind.chat';

const NEWS_SPEC: AgentSpec = {
  id: 'agt_news',
  matrixId: NEWS,
  name: 'AI in 5',
  domainDescription: 'Daily AI news digest: model releases, AI companies, research headlines',
  domainKeywords: ['AI', 'news', '新聞'],
  antiKeywords: [],
};

const ev = (eventId: string, text: string, ts = NOW, extra: Partial<InboundEvent> = {}): InboundEvent => ({
  roomId: '!g:x',
  chatType: 'group',
  eventId,
  senderId: ZACK,
  type: 'm.room.message',
  kind: 'text',
  msgtype: 'm.text',
  timestampMs: ts,
  timeIso: new Date(ts).toISOString(),
  mentions: [],
  text,
  ...extra,
});

const ctx = (extra: Partial<RoomContext> = {}): RoomContext => ({
  roomId: '!g:x',
  chatType: 'group',
  members: [
    { matrixId: ZACK, displayName: 'Zack', isAgent: false },
    { matrixId: CASSIE, displayName: 'Cassie', isAgent: false },
    { matrixId: NEWS, displayName: 'AI in 5', isAgent: true },
    { matrixId: SPOTTED, displayName: 'Spotted London', isAgent: true },
  ],
  peers: [{ matrixId: SPOTTED, displayName: 'Spotted London' }],
  recentHistory: [],
  consecutiveAgentMessages: 0,
  ...extra,
});

const turn = (eventId: string, senderId: string, ts: number, extra: Partial<HistoryTurn> = {}): HistoryTurn => ({
  eventId,
  senderId,
  isAgent: senderId.startsWith('@agent-'),
  text: extra.text ?? 'x',
  timestampMs: ts,
  ...extra,
});

describe('v2 brain output', () => {
  it('reads silence, reactions, mode changes and plain replies', () => {
    expect(parseBrainOutput('[NO_REPLY]')).toEqual({ kind: 'silent' });
    expect(parseBrainOutput('')).toEqual({ kind: 'silent' });
    expect(parseBrainOutput('[REACT ❤️]')).toEqual({ kind: 'react', emoji: '❤️' });
    expect(parseBrainOutput('[REACT: 👍]')).toEqual({ kind: 'react', emoji: '👍' });
    expect(parseBrainOutput('[MODE mention]\n好，之後你們 @ 我我才回。')).toEqual({
      kind: 'reply',
      text: '好，之後你們 @ 我我才回。',
      mode: 'mention',
    });
    expect(parseBrainOutput('今天三則 AI 新聞：…')).toEqual({ kind: 'reply', text: '今天三則 AI 新聞：…' });
    // A reaction with text: the text wins; an unknown emoji is never sent.
    expect(parseBrainOutput('[REACT ❤️]\n不客氣！')).toEqual({ kind: 'reply', text: '不客氣！' });
    expect(parseBrainOutput('[REACT 🦄]')).toEqual({ kind: 'silent' });
  });
});

describe('v2 reply language', () => {
  it('answers zh-Hant in zh-Hant, zh-Hans in zh-Hans, English in English, anything else in English', () => {
    expect(replyLanguageFor('今天有什麼 AI 新聞？')).toBe('zh-Hant');
    expect(replyLanguageFor('今天有什么 AI 新闻？')).toBe('zh-Hans');
    expect(replyLanguageFor('any AI news today?')).toBe('en');
    expect(replyLanguageFor('今日のAIニュースは？')).toBe('en');
    expect(replyLanguageFor('¿Qué noticias de IA hay hoy para nosotros?')).toBe('en');
    expect(replyLanguageFor('오늘 AI 뉴스 있어?')).toBe('en');
    // The agent's own name does not decide the language.
    expect(replyLanguageFor('@AI in 5 有啥新聞', { mentionNames: ['AI in 5'] })).toBe('zh-Hant');
  });

  it('puts Chinese replies into the asker\'s script', () => {
    expect(toZhHans('今天還是第 39 期，三條要聞')).toBe('今天还是第 39 期，三条要闻');
    expect(matchScript('三条要闻', 'zh-Hant')).toBe('三條要聞');
    expect(matchScript('三條要聞', 'zh-Hans')).toBe('三条要闻');
    expect(matchScript('Three stories', 'en')).toBe('Three stories');
    expect(matchScript('FCC 批准 SpaceX 的计划，标准和准备都很准确', 'zh-Hant')).toBe('FCC 批准 SpaceX 的計劃，標準和準備都很準確');
    expect(matchScript('FCC 批准 SpaceX 的計劃', 'zh-Hant')).toBe('FCC 批准 SpaceX 的計劃');
  });
});

describe('v2 streaming', () => {
  it('shows reply text only once it is safe', () => {
    expect(streamableText('[NO_REP')).toBeNull();
    expect(streamableText('[NO_REPLY]')).toBeNull();
    expect(streamableText('[REACT ❤️]')).toBeNull();
    expect(streamableText('[MODE mention]\n好')).toBeNull();
    expect(streamableText('Thought: the user wants')).toBeNull();
    expect(streamableText('今天三則：OpenAI')).toBe('今天三則：OpenAI');
  });

  it('posts after a first sentence, then edits sparingly', () => {
    expect(shouldFlushStream({ shown: '', next: '今天', msSinceLastFlush: 0 })).toBe(false);
    expect(shouldFlushStream({ shown: '', next: 'Group and members exist. Add the entry.', msSinceLastFlush: 0 })).toBe(false);
    expect(shouldFlushStream({ shown: '', next: '今天有三則 AI 新聞值得看：OpenAI 發新模型，Google DeepMind 推出可靠性基準測試，百度開源 ERNIE 5.5', msSinceLastFlush: 0 })).toBe(true);
    const shown = '今天有三則 AI 新聞值得看：OpenAI 發新模型，Google DeepMind 推出可靠性基準測試，百度開源 ERNIE 5.5';
    expect(shouldFlushStream({ shown, next: shown + '，Google 也有', msSinceLastFlush: 5_000 })).toBe(false);
    expect(shouldFlushStream({ shown, next: shown + '，Google DeepMind 推出新的可靠性基準測試，百度開源 ERNIE', msSinceLastFlush: 500 })).toBe(false);
    expect(shouldFlushStream({ shown, next: shown + '，Google DeepMind 推出新的可靠性基準測試，百度開源 ERNIE', msSinceLastFlush: 2_000 })).toBe(true);
  });
});

describe('v2 wake gate', () => {
  const never = async () => {
    throw new Error('must not score');
  };

  it('always wakes for DMs, mentions and replies to itself, without scoring', async () => {
    const dm = await decideWake({ event: ev('$1', 'hi', NOW, { chatType: 'dm' }), context: ctx({ chatType: 'dm' }), spec: NEWS_SPEC, mode: 'quiet', nowMs: NOW, score: never });
    expect(dm).toMatchObject({ wake: true, reason: 'dm', direct: true, delayMs: 0, claim: false });
    const mention = await decideWake({ event: ev('$2', '@AI in 5 今天有什麼', NOW, { mentions: [NEWS] }), context: ctx(), spec: NEWS_SPEC, mode: 'mention', nowMs: NOW, score: never });
    // An @mention in a group shows the 👀 at once (people see it was picked up while the brain works).
    expect(mention).toMatchObject({ wake: true, reason: 'mentioned', direct: true, claim: true });
    const reply = await decideWake({
      event: ev('$3', '第二則呢', NOW, { replyToEventId: '$mine' }),
      context: ctx({ replyToTarget: { eventId: '$mine', senderId: NEWS, isSelf: true, isAgent: true, text: '…' } }),
      spec: NEWS_SPEC,
      mode: 'mention',
      nowMs: NOW,
      score: never,
    });
    expect(reply).toMatchObject({ wake: true, reason: 'reply_to_you', direct: true });
  });

  it('stays out of messages aimed at someone else, reactions, and other agents', async () => {
    const aimed = await decideWake({ event: ev('$1', '@Spotted London 週末去哪', NOW, { mentions: [SPOTTED] }), context: ctx(), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: never });
    expect(aimed).toMatchObject({ wake: false, reason: 'aimed_elsewhere' });
    const reaction = await decideWake({ event: ev('$r', '😂', NOW, { kind: 'reaction', reactionKey: '😂', replyToEventId: '$x' }), context: ctx(), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: never });
    expect(reaction).toMatchObject({ wake: false, reason: 'not_text' });
    const peer = await decideWake({ event: ev('$p', '這週末有這些活動', NOW, { senderId: SPOTTED }), context: ctx(), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: never });
    expect(peer).toMatchObject({ wake: false, reason: 'from_agent' });
  });

  it('a peer handing the question over by name wakes the agent', async () => {
    const handoff = await decideWake({ event: ev('$h', '這個 @AI in 5 比較熟', NOW, { senderId: SPOTTED }), context: ctx(), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: never });
    expect(handoff).toMatchObject({ wake: true, reason: 'handoff', claim: true });
  });

  it('respects the room mode and the agent tail cap for unaddressed messages', async () => {
    const q = ev('$q', '有啥新聞嗎今天');
    expect(await decideWake({ event: q, context: ctx(), spec: NEWS_SPEC, mode: 'mention', nowMs: NOW, score: never })).toMatchObject({ wake: false, reason: 'mode_mention' });
    expect(await decideWake({ event: q, context: ctx(), spec: NEWS_SPEC, mode: 'quiet', nowMs: NOW, score: never })).toMatchObject({ wake: false, reason: 'mode_quiet' });
    expect(await decideWake({ event: q, context: ctx({ consecutiveAgentMessages: 5 }), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: never })).toMatchObject({ wake: false, reason: 'agent_tail_cap' });
    expect(await decideWake({ event: q, context: ctx(), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, budgetExhausted: true, score: never })).toMatchObject({ wake: false, reason: 'budget' });
  });

  it('continues its own conversation with the sender without scoring', async () => {
    const history = [turn('$a', ZACK, NOW - 60_000), turn('$b', NEWS, NOW - 50_000, { answersEventId: '$a' })];
    const d = await decideWake({ event: ev('$c', '第二則是哪家公司'), context: ctx({ recentHistory: history }), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => 0.3 });
    expect(d).toMatchObject({ wake: true, reason: 'your_conversation', delayMs: 0, claim: true, direct: false });
  });

  it('lets a conversation move on to another agent\'s topic (晚餐吃啥好 after talking with the events agent)', async () => {
    const history = [turn('$a', ZACK, NOW - 60_000), turn('$b', NEWS, NOW - 50_000, { answersEventId: '$a' })];
    const moved = await decideWake({ event: ev('$c', '晚餐吃啥好'), context: ctx({ recentHistory: history }), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => ({ score: 0, notMine: true }) });
    expect(moved).toMatchObject({ wake: false, reason: 'topic_moved_on' });
    // A short follow-up that just looks unrelated still stays with the agent.
    const follow = await decideWake({ event: ev('$d', 'Holborn'), context: ctx({ recentHistory: history }), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => ({ score: 0.1 }) });
    expect(follow).toMatchObject({ wake: true, reason: 'your_conversation' });
  });

  it('wakes on relevance, sooner when more relevant, and asks more when the sender talks with another agent', async () => {
    const q = ev('$q', '有啥新聞嗎今天');
    const low = await decideWake({ event: q, context: ctx(), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => 0.2 });
    expect(low).toMatchObject({ wake: false, reason: 'low_relevance', score: 0.2 });
    const high = await decideWake({ event: q, context: ctx(), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => 0.95 });
    const mid = await decideWake({ event: q, context: ctx(), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => 0.6 });
    expect(high.wake && mid.wake).toBe(true);
    expect(high.delayMs).toBeLessThan(mid.delayMs);
    const history = [turn('$a', ZACK, NOW - 30_000), turn('$b', SPOTTED, NOW - 20_000, { answersEventId: '$a' })];
    const withPeer = await decideWake({ event: q, context: ctx({ recentHistory: history }), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => 0.6 });
    // Under the bar in someone else's thread: stays out of it (nobody stands in).
    expect(withPeer).toMatchObject({ wake: false, reason: 'peer_conversation' });
  });

  it('picks up a topic that moved to it while the sender talks with another agent (那晚上有啥可以玩的嗎 after food)', async () => {
    const history = [turn('$a', ZACK, NOW - 60_000), turn('$b', SPOTTED, NOW - 50_000, { answersEventId: '$a' })];
    const q = ev('$q', '那今天有什麼 AI 新聞');
    // Closer to this agent's asks than to the other agents': the normal threshold applies.
    const moved = await decideWake({ event: q, context: ctx({ recentHistory: history }), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => ({ score: 0.55, mine: true }) });
    expect(moved).toMatchObject({ wake: true, reason: 'relevant', claim: true });
    // Still below the normal threshold: silent.
    const weak = await decideWake({ event: q, context: ctx({ recentHistory: history }), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => ({ score: 0.4, mine: true }) });
    expect(weak).toMatchObject({ wake: false, reason: 'low_relevance' });
    // Not clearly this agent's: the peer-thread bar stays, so it stays out.
    const unclear = await decideWake({ event: q, context: ctx({ recentHistory: history }), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => ({ score: 0.55 }) });
    expect(unclear).toMatchObject({ wake: false, reason: 'peer_conversation' });
  });
});

describe('v2 room ledger', () => {
  it('tracks 👀 claims from agents and releases them on redaction', () => {
    const state = emptyRoomState();
    const claim = ev('$claim', CLAIM_REACTION, NOW, { kind: 'reaction', reactionKey: CLAIM_REACTION, replyToEventId: '$q', senderId: SPOTTED });
    expect(applyClaimReaction(state, claim, NEWS)).toBe(true);
    expect(peerClaimHolder(state, ['$q'], NEWS, NOW + 1_000)).toBe(SPOTTED);
    expect(peerClaimHolder(state, ['$q'], SPOTTED, NOW + 1_000)).toBeUndefined();
    expect(peerClaimHolder(state, ['$q'], NEWS, NOW + 120_000)).toBeUndefined(); // stale claim
    // A human's 👀 is not a claim.
    expect(applyClaimReaction(state, { ...claim, eventId: '$h', senderId: ZACK, replyToEventId: '$q2' }, NEWS)).toBe(false);
    expect(applyClaimRedaction(state, '$claim')).toBe(true);
    expect(peerClaimHolder(state, ['$q'], NEWS, NOW + 1_000)).toBeUndefined();
  });

  it('knows who is talking with whom and which messages nobody answered', () => {
    const history = [
      turn('$w', ZACK, NOW - 90_000, { text: '週末能幹嘛' }),
      turn('$n', ZACK, NOW - 85_000, { text: '有啥新聞嗎今天' }),
      turn('$s', SPOTTED, NOW - 80_000, { answersEventId: '$w', text: '這週末有…' }),
      turn('$d', NEWS, NOW - 70_000, { isBroadcast: true, text: 'AI in 5 No. 39' }),
      turn('$c', CASSIE, NOW - 10_000, { text: '哈哈' }),
    ];
    expect(threadPartner(history, ZACK, NOW)).toBe(SPOTTED);
    expect(threadPartner(history, CASSIE, NOW)).toBeUndefined();
    // The unquoted answer to "週末能幹嘛" does not answer the news question; a digest never answers anything.
    expect(unansweredHumanMessages(history, NOW).map((t) => t.eventId)).toEqual(['$n', '$c']);
  });

  it('summarises the room for the brain, including what this agent already said', () => {
    const history = [
      turn('$n', ZACK, NOW - 85_000, { text: '有啥新聞嗎今天' }),
      turn('$mine', NEWS, NOW - 80_000, { answersEventId: '$n', text: '今天：OpenAI 發新模型、Google…' }),
    ];
    const summary = buildLedgerSummary({ history, members: ctx().members, selfId: NEWS, event: ev('$q', '第二則呢'), nowMs: NOW, mode: 'ambient', wakeReason: 'your_conversation' });
    expect(summary.reply_mode).toBe('ambient');
    expect(summary.sender_is_talking_with).toContain('with you');
    expect(summary.your_recent_messages_here).toContain('OpenAI');
    expect(summary.conversation_so_far).toMatch(/Zack: 有啥新聞嗎今天\n- \[1m ago\] you: 今天/);
  });

  it('lists earlier unanswered messages as background only', () => {
    const history = [turn('$old', CASSIE, NOW - 60_000, { text: '最近有啥AI新聞嗎' })];
    const summary = buildLedgerSummary({ history, members: ctx().members, selfId: NEWS, event: ev('$q', '@AI in 5 之後你可以主動回了'), nowMs: NOW, mode: 'mention', wakeReason: 'mentioned' });
    expect(summary.earlier_unanswered_messages).toContain('最近有啥AI新聞嗎');
    expect(summary.other_unanswered_messages).toBeUndefined();
  });
});

describe('v2 relevance scoring', () => {
  const fakeAi = () => {
    const calls: string[][] = [];
    return {
      calls,
      run: async (_model: string, input: { text: string[] }) => {
        calls.push(input.text);
        return { data: input.text.map((t) => (/AI|新聞|news|model/i.test(t) ? [1, 0.1] : [0.1, 1])) };
      },
    };
  };

  it('embeds the profile once, then only the message', async () => {
    const ai = fakeAi();
    const store = new Map<string, number[][]>();
    const cache = { get: async (k: string) => store.get(k), put: async (k: string, v: number[][]) => void store.set(k, v) };
    const fb = { event: ev('$q', 'x'), context: ctx() };
    const first = await scoreRelevance('有啥新聞嗎今天', NEWS_SPEC, ['any AI news today?'], { ai, cache }, fb);
    expect(first.source).toBe('embedding');
    expect(first.score).toBe(1);
    const second = await scoreRelevance('哈哈哈', NEWS_SPEC, ['any AI news today?'], { ai, cache }, fb);
    expect(second.score).toBe(0);
    expect(ai.calls[0]).toHaveLength(3); // description + example + message
    expect(ai.calls[1]).toEqual(['哈哈哈']);
  });

  it('uses a v2-only profile and drops messages that belong to other agents', async () => {
    const ai = {
      run: async (_m: string, input: { text: string[] }) => ({
        data: input.text.map((t) => (/新聞|news/i.test(t) ? [1, 0, 0] : /融資|funding|AI/i.test(t) ? [0.8, 0.6, 0] : [0, 0, 1])),
      }),
    };
    const spec = { ...NEWS_SPEC, domainDescription: 'unrelated v1 text' };
    const fb = { event: ev('$q', 'x'), context: ctx() };
    // Datasets agent: its profile is about AI funding, AI news belongs to another agent.
    const own = await scoreRelevance('哪些 AI 公司拿到融資', spec, [], { ai, profile: 'AI funding rounds', notExamples: ['今天有什麼 AI 新聞'] }, fb);
    expect(own.score).toBe(1);
    const news = await scoreRelevance('最近有啥 AI 新聞嗎', spec, [], { ai, profile: 'AI funding rounds', notExamples: ['今天有什麼 AI 新聞'] }, fb);
    expect(news.score).toBe(0);
    expect(news.notCosine).toBe(1);
  });

  it('falls back to the keyword heuristic without Workers AI', async () => {
    const r = await scoreRelevance('AI news?', NEWS_SPEC, [], { ai: undefined }, { event: ev('$q', 'AI news?'), context: ctx() });
    expect(r.source).toBe('heuristic');
  });
});

describe('room posting manners and pipeline switch', () => {
  const rules = DEFAULT_ROOM_POSTING_RULES;
  const noon = Date.UTC(2026, 10, 25, 12, 0, 0); // 12:00 London (GMT in November)

  it('caps scheduled posts per room per day across agents, waits for quiet, and posts in daytime only', () => {
    const posts = [1, 2, 3].map((i) => turn(`$b${i}`, i === 2 ? SPOTTED : NEWS, noon - i * 3_600_000, { isBroadcast: true }));
    expect(roomPostingBlock(posts, noon, rules)).toBe('room_daily_cap');
    expect(roomPostingBlock(posts.slice(0, 2), noon, rules)).toBeNull();
    expect(roomPostingBlock([turn('$h', ZACK, noon - 60_000)], noon, rules)).toBe('room_busy');
    expect(roomPostingBlock([], Date.UTC(2026, 10, 25, 22, 0, 0), rules)).toBe('outside_hours');
    // Yesterday's posts do not count.
    expect(roomPostingBlock([1, 2, 3].map((i) => turn(`$y${i}`, NEWS, noon - 13 * 3_600_000 - i, { isBroadcast: true })), noon, rules)).toBeNull();
  });

  it('runs v2 only where asked', () => {
    expect(pipelineForRoom({}, '!a')).toBe('v1');
    expect(pipelineForRoom({ NARRA_PIPELINE: 'v2' }, '!a')).toBe('v2');
    expect(pipelineForRoom({ NARRA_PIPELINE: 'v2', NARRA_PIPELINE_ROOMS: '!test' }, '!a')).toBe('v1');
    expect(pipelineForRoom({ NARRA_PIPELINE: 'shadow', NARRA_PIPELINE_ROOMS: '!test, !b' }, '!b')).toBe('shadow');
  });

  it('counts daily usage per agent in D1', async () => {
    const db = createD1();
    await runSchemaStatements(db, NARRA_USAGE_SCHEMA);
    const budget = new UsageBudget(db as never, 'agt_news');
    await budget.add('relevance', NOW);
    await budget.add('relevance', NOW, 2);
    expect(await budget.used('relevance', NOW)).toBe(3);
    expect(await budget.relevanceExhausted(NOW, 3)).toBe(true);
    expect(await budget.relevanceExhausted(NOW + 86_400_000, 3)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------
// End to end through the room Durable Object, with fake Matrix, Workers AI and Manyfold.
// ------------------------------------------------------------------------------------------------

class FakeDOStorage {
  readonly data = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async list<T>(): Promise<Map<string, T>> {
    return new Map();
  }
  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }
  async setAlarm(t: number | Date): Promise<void> {
    this.alarmAt = typeof t === 'number' ? t : t.getTime();
  }
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

function fakeNamespace<T extends { fetch(r: Request): Promise<Response> }>(factory: (s: DurableObjectState) => T) {
  const instances = new Map<string, { instance: T; storage: FakeDOStorage }>();
  const ensure = (name: string) => {
    let hit = instances.get(name);
    if (!hit) {
      const storage = new FakeDOStorage();
      const state = {
        storage,
        id: { toString: () => name },
        waitUntil: () => undefined,
        blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(),
      } as unknown as DurableObjectState;
      hit = { instance: factory(state), storage };
      instances.set(name, hit);
    }
    return hit;
  };
  const namespace = {
    idFromName: (name: string) => ({ name, toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        ensure(String((id as unknown as { name: string }).name)).instance.fetch(
          input instanceof Request ? input : new Request(String(input), init),
        ),
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, instances, ensure };
}

function sse(text: string): Response {
  const body = `data: ${JSON.stringify({ jsonrpc: '2.0', id: '1', result: { kind: 'status-update', status: { state: 'completed', message: { role: 'agent', parts: [{ kind: 'text', text }] } } } })}\n\n`;
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

const ROOM = '!zacktest:matrix.netmind.chat';

function setup(
  brainReply: string | (() => string | Response | Promise<string | Response>),
  extraConfig: Partial<NarraGatewayConfig<NarraGatewayEnv>> = {},
  extraEnv: Partial<NarraGatewayEnv> = {},
) {
  let nowMs = Date.UTC(2026, 10, 25, 12, 0, 0);
  const sent: Array<{ type: string; body: Record<string, unknown> }> = [];
  const redactions: string[] = [];
  const envelopes: string[] = [];
  const rawRequests: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/api/agent-runtime/matrix-credential')) {
      return Response.json({ status: 'ok', data: { homeserver_url: 'https://matrix.netmind.chat', matrix_user_id: NEWS, access_token: 'syt_test' } });
    }
    if (url.includes('/typing/') || url.includes('/receipt/')) return Response.json({});
    if (url.includes('/redact/')) {
      redactions.push(decodeURIComponent(url.split('/redact/')[1].split('/')[0]));
      return Response.json({ event_id: `$redaction_${redactions.length}` });
    }
    const send = /\/send\/([^/]+)\//.exec(url);
    if (send) {
      sent.push({ type: send[1], body: JSON.parse(String(init?.body ?? '{}')) });
      return Response.json({ event_id: `$out_${sent.length}` });
    }
    if (url === 'https://a2a.test/rpc') {
      const req = JSON.parse(String(init?.body ?? '{}')) as { params: { message: { parts: Array<{ text: string }> } } };
      envelopes.push(req.params.message.parts[0].text);
      rawRequests.push(String(init?.body ?? ''));
      const reply = typeof brainReply === 'function' ? await brainReply() : brainReply;
      return reply instanceof Response ? reply : sse(reply);
    }
    return new Response('not found', { status: 404 });
  });
  const ai = {
    run: async (_m: string, input: { text: string[] }) => ({
      data: input.text.map((t) => (/AI|新聞|news/i.test(t) ? [1, 0.05] : [0.05, 1])),
    }),
  };
  const config: NarraGatewayConfig<NarraGatewayEnv> = {
    spec: NEWS_SPEC,
    fetchImpl: fetchMock as unknown as typeof fetch,
    now: () => nowMs,
    sleep: async () => undefined,
    resolveA2ACredential: async () => ({ url: 'https://a2a.test/rpc', token: 'tok' }),
    enableA2AFailureReply: true,
    ...extraConfig,
  };
  const gw = createNarraWorkerGateway(config);
  let env!: NarraGatewayEnv;
  const sync = fakeNamespace((s) => new gw.BaseNarraMatrixSync(s, env));
  const rooms = fakeNamespace((s) => new gw.BaseNarraRoomCoordinator(s, env));
  env = {
    DB: createD1(),
    AI: ai,
    NARRA_GATEWAY_ENABLED: 'on',
    NARRA_SYNC: 'on',
    NARRA_AGENT_TOKEN: 'narra_test',
    NARRA_SYNC_DO: sync.namespace,
    NARRA_ROOM_DO: rooms.namespace,
    NARRA_PIPELINE: 'v2',
    NARRA_PIPELINE_ROOMS: ROOM,
    ...extraEnv,
  };
  const room = rooms.ensure(ROOM);
  const post = (events: unknown[]) =>
    room.instance.fetch(
      new Request('https://narra-room/events', {
        method: 'POST',
        body: JSON.stringify({ roomId: ROOM, chatType: 'group', members: ctx().members, selfMatrixId: NEWS, events }),
      }),
    );
  const msg = (id: string, body: string, sender = ZACK, extra: Record<string, unknown> = {}) => ({
    event_id: id,
    sender,
    type: 'm.room.message',
    origin_server_ts: nowMs,
    content: { msgtype: 'm.text', body, ...extra },
  });
  const runAlarmsFor = async (ms: number) => {
    const end = nowMs + ms;
    while (room.storage.alarmAt !== null && room.storage.alarmAt <= end) {
      nowMs = Math.max(nowMs, room.storage.alarmAt);
      await (room.instance as unknown as { alarm(): Promise<void> }).alarm();
    }
    nowMs = end;
  };
  const advance = (ms: number) => {
    nowMs += ms;
  };
  const log = async () => ((await room.storage.get<string[]>('log')) ?? []).join('\n');
  const kick = () => kickNarraGateway(env, config);
  const storage = room.storage;
  const rawBodies = rawRequests;
  return { sent, redactions, envelopes, post, msg, runAlarmsFor, advance, log, room, kick, storage, rawBodies, rooms };
}

describe('v2 pipeline end to end', () => {
  it('claims a relevant group question (hidden), shows 👀 only when answering, marks the answer and keeps the 👀', async () => {
    const t = setup('今天三則：OpenAI 發新模型、DeepMind 新論文、Anthropic 新功能。');
    await t.post([t.msg('$q', '有啥新聞嗎今天')]);
    await t.runAlarmsFor(10_000);
    // The claim is a hidden room event; the visible 👀 goes up right before the answer.
    expect(t.sent.map((s) => s.type)).toEqual(['ai.narra.claim', 'm.reaction', 'm.room.message']);
    expect(t.sent[0].body).toMatchObject({ target: '$q', reason: 'relevant' });
    expect(t.sent[1].body['m.relates_to']).toEqual({ rel_type: 'm.annotation', event_id: '$q', key: CLAIM_REACTION });
    expect(t.sent[2].body.body).toContain('OpenAI');
    expect(JSON.stringify(t.sent[2].body)).toContain('$q'); // ai.narra.answers marker
    // The 👀 stays after an answer, so people can see who took the message.
    expect(t.redactions).toEqual([]);
    expect(t.envelopes[0]).toContain('chat_behaviour');
    expect(t.envelopes[0]).toContain('reply_mode');
    expect(await t.log()).toMatch(/v2 gate \$q: wake=true relevant/);
  });

  it('stays out of chatter it is not relevant to, without calling Manyfold', async () => {
    const t = setup('should not be called');
    await t.post([t.msg('$c', '哈哈哈好好笑')]);
    await t.runAlarmsFor(10_000);
    expect(t.sent).toHaveLength(0);
    expect(t.envelopes).toHaveLength(0);
    expect(await t.log()).toMatch(/low_relevance/);
  });

  it('steps back when another agent claimed the question first', async () => {
    const t = setup('should not be called');
    await t.post([t.msg('$q', '有啥新聞嗎今天')]);
    await t.runAlarmsFor(2_000); // flush debounce, gate schedules its wait
    await t.post([
      {
        event_id: '$peer_claim',
        sender: SPOTTED,
        type: 'm.reaction',
        origin_server_ts: Date.UTC(2026, 10, 25, 12, 0, 2),
        content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$q', key: CLAIM_REACTION } },
      },
    ]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes).toHaveLength(0);
    expect(t.sent).toHaveLength(0);
    // A claim is not an answer: it waits for the outcome instead of dropping the message.
    expect(await t.log()).toMatch(/v2 wait \$q: claimed by @agent-f9388b28/);
    // The other agent answers: done.
    await t.post([
      {
        event_id: '$peer_answer',
        sender: SPOTTED,
        type: 'm.room.message',
        origin_server_ts: Date.UTC(2026, 10, 25, 12, 0, 12),
        content: { msgtype: 'm.text', body: '這週末有這些活動', 'ai.narra.answers': { event_id: '$q' } },
      },
    ]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes).toHaveLength(0);
    expect(await t.log()).toMatch(/v2 yield \$q: answered by @agent-f9388b28/);
  });

  it('answers after all when the agent that claimed first lets go without answering', async () => {
    const t = setup('今天三則 AI 新聞。');
    await t.post([t.msg('$q', '有啥新聞嗎今天')]);
    await t.runAlarmsFor(2_000);
    await t.post([
      {
        event_id: '$peer_claim',
        sender: SPOTTED,
        type: 'm.reaction',
        origin_server_ts: Date.UTC(2026, 10, 25, 12, 0, 2),
        content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$q', key: CLAIM_REACTION } },
      },
    ]);
    await t.runAlarmsFor(5_000);
    expect(t.envelopes).toHaveLength(0);
    await t.post([
      { event_id: '$peer_unclaim', sender: SPOTTED, type: 'm.room.redaction', redacts: '$peer_claim', origin_server_ts: Date.UTC(2026, 10, 25, 12, 0, 8), content: {} },
    ]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes).toHaveLength(1);
    expect(t.sent.some((s) => s.type === 'm.room.message' && String(s.body.body).includes('AI'))).toBe(true);
    expect(await t.log()).toMatch(/v2 resume \$q: @agent-f9388b28:matrix.netmind.chat released it/);
  });

  it('a silent brain leaves no trace: no message, no fake error, claim removed', async () => {
    const t = setup('[NO_REPLY]');
    await t.post([t.msg('$q', '有啥新聞嗎今天')]);
    await t.runAlarmsFor(10_000);
    // Nothing people can see: the only event is the hidden claim, and it is taken back.
    expect(t.sent.map((s) => s.type)).toEqual(['ai.narra.claim']);
    expect(t.redactions).toEqual(['$out_1']);
  });

  it('thanks gets an emoji, not a message', async () => {
    const t = setup('[REACT ❤️]');
    await t.post([t.msg('$t', '@AI in 5 謝謝！', ZACK, { 'm.mentions': { user_ids: [NEWS] } })]);
    await t.runAlarmsFor(10_000);
    // Addressed: the 👀 goes up at once, then the ❤️ replaces it. No text.
    expect(t.sent.every((s) => s.type === 'm.reaction')).toBe(true);
    const keys = t.sent.map((s) => (s.body['m.relates_to'] as { key: string }).key);
    expect(keys).toEqual(['👀', '❤️']);
    expect(t.redactions).toEqual(['$out_1']);
  });

  it('the group can ask the agent to speak only when mentioned', async () => {
    let n = 0;
    const t = setup(() => (n++ === 0 ? '[MODE mention]\n好，之後 @ 我我才回。' : 'should not be called'));
    await t.post([t.msg('$m', '@AI in 5 以後我們 @ 你你再回就好', ZACK, { 'm.mentions': { user_ids: [NEWS] } })]);
    await t.runAlarmsFor(10_000);
    expect(t.sent.at(-1)?.body.body).toBe('好，之後 @ 我我才回。');
    t.advance(60_000);
    await t.post([t.msg('$q2', '有啥 AI 新聞嗎')]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes).toHaveLength(1);
    expect(await t.log()).toMatch(/v2 gate \$q2: wake=false mode_mention/);
  });

  it('safety replies go out without the brain', async () => {
    const t = setup('should not be called', {
      v2: { safetyReply: (_env, event) => (/不想活/.test(event.text) ? 'If you are in danger, call 999 or Samaritans 116 123.' : null) },
    });
    await t.post([t.msg('$s', '@AI in 5 我不想活了', ZACK, { 'm.mentions': { user_ids: [NEWS] } })]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes).toHaveLength(0);
    expect(t.sent.at(-1)?.body.body).toContain('116 123');
  });

  it('streams a long reply: shows the first part, then edits the same message to the full text', async () => {
    const parts = ['今天第 39 期三則重點：', 'Google DeepMind 推出新的 AI 可靠性基準測試，涵蓋推理、工具使用與長文本三個面向；', 'Anthropic 推出 Claude Ship；百度開源 ERNIE 5.5。'];
    const events = [
      ...parts.map((text, i) => ({ kind: 'artifact-update', append: i > 0, artifact: { artifactId: 'a1', parts: [{ kind: 'text', text }] } })),
      { kind: 'status-update', status: { state: 'completed' } },
    ];
    const body = events.map((r) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: '1', result: r })}\n\n`).join('');
    const t = setup(() => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    await t.post([t.msg('$q', '有啥 AI 新聞')]);
    await t.runAlarmsFor(10_000);
    const messages = t.sent.filter((s) => s.type === 'm.room.message');
    expect(messages.length).toBe(2);
    expect(messages[0].body.body).toBe(parts.slice(0, 2).join(''));
    const final = messages[1].body as { 'm.new_content'?: { body: string }; 'm.relates_to'?: { rel_type: string; event_id: string } };
    expect(final['m.relates_to']).toMatchObject({ rel_type: 'm.replace', event_id: '$out_3' });
    expect(final['m.new_content']?.body).toBe(parts.join(''));
    expect(await t.log()).toMatch(/v2 answered \$q .*streamed/);
  });

  it('tells the brain to answer only the newest message and to thank with an emoji', async () => {
    const t = setup('好的。');
    await t.post([t.msg('$q', '@AI in 5 在嗎', ZACK, { 'm.mentions': { user_ids: [NEWS] } })]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes[0]).toContain('Answer only current_message');
    expect(t.envelopes[0]).toContain('always answer with [REACT <emoji>] alone');
  });

  it('tells the brain the reply language and fixes the script if it drifts', async () => {
    const t = setup('今天還是第 39 期，三條要聞。');
    await t.post([t.msg('$q', '@AI in 5 今天有什么新闻', ZACK, { 'm.mentions': { user_ids: [NEWS] } })]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes[0]).toContain('Write your reply in Simplified Chinese');
    expect(t.sent.at(-1)?.body.body).toBe('今天还是第 39 期，三条要闻。');
  });

  it('answers other languages in English', async () => {
    const t = setup('Today: three AI stories.');
    await t.post([t.msg('$q', '@AI in 5 今日のAIニュースは？', ZACK, { 'm.mentions': { user_ids: [NEWS] } })]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes[0]).toContain('Write your reply in English');
  });

  it('answers a crisis message even when it looks unrelated and nobody addressed the agent', async () => {
    const crisisReply = (_env: unknown, event: InboundEvent) =>
      /不想活/.test(event.text) ? '如果你有危險，請打 999 或 Samaritans 116 123。' : null;
    const t = setup('should not be called', { v2: { crisisReply } });
    await t.post([t.msg('$c', '我最近真的不想活了')]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes).toHaveLength(0);
    expect(t.sent.at(-1)?.body.body).toContain('116 123');
    expect(await t.log()).toMatch(/v2 crisis reply \$c/);
  });

  it('lets only one agent answer a crisis message in a group', async () => {
    const t = setup('should not be called', { v2: { crisisReply: () => '請打 116 123。' } });
    await t.post([t.msg('$c', '我最近真的不想活了')]);
    await t.runAlarmsFor(200); // debounce flushed, agent is waiting its turn
    await t.post([
      {
        event_id: '$peer_crisis',
        sender: SPOTTED,
        type: 'm.room.message',
        origin_server_ts: Date.UTC(2026, 10, 25, 12, 0, 2),
        content: { msgtype: 'm.text', body: '請打 116 123。', 'ai.narra.answers': { event_id: '$c' } },
      },
    ]);
    await t.runAlarmsFor(10_000);
    expect(t.sent).toHaveLength(0);
    expect(await t.log()).toMatch(/v2 crisis yield \$c/);
  });

  it('ordinary messages pass the crisis check untouched', async () => {
    const t = setup('今天三則 AI 新聞。', { v2: { crisisReply: () => null } });
    await t.post([t.msg('$q', '有啥新聞嗎今天')]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes).toHaveLength(1);
  });

  it('does not post a brain reply when another agent answered while it was thinking', async () => {
    let t!: ReturnType<typeof setup>;
    t = setup(async () => {
      // The peer's answer arrives while the brain is still working.
      await t.post([
        {
          event_id: '$peer_answer',
          sender: SPOTTED,
          type: 'm.room.message',
          origin_server_ts: Date.UTC(2026, 10, 25, 12, 0, 3),
          content: { msgtype: 'm.text', body: '這週末有這些。', 'ai.narra.answers': { event_id: '$q' } },
        },
      ]);
      return '今天三則 AI 新聞：…';
    });
    await t.post([t.msg('$q', '有啥新聞嗎今天')]);
    await t.runAlarmsFor(10_000);
    expect(t.sent.filter((s) => s.type === 'm.room.message')).toHaveLength(0);
    expect(await t.log()).toMatch(/v2 yield_after_brain \$q/);
  });

  it('a 👍 on its own message counts as a reply when the agent asks for it', async () => {
    let n = 0;
    const t = setup(() => (n++ === 0 ? '#21 晚餐 £120，大家回 OK 或按 👍 確認。' : '好，#21 已確認。'), { v2: { reactionsToSelf: ['👍'] } });
    await t.post([t.msg('$q', '@AI in 5 記一下晚餐 120', ZACK, { 'm.mentions': { user_ids: [NEWS] } })]);
    await t.runAlarmsFor(10_000);
    const proposalId = '$out_' + t.sent.length;
    await t.post([
      { event_id: '$like', sender: ZACK, type: 'm.reaction', origin_server_ts: Date.UTC(2026, 10, 25, 12, 1, 0), content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: proposalId, key: '👍' } } },
    ]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes).toHaveLength(2);
    expect(t.envelopes[1]).toContain('reacted_to_you');
    expect(t.sent.at(-1)?.body.body).toBe('好，#21 已確認。');
  });

  it('ignores reactions when the agent did not ask for them', async () => {
    const t = setup('should not be called');
    await t.post([
      { event_id: '$like', sender: ZACK, type: 'm.reaction', origin_server_ts: Date.UTC(2026, 10, 25, 12, 0, 0), content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$x', key: '👍' } } },
    ]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes).toHaveLength(0);
  });

  it('an agent hint wakes it for messages that look unrelated, or keeps it out', async () => {
    const t = setup('好，#21 已確認。', { v2: { wakeHint: (_env, event) => (event.text === '好' ? 'wake' : /晚餐/.test(event.text) ? 'skip' : null) } });
    await t.post([t.msg('$ok', '好')]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes).toHaveLength(1);
    await t.post([t.msg('$n', '有啥 AI 新聞')]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes).toHaveLength(2);
    await t.post([t.msg('$d', '晚餐 AI 新聞')]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes).toHaveLength(2);
  });

  it('can start every turn in a fresh conversation', async () => {
    const t = setup('ok', { v2: { freshContext: true } });
    await t.storage.put('a2aContextId', 'ctx-room');
    await t.post([t.msg('$q', '@AI in 5 在嗎', ZACK, { 'm.mentions': { user_ids: [NEWS] } })]);
    await t.runAlarmsFor(10_000);
    expect(t.rawBodies[0]).not.toContain('ctx-room');
  });

  it('with ONLY_LISTED, ignores rooms outside the list entirely', async () => {
    const t = setup('should not be called', {}, { NARRA_PIPELINE_ROOMS: '!other:matrix.netmind.chat', NARRA_PIPELINE_ONLY_LISTED: 'on' });
    await t.post([t.msg('$q', '@AI in 5 在嗎', ZACK, { 'm.mentions': { user_ids: [NEWS] } })]);
    await t.runAlarmsFor(10_000);
    expect(t.envelopes).toHaveLength(0);
    expect(t.sent).toHaveLength(0);
  });

  it('lets the brain write a scheduled post once per key, marked as a scheduled post', async () => {
    const t = setup('今天記了 3 筆，共 £86。', {
      v2: { proactive: () => [{ roomId: ROOM, key: 'daily:2026-11-25', note: '[penny nudge] daily 2026-11-25' }] },
    });
    await t.post([]);
    await t.kick();
    await t.runAlarmsFor(10_000);
    expect(t.envelopes[0]).toContain('[penny nudge] daily 2026-11-25');
    expect(t.envelopes[0]).toContain('your own scheduled turn');
    const post = t.sent.find((s) => s.type === 'm.room.message');
    expect(post?.body.body).toBe('今天記了 3 筆，共 £86。');
    expect(JSON.stringify(post?.body)).toContain('ai.narra.broadcast');
    await t.kick();
    await t.runAlarmsFor(10_000);
    expect(t.envelopes).toHaveLength(1);
  });
});

// Found in the zack test live run (2026-11-26).
describe('v2 fixes from the 11-26 live run', () => {
  const FOOD = '@agent-b2b526f3:matrix.netmind.chat';
  const EVENTS = '@agent-f9388b28:matrix.netmind.chat';
  const agentSpec = (matrixId: string, name: string): AgentSpec => ({ ...NEWS_SPEC, id: name, matrixId, name });

  it('two confident agents: the clearer winner over the other agents\' asks claims first and ranks higher', async () => {
    // "推薦一家 Soho 的點心": both scored 1.00 (cos .653 vs not .498, and cos .69 vs not .549).
    const e = ev('$dimsum', '推薦一家 Soho 的點心', NOW);
    const food = await decideWake({ event: e, context: ctx(), spec: agentSpec(FOOD, 'food'), mode: 'ambient', nowMs: NOW, score: async () => ({ score: 1, margin: 0.155, mine: true }) });
    const events = await decideWake({ event: e, context: ctx(), spec: agentSpec(EVENTS, 'events'), mode: 'ambient', nowMs: NOW, score: async () => ({ score: 1, margin: 0.141, mine: true }) });
    expect(claimPriority(food)).toBeGreaterThan(claimPriority(events));
    const wide = await decideWake({ event: e, context: ctx(), spec: agentSpec(FOOD, 'food'), mode: 'ambient', nowMs: NOW, score: async () => ({ score: 1, margin: 0.3, mine: true }) });
    const narrow = await decideWake({ event: e, context: ctx(), spec: agentSpec(EVENTS, 'events'), mode: 'ambient', nowMs: NOW, score: async () => ({ score: 1, margin: 0.02, mine: true }) });
    expect(wide.delayMs).toBeLessThan(narrow.delayMs);
  });

  it('does not stream a working note the brain replaces with the real answer', () => {
    const c = newStreamContinuity();
    expect(continuousStreamText(c, 'Group and members exist. Add the entry.', false)).toBe(false);
    expect(continuousStreamText(c, '#4 晚餐 £24，pika 付', false)).toBe(false);
    expect(continuousStreamText(c, '#4 晚餐 £24，pika 付\n均分 2 人，每人 £12', false)).toBe(true);
    // Once something is showing, a rewrite stops further edits (the final reply replaces it).
    expect(continuousStreamText(c, '完全不同的文字', true)).toBe(false);
    expect(continuousStreamText(c, '完全不同的文字，而且更長了', true)).toBe(false);
  });

  it('end to end: a narration message before a tool call never reaches the room', async () => {
    const answer = ['#4 晚餐 £24，pika 付。均分 2 人，每人 £12。', '@Zack 回 @Penny OK #4 入帳，或直接說要改什麼。這筆會先記成待確認，確認後才算進結餘。'];
    const events = [
      { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: 'Group and members exist. Add the entry. Checking the ledger now before writing.' }] },
      { kind: 'status-update', status: { state: 'working' } },
      ...answer.map((text, i) => ({ kind: 'artifact-update', append: i > 0, artifact: { artifactId: 'a1', parts: [{ kind: 'text', text }] } })),
      { kind: 'status-update', status: { state: 'completed' } },
    ];
    const body = events.map((r) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: '1', result: r })}\n\n`).join('');
    const t = setup(() => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    await t.post([t.msg('$p', '@AI in 5 我付了晚餐 £24', ZACK, { 'm.mentions': { user_ids: [NEWS] } })]);
    await t.runAlarmsFor(10_000);
    const bodies = t.sent.filter((s) => s.type === 'm.room.message').map((s) => String(s.body.body));
    expect(bodies.some((b) => b.includes('Group and members exist'))).toBe(false);
    expect(bodies.at(-1)).toContain('£12');
  });

  it('drops Markdown images that point at sandbox paths, even inside a code fence', () => {
    const out = sanitizeMobileLinks('今天可以做的一件小事：列出三樣東西。\n\n```![](sticks/21-zh.jpg)```');
    expect(out).not.toMatch(/sticks\/21|```|!\[/);
    expect(out).toContain('列出三樣東西');
  });

  it('fixes 準 written for permission in Traditional text, without breaking Simplified', () => {
    expect(toZhHant('FCC 批準 SpaceX 的計劃，獲準部署')).toBe('FCC 批准 SpaceX 的計劃，獲准部署');
    expect(toZhHant('標準和準備')).toBe('標準和準備');
    expect(toZhHans('批准')).toBe('批准');
  });
});

describe('v2 fixes from the 11-27 retest', () => {
  it('suggested follow-up questions in a list are not a question waiting for an answer', () => {
    expect(asksSomething('今天可以做的一件小事：找一個人說出來。\n\n接下來你也許想問：\n• 我該先跟誰開口比較好？\n• 要怎麼說才不像在抱怨？')).toBe(false);
    expect(asksSomething('可以的。你想問的是什麼事？工作、感情還是某個決定？')).toBe(true);
    expect(asksSomething('三個選項：\n1. 火鍋\n2. 點心\n想吃哪個？')).toBe(true);
  });

  it('thanks get an emoji even right after the agent\'s own question; never "I can only talk about X"', () => {
    expect(chatBehaviourNote({ chatType: 'group', direct: false })).toMatch(/This rule comes first, even right after your own question/);
    expect(chatBehaviourNote({ chatType: 'group', direct: false })).toMatch(/If you cannot help with it at all, do not say so: answer \[NO_REPLY\]/);
    expect(chatBehaviourNote({ chatType: 'group', direct: false })).not.toMatch(/stand-by/);
  });

  it('looks relevant but no closer to this agent than the others: goes last, and only after the ask check', async () => {
    const e = ev('$chat', '哈哈好喔', NOW);
    const d = await decideWake({ event: e, context: ctx(), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => ({ score: 0.76, rawScore: 0.76, margin: 0.02, mine: true }) });
    // Chatter does not saturate relevance (0.76): dropped without even an ask check.
    expect(d).toMatchObject({ wake: false, reason: 'low_margin' });
    const tie = await decideWake({ event: ev('$tie', '吃完飯有什麼市集可以逛', NOW), context: ctx(), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => ({ score: 1, rawScore: 1, margin: 0.02, mine: true }) });
    expect(tie).toMatchObject({ wake: true, reason: 'relevant', askCheck: true });
    const real = await decideWake({ event: ev('$ask', '推薦一家 Soho 的點心', NOW), context: ctx(), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => ({ score: 1, rawScore: 1, margin: 0.155, mine: true }) });
    expect(real).toMatchObject({ wake: true, reason: 'relevant' });
    expect(real.askCheck).toBeUndefined();
    expect(real.delayMs).toBeLessThan(tie.delayMs);
  });
});

describe('v2 fixes from Netmind London 15:01–15:13', () => {
  it('a need every agent is faintly close to is not checked as an ask; a two-agent ask still is', async () => {
    const weak = await decideWake({ event: ev('$hungry', '我好餓', NOW), context: ctx(), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => ({ score: 0.64, rawScore: 0.64, margin: 0.001, mine: true }) });
    expect(weak).toMatchObject({ wake: false, reason: 'low_margin' });
    const both = await decideWake({ event: ev('$both', '週末吃完飯可以去哪裡逛逛', NOW), context: ctx(), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => ({ score: 1, rawScore: 1, margin: 0.054, mine: true }) });
    expect(both).toMatchObject({ wake: true, reason: 'relevant', askCheck: true });
  });

  it('tells the brain a repeated question still needs an answer', () => {
    expect(chatBehaviourNote({ chatType: 'group', direct: false })).toMatch(/Never answer a repeated question with \[NO_REPLY\]/);
  });
});
