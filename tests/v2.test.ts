import { describe, expect, it, vi } from 'vitest';
import {
  CLAIM_REACTION,
  UsageBudget,
  NARRA_USAGE_SCHEMA,
  applyClaimReaction,
  applyClaimRedaction,
  buildLedgerSummary,
  createNarraWorkerGateway,
  decideWake,
  emptyRoomState,
  parseBrainOutput,
  peerClaimHolder,
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

describe('v2 wake gate', () => {
  const never = async () => {
    throw new Error('must not score');
  };

  it('always wakes for DMs, mentions and replies to itself, without scoring', async () => {
    const dm = await decideWake({ event: ev('$1', 'hi', NOW, { chatType: 'dm' }), context: ctx({ chatType: 'dm' }), spec: NEWS_SPEC, mode: 'quiet', nowMs: NOW, score: never });
    expect(dm).toMatchObject({ wake: true, reason: 'dm', direct: true, delayMs: 0, claim: false });
    const mention = await decideWake({ event: ev('$2', '@AI in 5 今天有什麼', NOW, { mentions: [NEWS] }), context: ctx(), spec: NEWS_SPEC, mode: 'mention', nowMs: NOW, score: never });
    expect(mention).toMatchObject({ wake: true, reason: 'mentioned', direct: true });
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
    const d = await decideWake({ event: ev('$c', '第二則是哪家公司'), context: ctx({ recentHistory: history }), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: never });
    expect(d).toMatchObject({ wake: true, reason: 'your_conversation', delayMs: 0, claim: true, direct: false });
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
    const withPeer = await decideWake({ event: q, context: ctx({ recentHistory: history }), spec: NEWS_SPEC, mode: 'ambient', nowMs: NOW, score: async () => 0.7 });
    expect(withPeer).toMatchObject({ wake: false, reason: 'peer_conversation' });
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

function setup(brainReply: string | (() => string), extraConfig: Partial<NarraGatewayConfig<NarraGatewayEnv>> = {}) {
  let nowMs = Date.UTC(2026, 10, 25, 12, 0, 0);
  const sent: Array<{ type: string; body: Record<string, unknown> }> = [];
  const redactions: string[] = [];
  const envelopes: string[] = [];
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
      return sse(typeof brainReply === 'function' ? brainReply() : brainReply);
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
  return { sent, redactions, envelopes, post, msg, runAlarmsFor, advance, log, room };
}

describe('v2 pipeline end to end', () => {
  it('claims a relevant group question with 👀, lets Manyfold answer, marks the answer and releases the claim', async () => {
    const t = setup('今天三則：OpenAI 發新模型、DeepMind 新論文、Anthropic 新功能。');
    await t.post([t.msg('$q', '有啥新聞嗎今天')]);
    await t.runAlarmsFor(10_000);
    expect(t.sent.map((s) => s.type)).toEqual(['m.reaction', 'm.room.message']);
    expect(t.sent[0].body['m.relates_to']).toEqual({ rel_type: 'm.annotation', event_id: '$q', key: CLAIM_REACTION });
    expect(t.sent[1].body.body).toContain('OpenAI');
    expect(JSON.stringify(t.sent[1].body)).toContain('$q'); // ai.narra.answers marker
    expect(t.redactions).toEqual(['$out_1']);
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
    expect(await t.log()).toMatch(/v2 yield \$q: handled by @agent-f9388b28/);
  });

  it('a silent brain leaves no trace: no message, no fake error, claim removed', async () => {
    const t = setup('[NO_REPLY]');
    await t.post([t.msg('$q', '有啥新聞嗎今天')]);
    await t.runAlarmsFor(10_000);
    expect(t.sent.map((s) => s.type)).toEqual(['m.reaction']);
    expect(t.redactions).toEqual(['$out_1']);
  });

  it('thanks gets an emoji, not a message', async () => {
    const t = setup('[REACT ❤️]');
    await t.post([t.msg('$t', '@AI in 5 謝謝！', ZACK, { 'm.mentions': { user_ids: [NEWS] } })]);
    await t.runAlarmsFor(10_000);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].type).toBe('m.reaction');
    expect((t.sent[0].body['m.relates_to'] as { key: string }).key).toBe('❤️');
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
});
