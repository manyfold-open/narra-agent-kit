/**
 * A shared group room with several v2 agents, each its own gateway (own Durable Objects, own brain),
 * talking only through the room like real Workers do: messages, 👀 claims, redactions. Used to check
 * room-level promises ("every real ask gets exactly one answer") that single-agent tests cannot see.
 */
import {
  createNarraWorkerGateway,
  type AgentSpec,
  type NarraGatewayConfig,
  type NarraGatewayEnv,
} from '../src/index.js';
import { createD1 } from './d1.js';

export const SIM_ROOM = '!simroom:matrix.netmind.chat';
export const START_MS = Date.UTC(2026, 10, 26, 11, 0, 0);

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
  return { namespace, ensure };
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

/** Topic axes for the fake embedding: food, events, data, money, chatter, fortune. */
const TOPICS: Array<[RegExp, number[]]> = [
  // Live zack test 2026-11-26 (G10, G14): closest to the events agent, but data fits on its own.
  [/房租.*資料集/, [0, 0.8, 0.6, 0, 0]],
  [/天氣|好喔哈哈/, [0, 0.8, 0.5, 0, 0.3]],
  // G17: food and events both fit fully.
  [/點心/, [1, 1, 0, 0, 0]],
  [/£|付了|欠|帳|記帳|split|owe|bill|expense|\bOK\b|^好$|#\d/i, [0, 0, 0, 1, 0]],
  [/黑客松|hackathon|資料集|dataset|融資|funding|研討會/i, [0, 0, 1, 0, 0]],
  // Vague asks: clearly closer to events than to anything else, but not by much.
  [/晚上去哪好/, [0.1, 0.52, 0, 0, 0.85]],
  [/有什麼推薦/, [0.1, 0.45, 0, 0, 0.9]],
  // Both food and events.
  [/吃完飯有什麼市集/, [1, 1, 0, 0, 0]],
  // Mostly food, a little events.
  [/夜市小吃/, [1, 0.6, 0, 0, 0]],
  // Tarot readings share the fortune-telling axis.
  [/塔羅|tarot|抽.{0,3}張牌|one card/i, [0, 0, 0, 0, 0, 1]],
  // Fortune telling.
  [/抽.*籤|運勢|fortune/i, [0, 0, 0, 0, 0, 1]],
  [/玩|快閃|活動|市集|展覽|pop-?up|market|exhibition|things to do/i, [0, 1, 0, 0, 0]],
  [/吃|餐|火鍋|餓|拉麵|food|dinner|restaurant/i, [1, 0, 0, 0, 0]],
];

export function fakeEmbedding(text: string): number[] {
  for (const [re, v] of TOPICS) if (re.test(text)) return v;
  return [0, 0, 0, 0, 1, 0];
}

export interface SimEvent {
  event_id: string;
  sender: string;
  type: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  redacts?: string;
}

/** What the agent's Manyfold brain answers for a turn; `fail` makes the A2A call fail. */
export type BrainReply = string | { fail: true };

/** How long a brain call takes in room time (a real Manyfold turn takes seconds). */
export const BRAIN_LATENCY_MS = 4_000;
export const BRAIN_FAIL_AFTER_MS = 25_000;

export interface SimAgentDef {
  spec: AgentSpec;
  profile: string;
  wakeExamples: string[];
  notExamples: string[];
  /** current human message text (and the full prompt the agent sent) -> brain reply */
  brain: (text: string, prompt: string) => BrainReply;
  extra?: Partial<NarraGatewayConfig<NarraGatewayEnv>>;
}

export interface SimAgent {
  def: SimAgentDef;
  id: string;
  brainCalls: string[];
  /** The raw A2A request bodies this agent sent its brain, in order. */
  brainPrompts: string[];
  room: { instance: { fetch(r: Request): Promise<Response> }; storage: FakeDOStorage };
  delivered: number;
  busy: boolean;
  waitingBrain: boolean;
}

export function createRoomSim(defs: SimAgentDef[], humans: Array<{ id: string; name: string }>) {
  let nowMs = START_MS;
  const timeline: SimEvent[] = [];
  let seq = 0;
  const brainWaiters: Array<{ at: number; agent: SimAgent; resolve: () => void }> = [];
  const members = [
    ...humans.map((h) => ({ matrixId: h.id, displayName: h.name, isAgent: false })),
    ...defs.map((d) => ({ matrixId: d.spec.matrixId!, displayName: d.spec.name, isAgent: true })),
  ];

  const agents: SimAgent[] = [];
  defs.forEach((def) => {
    const id = def.spec.matrixId!;
    const short = id.slice(7, 11);
    const brainCalls: string[] = [];
    const brainPrompts: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/api/agent-runtime/matrix-credential')) {
        return Response.json({ status: 'ok', data: { homeserver_url: 'https://matrix.netmind.chat', matrix_user_id: id, access_token: 'syt_test' } });
      }
      if (url.includes('/typing/') || url.includes('/receipt/')) return Response.json({});
      if (url.includes('/redact/')) {
        const target = decodeURIComponent(url.split('/redact/')[1].split('/')[0]);
        const eventId = `$${short}_r${++seq}`;
        timeline.push({ event_id: eventId, sender: id, type: 'm.room.redaction', origin_server_ts: nowMs, content: JSON.parse(String(init?.body ?? '{}')), redacts: target });
        return Response.json({ event_id: eventId });
      }
      const send = /\/send\/([^/]+)\//.exec(url);
      if (send) {
        const eventId = `$${short}_${++seq}`;
        timeline.push({ event_id: eventId, sender: id, type: decodeURIComponent(send[1]), origin_server_ts: nowMs, content: JSON.parse(String(init?.body ?? '{}')) });
        return Response.json({ event_id: eventId });
      }
      if (url === `https://a2a.test/${short}`) {
        const current = latestHumanTextBefore(nowMs);
        brainCalls.push(current);
        const prompt = String(init?.body ?? '');
        brainPrompts.push(prompt);
        const reply = def.brain(current, prompt);
        const self = agents.find((a) => a.id === id)!;
        // The brain takes room time; other agents keep working meanwhile.
        self.waitingBrain = true;
        await new Promise<void>((resolve) =>
          brainWaiters.push({ at: nowMs + (typeof reply === 'string' ? BRAIN_LATENCY_MS : BRAIN_FAIL_AFTER_MS), agent: self, resolve }),
        );
        self.waitingBrain = false;
        if (typeof reply !== 'string') return new Response('upstream timeout', { status: 504 });
        return sse(reply);
      }
      return new Response('not found', { status: 404 });
    };
    const config: NarraGatewayConfig<NarraGatewayEnv> = {
      spec: def.spec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => nowMs,
      sleep: async () => undefined,
      resolveA2ACredential: async () => ({ url: `https://a2a.test/${short}`, token: 'tok' }),
      ...def.extra,
      v2: { profile: def.profile, wakeExamples: def.wakeExamples, notExamples: def.notExamples, ...(def.extra?.v2 ?? {}) },
    };
    const gw = createNarraWorkerGateway(config);
    let env!: NarraGatewayEnv;
    const sync = fakeNamespace((s) => new gw.BaseNarraMatrixSync(s, env));
    const rooms = fakeNamespace((s) => new gw.BaseNarraRoomCoordinator(s, env));
    env = {
      DB: createD1(),
      AI: { run: async (_m: string, input: { text: string[] }) => ({ data: input.text.map(fakeEmbedding) }) },
      NARRA_GATEWAY_ENABLED: 'on',
      NARRA_SYNC: 'on',
      NARRA_AGENT_TOKEN: 'narra_test',
      NARRA_SYNC_DO: sync.namespace,
      NARRA_ROOM_DO: rooms.namespace,
      NARRA_PIPELINE: 'v2',
      NARRA_PIPELINE_ROOMS: SIM_ROOM,
    } as NarraGatewayEnv;
    agents.push({ def, id, brainCalls, brainPrompts, room: rooms.ensure(SIM_ROOM), delivered: 0, busy: false, waitingBrain: false });
  });

  function latestHumanTextBefore(ms: number): string {
    // The turn being answered is the newest human message the agents have seen.
    for (let i = timeline.length - 1; i >= 0; i--) {
      const e = timeline[i];
      if (e.type === 'm.room.message' && humans.some((h) => h.id === e.sender) && e.origin_server_ts <= ms) {
        return String(e.content.body ?? '');
      }
    }
    return '';
  }

  /** Hand every agent the room events it has not seen yet (its own included, as /sync does). */
  async function deliver(): Promise<void> {
    for (const a of agents) {
      while (a.delivered < timeline.length) {
        const batch = timeline.slice(a.delivered);
        a.delivered = timeline.length;
        await a.room.instance.fetch(
          new Request('https://narra-room/events', {
            method: 'POST',
            body: JSON.stringify({ roomId: SIM_ROOM, chatType: 'group', members, selfMatrixId: a.id, events: batch }),
          }),
        );
      }
    }
  }

  async function say(sender: string, body: string, extra: Record<string, unknown> = {}): Promise<string> {
    const eventId = `$h${++seq}`;
    timeline.push({ event_id: eventId, sender, type: 'm.room.message', origin_server_ts: nowMs, content: { msgtype: 'm.text', body, ...extra } });
    await deliver();
    return eventId;
  }

  /** Let started work run until every busy agent is done or waiting on its brain. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      await new Promise((r) => setImmediate(r));
      if (!agents.some((a) => a.busy && !a.waitingBrain)) return;
    }
    throw new Error('room simulation did not settle');
  }

  /**
   * Run the room until `ms` from now: alarms and brain completions in time order, room events
   * delivered between steps. An agent waiting on its brain does not block the others.
   */
  async function run(ms: number): Promise<void> {
    const end = nowMs + ms;
    for (let guard = 0; guard < 5_000; guard++) {
      await deliver();
      await settle();
      await deliver();
      let at = Infinity;
      let start: SimAgent | undefined;
      for (const a of agents) {
        const t = a.room.storage.alarmAt;
        if (!a.busy && t !== null && t <= end && t < at) {
          at = t;
          start = a;
        }
      }
      let waiterIdx = -1;
      brainWaiters.forEach((w, i) => {
        if (w.at <= end && w.at < at) {
          at = w.at;
          waiterIdx = i;
          start = undefined;
        }
      });
      if (at === Infinity) break;
      nowMs = Math.max(nowMs, at);
      if (waiterIdx >= 0) {
        const [w] = brainWaiters.splice(waiterIdx, 1);
        w.resolve();
        continue;
      }
      const a = start!;
      a.room.storage.alarmAt = null;
      a.busy = true;
      void (a.room.instance as unknown as { alarm(): Promise<void> })
        .alarm()
        .finally(() => {
          a.busy = false;
        });
    }
    await deliver();
    await settle();
    nowMs = Math.max(nowMs, end);
  }

  /** Agent text messages that answer `eventId` (by the hidden answer marker or a quote). */
  function answersTo(eventId: string): string[] {
    return timeline
      .filter((e) => e.type === 'm.room.message' && agents.some((a) => a.id === e.sender))
      .filter((e) => {
        const c = e.content as Record<string, unknown>;
        const rel = (c['m.relates_to'] ?? {}) as Record<string, unknown>;
        const inReply = ((rel['m.in_reply_to'] ?? {}) as Record<string, unknown>).event_id;
        const marker = (c['ai.narra.answers'] ?? {}) as Record<string, unknown>;
        return marker.event_id === eventId || inReply === eventId;
      })
      .map((e) => agents.find((a) => a.id === e.sender)!.def.spec.name);
  }

  async function logOf(name: string): Promise<string> {
    const a = agents.find((x) => x.def.spec.name === name)!;
    return ((await a.room.storage.get<string[]>('log')) ?? []).join('\n');
  }

  const agent = (name: string) => agents.find((a) => a.def.spec.name === name)!;
  const advance = (ms: number) => {
    nowMs += ms;
  };
  /** Text of the agent messages that answer `eventId`. */
  function answerTexts(eventId: string): string[] {
    const ids = new Set(answersTo(eventId).map((n) => agents.find((a) => a.def.spec.name === n)!.id));
    return timeline
      .filter((e) => e.type === 'm.room.message' && ids.has(e.sender))
      .filter((e) => {
        const c = e.content as Record<string, unknown>;
        const rel = (c['m.relates_to'] ?? {}) as Record<string, unknown>;
        const inReply = ((rel['m.in_reply_to'] ?? {}) as Record<string, unknown>).event_id;
        return ((c['ai.narra.answers'] ?? {}) as Record<string, unknown>).event_id === eventId || inReply === eventId;
      })
      .map((e) => String(e.content.body ?? ''));
  }

  return { say, run, answersTo, answerTexts, logOf, agent, timeline, advance, now: () => nowMs };
}
