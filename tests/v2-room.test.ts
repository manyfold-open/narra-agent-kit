import { describe, expect, it } from 'vitest';
import type { AgentSpec } from '../src/index.js';
import { createRoomSim, type SimAgentDef } from './v2-room-sim.js';

// Room-level promises for the chat-native pipeline, checked with several agents in one room:
// every real ask gets exactly one answer, chatter gets none, and no agent can silently swallow
// a message another agent should have answered.

const ZACK = '@sp-zack:matrix.netmind.chat';
const PIKA = '@sp-pika:matrix.netmind.chat';
const HUMANS = [
  { id: ZACK, name: 'Zack' },
  { id: PIKA, name: 'pika' },
];

const spec = (matrixId: string, name: string, domainDescription: string): AgentSpec => ({
  id: name.toLowerCase(),
  matrixId,
  name,
  domainDescription,
  domainKeywords: [],
  antiKeywords: [],
});

const FOOD_ASKS = ['晚餐吃啥好？', '肚子餓了，附近有什麼吃的？', '有好吃的火鍋嗎？'];
const EVENT_ASKS = ['這週末有什麼快閃活動？', '晚上有什麼好玩的？', '有推薦的市集嗎？'];
const DATA_ASKS = ['這週末倫敦有什麼 AI 黑客松？', '哪些公司拿到融資？'];
const MONEY_ASKS = ['我付了午餐 £30', '誰欠誰？'];

function food(over: Partial<SimAgentDef> = {}): SimAgentDef {
  return {
    spec: spec('@agent-f00d0001:matrix.netmind.chat', 'FOOD', 'London Chinese food and restaurants'),
    profile: 'Chinese restaurants, food and where to eat in London',
    wakeExamples: FOOD_ASKS,
    notExamples: [...EVENT_ASKS, ...DATA_ASKS],
    brain: (t) => (/吃|餐|火鍋|餓|市集/.test(t) ? 'FOOD: 兩家推薦' : '[NO_REPLY]'),
    ...over,
  };
}

function events(over: Partial<SimAgentDef> = {}): SimAgentDef {
  return {
    spec: spec('@agent-e5e70002:matrix.netmind.chat', 'EVENTS', 'London pop-ups and things to do'),
    profile: 'Pop-ups, markets, exhibitions and things to do in London',
    wakeExamples: EVENT_ASKS,
    notExamples: [...FOOD_ASKS, ...DATA_ASKS],
    brain: (t) => (/玩|快閃|活動|市集|去哪|推薦/.test(t) ? 'EVENTS: 三個活動' : '[NO_REPLY]'),
    ...over,
  };
}

function data(over: Partial<SimAgentDef> = {}): SimAgentDef {
  return {
    spec: spec('@agent-da7a0003:matrix.netmind.chat', 'DATA', 'Datasets: AI hackathons, funding rounds'),
    profile: 'AI hackathons, conferences and funding rounds datasets',
    wakeExamples: DATA_ASKS,
    notExamples: [...FOOD_ASKS, ...EVENT_ASKS],
    brain: (t) => (/黑客松|融資|第二個/.test(t) ? 'DATA: 三場黑客松' : '[NO_REPLY]'),
    ...over,
  };
}

/** A ledger agent that, while a bill waits for an OK, wants to look at every short message. */
function penny(pending: { bill: boolean }, over: Partial<SimAgentDef> = {}): SimAgentDef {
  return {
    spec: spec('@agent-be770004:matrix.netmind.chat', 'PENNY', 'Group expense ledger'),
    profile: 'Shared expenses, who paid, who owes whom',
    wakeExamples: MONEY_ASKS,
    notExamples: [...FOOD_ASKS, ...EVENT_ASKS, ...DATA_ASKS],
    brain: (t) => (/^(OK|好)/i.test(t.trim()) ? 'PENNY: #1 入帳' : '[NO_REPLY]'),
    extra: {
      v2: {
        wakeHint: (_env, event) => (pending.bill && [...(event.text ?? '').trim()].length <= 12 ? 'wake' : null),
      },
    },
    ...over,
  };
}

/** Make an agent always claim first (no wait) and another one later. */
const first = { gate: { minDelayMs: 0, maxDelayMs: 0 } };
const later = { gate: { minDelayMs: 3_000, maxDelayMs: 3_000 } };

describe('v2 room: every real ask gets exactly one answer', () => {
  it('a short food ask while a bill waits for OK still reaches the food agent (Penny only looks)', async () => {
    const sim = createRoomSim([food(), events(), data(), penny({ bill: true })], HUMANS);
    const q = await sim.say(PIKA, '有啥火鍋好吃嗎');
    await sim.run(120_000);
    expect(sim.answersTo(q)).toEqual(['FOOD']);
  });

  it('the bill OK still goes to Penny alone', async () => {
    const sim = createRoomSim([food(), events(), data(), penny({ bill: true })], HUMANS);
    const q = await sim.say(PIKA, 'OK');
    await sim.run(120_000);
    expect(sim.answersTo(q)).toEqual(['PENNY']);
  });

  it('when the agent that claimed first stays silent, the next fitting agent answers', async () => {
    const sim = createRoomSim(
      [
        food({ extra: { v2: later } }),
        events({ brain: () => '[NO_REPLY]', extra: { v2: first } }),
      ],
      HUMANS,
    );
    const q = await sim.say(ZACK, '吃完飯有什麼市集可以逛');
    await sim.run(120_000);
    expect(sim.answersTo(q)).toEqual(['FOOD']);
  });

  it('when the agent that claimed first fails, the next fitting agent answers', async () => {
    const sim = createRoomSim(
      [
        food({ extra: { v2: later } }),
        events({ brain: () => ({ fail: true }), extra: { v2: first } }),
      ],
      HUMANS,
    );
    const q = await sim.say(ZACK, '吃完飯有什麼市集可以逛');
    await sim.run(180_000);
    expect(sim.answersTo(q)).toEqual(['FOOD']);
  });

  it('two people asking different agents both get answers', async () => {
    const sim = createRoomSim([food(), events(), data(), penny({ bill: true })], HUMANS);
    const a = await sim.say(ZACK, '這週末有什麼快閃活動');
    await sim.run(30_000);
    const b = await sim.say(PIKA, '有啥火鍋好吃嗎');
    await sim.run(30_000);
    const c = await sim.say(ZACK, '那晚上有啥可以玩的嗎');
    await sim.run(60_000);
    expect(sim.answersTo(a)).toEqual(['EVENTS']);
    expect(sim.answersTo(b)).toEqual(['FOOD']);
    expect(sim.answersTo(c)).toEqual(['EVENTS']);
  });

  it('a follow-up stays with the agent that just answered', async () => {
    const sim = createRoomSim([food(), events(), data(), penny({ bill: true })], HUMANS);
    const a = await sim.say(ZACK, '這週末倫敦有什麼 AI 黑客松');
    await sim.run(30_000);
    const b = await sim.say(ZACK, '第二個呢');
    await sim.run(60_000);
    expect(sim.answersTo(a)).toEqual(['DATA']);
    expect(sim.answersTo(b)).toEqual(['DATA']);
  });

  it('a vague ask that moved to another agent mid-thread is picked up by that agent', async () => {
    const sim = createRoomSim([food(), events(), data()], HUMANS);
    const a = await sim.say(ZACK, '肚子餓了 有啥可以吃');
    await sim.run(30_000);
    const b = await sim.say(ZACK, '晚上去哪好');
    await sim.run(60_000);
    expect(sim.answersTo(a)).toEqual(['FOOD']);
    expect(sim.answersTo(b)).toEqual(['EVENTS']);
  });

  it('an ask no agent is sure about still gets one answer from the best fit', async () => {
    const sim = createRoomSim([food(), events(), data()], HUMANS);
    const q = await sim.say(ZACK, '有什麼推薦');
    await sim.run(120_000);
    expect(sim.answersTo(q)).toEqual(['EVENTS']);
  });

  it('the 👀 stays on an answered message and goes away when the claimer stayed silent', async () => {
    const sim = createRoomSim(
      [food({ extra: { v2: later } }), events({ brain: () => '[NO_REPLY]', extra: { v2: first } })],
      HUMANS,
    );
    const q = await sim.say(ZACK, '吃完飯有什麼市集可以逛');
    await sim.run(120_000);
    const claims = sim.timeline.filter((e) => e.type === 'm.reaction' && (e.content['m.relates_to'] as { event_id: string }).event_id === q);
    const redacted = new Set(sim.timeline.filter((e) => e.type === 'm.room.redaction').map((e) => e.redacts));
    const live = claims.filter((c) => !redacted.has(c.event_id)).map((c) => sim.agent('FOOD').id === c.sender ? 'FOOD' : 'EVENTS');
    expect(sim.answersTo(q)).toEqual(['FOOD']);
    expect(live).toEqual(['FOOD']);
  });

  it('chatter gets no answer and nobody claims it', async () => {
    const sim = createRoomSim([food(), events(), data(), penny({ bill: false })], HUMANS);
    const q = await sim.say(ZACK, '哈哈');
    await sim.run(120_000);
    expect(sim.answersTo(q)).toEqual([]);
    expect(sim.timeline.filter((e) => e.type === 'm.reaction')).toEqual([]);
  });
});
