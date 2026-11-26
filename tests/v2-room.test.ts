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

const DEMI = '@sp-demi:matrix.netmind.chat';
const HUMANS3 = [...HUMANS, { id: DEMI, name: 'demi' }];

/** Asks which topic before drawing; its brain answers a bare "工作" only when told it is the answer to its question. */
function fortune(over: Partial<SimAgentDef> = {}): SimAgentDef {
  return {
    spec: spec('@agent-f0r70005:matrix.netmind.chat', 'FORTUNE', 'Fortune stick draws'),
    profile: 'Fortune stick draws, luck and 抽籤',
    wakeExamples: ['幫我抽個籤', '今天運勢如何'],
    notExamples: [...FOOD_ASKS, ...EVENT_ASKS, ...DATA_ASKS],
    brain: (t, prompt) => {
      if (/抽.*籤/.test(t)) return '可以的。你想問的是什麼事？工作、感情還是某個決定？';
      if (/工作|感情/.test(t) && prompt.includes('your_open_question')) return 'FORTUNE: 第 13 籤 · 工作';
      return '[NO_REPLY]';
    },
    ...over,
  };
}

async function askFortune(sim: ReturnType<typeof createRoomSim>): Promise<string> {
  const id = sim.agent('FORTUNE').id;
  const q = await sim.say(DEMI, '@FORTUNE 幫我抽個籤', { 'm.mentions': { user_ids: [id] } });
  await sim.run(30_000);
  expect(sim.answersTo(q)).toEqual(['FORTUNE']);
  return q;
}

describe('v2 room: a conversation belongs to the room, not to one sender', () => {
  it('a different person answering an agent question minutes later reaches that agent', async () => {
    const sim = createRoomSim([fortune(), food(), events(), penny({ bill: false })], HUMANS3);
    await askFortune(sim);
    sim.advance(13 * 60_000);
    const a = await sim.say(PIKA, '工作');
    await sim.run(60_000);
    expect(sim.answersTo(a)).toEqual(['FORTUNE']);
  });

  it('the person who was asked can still answer after the 3-minute thread window', async () => {
    const sim = createRoomSim([fortune(), food(), events()], HUMANS3);
    await askFortune(sim);
    sim.advance(10 * 60_000);
    const a = await sim.say(DEMI, '感情');
    await sim.run(60_000);
    expect(sim.answersTo(a)).toEqual(['FORTUNE']);
  });

  it('once the question is answered, later chatter is not treated as an answer', async () => {
    const sim = createRoomSim([fortune(), food(), events()], HUMANS3);
    await askFortune(sim);
    const a = await sim.say(PIKA, '工作');
    await sim.run(30_000);
    expect(sim.answersTo(a)).toEqual(['FORTUNE']);
    sim.advance(5 * 60_000);
    const b = await sim.say(ZACK, '哈哈');
    await sim.run(60_000);
    expect(sim.answersTo(b)).toEqual([]);
  });

  it('a real ask for another agent after an agent question still goes to that other agent', async () => {
    const sim = createRoomSim([fortune(), food(), events()], HUMANS3);
    await askFortune(sim);
    sim.advance(60_000);
    const a = await sim.say(PIKA, '有好吃的火鍋嗎？');
    await sim.run(60_000);
    expect(sim.answersTo(a)).toEqual(['FOOD']);
  });
});

describe('v2 room: the best fit wins, not the fastest claim', () => {
  it('a much better fit is not held back by a weaker agent that claimed first', async () => {
    const sim = createRoomSim(
      [
        food({ extra: { v2: later } }),
        // Weak fit (no notExamples), claims instantly, and its brain hangs.
        events({ notExamples: [], brain: () => ({ fail: true }), extra: { v2: first } }),
      ],
      HUMANS,
    );
    const q = await sim.say(ZACK, '夜市小吃推薦');
    await sim.run(15_000);
    expect(sim.answersTo(q)).toEqual(['FOOD']);
    await sim.run(150_000);
    expect(sim.answersTo(q)).toEqual(['FOOD']);
  });

  it('a claimant whose brain fails lets the next agent go at once, not after its retries', async () => {
    const sim = createRoomSim(
      [food({ extra: { v2: later } }), events({ brain: () => ({ fail: true }), extra: { v2: first } })],
      HUMANS,
    );
    const q = await sim.say(ZACK, '吃完飯有什麼市集可以逛');
    await sim.run(45_000);
    expect(sim.answersTo(q)).toEqual(['FOOD']);
    await sim.run(150_000);
    expect(sim.answersTo(q)).toEqual(['FOOD']);
  });
});

describe('v2 room: a real ask nobody claims still gets one answer (zack test, 2026-11-26)', () => {
  // G10: the events agent fits best by topic but stays silent; the data agent is the right one, yet
  // its message is "closer to another agent's asks", which used to zero it and empty the stand-by pool.
  it('a question the better fit declines goes to the agent that fits it on its own (房租資料集)', async () => {
    const sim = createRoomSim(
      [
        food(),
        events({ brain: () => '[NO_REPLY]' }),
        data({ brain: (t) => (/資料集|黑客松/.test(t) ? 'DATA: 倫敦房租資料集' : '[NO_REPLY]') }),
      ],
      HUMANS,
    );
    const q = await sim.say(PIKA, '有沒有倫敦房租的公開資料集？');
    await sim.run(120_000);
    expect(sim.answersTo(q)).toEqual(['DATA']);
  });

  // G14: nobody's topic. The agents that woke stay silent; one stand-by answers as the room's catch-all.
  it('a question outside every speciality gets one answer from a stand-by (天氣)', async () => {
    const standByBrain = (t: string, prompt: string) =>
      /天氣/.test(t) && prompt.includes('stand-by') ? 'DATA: 今天多雲，帶把傘' : '[NO_REPLY]';
    const sim = createRoomSim([food(), events({ brain: () => '[NO_REPLY]' }), data({ brain: standByBrain })], HUMANS);
    const q = await sim.say(PIKA, '倫敦今天天氣怎麼樣？');
    await sim.run(120_000);
    expect(sim.answersTo(q)).toEqual(['DATA']);
  });

  // The stand-by is a last resort, not a cascade: chatter one stand-by passed on is not retried.
  it('chatter a stand-by passed on is not tried again by the next one', async () => {
    const sim = createRoomSim(
      [food(), events({ brain: () => '[NO_REPLY]' }), data({ brain: () => '[NO_REPLY]' })],
      HUMANS,
    );
    const q = await sim.say(PIKA, '好喔哈哈');
    await sim.run(120_000);
    expect(sim.answersTo(q)).toEqual([]);
    expect(sim.agent('DATA').brainCalls.length).toBeLessThanOrEqual(1);
    expect(sim.agent('FOOD').brainCalls).toEqual([]);
  });

  // G17: two agents fit equally; the one that claimed first only pointed to the other.
  it('a reply that points to another agent is a handoff, not an answer (Soho 點心)', async () => {
    const sim = createRoomSim(
      [
        food({ brain: (t) => (/點心|吃/.test(t) ? 'FOOD: Soho 三家點心' : '[NO_REPLY]'), extra: { v2: later } }),
        events({ brain: (t) => (/點心/.test(t) ? '這個問 @FOOD 會更準' : '[NO_REPLY]'), extra: { v2: first } }),
      ],
      HUMANS,
    );
    const q = await sim.say(PIKA, '推薦一家 Soho 的點心');
    await sim.run(120_000);
    expect(sim.answersTo(q)).toContain('FOOD');
    expect(sim.answersTo(q).filter((a) => a === 'FOOD')).toHaveLength(1);
  });
});


// ---------------------------------------------------------------------------------------------
// The brain contract: what every agent's brain is told, whatever its profile says.
// Fake brains below act like a literal model: they do what the prompt they received says, and
// fall back to their profile's habits when the prompt does not say otherwise. So these tests
// fail when the contract stops reaching the brain, not when one phrase changes.
// ---------------------------------------------------------------------------------------------

import { BRAIN_CONTRACT } from '../src/index.js';

/** The envelope text inside an A2A request body. */
function envelopeOf(body: string): string {
  const parsed = JSON.parse(body) as { params?: { message?: { parts?: Array<{ text?: string }> } } };
  return parsed.params?.message?.parts?.[0]?.text ?? '';
}

const RULES = '[Answering rules]';
const asksForOne = (t: string) => /一張|one card|1 card/i.test(t);

/**
 * A tarot agent whose profile says "a weekly reading is three cards" and which always gets the
 * last reading injected. Without the contract it re-serves the old reading or ignores the count.
 */
function tarot(over: Partial<SimAgentDef> = {}): SimAgentDef {
  return {
    spec: spec('@agent-7a507006:matrix.netmind.chat', 'TAROT', 'Three-card AI tarot readings'),
    profile: 'Tarot card readings: draw cards about work, love, this week',
    wakeExamples: ['幫我抽塔羅', '這週運勢抽三張牌', 'draw a tarot card for me'],
    notExamples: [...FOOD_ASKS, ...EVENT_ASKS, ...DATA_ASKS],
    brain: (t, body) => {
      const env = envelopeOf(body);
      const hasRules = env.includes(RULES);
      if (!/塔羅|tarot|牌|card/i.test(t)) return '[NO_REPLY]';
      if (!hasRules && env.includes('last_drawn_tarot_cards')) return 'TAROT: 這題已經解讀過了，要不要繼續看那三張？';
      // Its tool only draws three, so with the rules it says so instead of silently swapping.
      if (hasRules && asksForOne(t)) return 'TAROT: 我用三張牌來讀，這次一樣抽三張 · 星星、聖杯三、權杖十';
      return 'TAROT: 三張牌 · 星星、聖杯三、權杖十';
    },
    extra: {
      buildExtraEnvelopeFields: async () => ({ last_drawn_tarot_cards: 'The Star, Three of Cups, Ten of Wands' }),
    },
    ...over,
  };
}

/** An events agent that does not know tonight's opening hours. Without the evidence rule it says they are open anyway. */
function eventsNoHours(): SimAgentDef {
  return events({
    brain: (t, body) => {
      if (!/玩|活動|市集|things to do/i.test(t)) return '[NO_REPLY]';
      return envelopeOf(body).includes('opening hours')
        ? 'EVENTS: 三個活動 · 今晚營業時間未確認，出發前先看官網'
        : 'EVENTS: 三個活動 · 營業時間不明，但今晚都有開';
    },
  });
}

describe('v2 room: the sender sets the task, the profile only sets defaults', () => {
  it('every agent brain gets the answering rules, and the sender message comes last as the task', async () => {
    const sim = createRoomSim([food(), events(), data(), tarot()], HUMANS);
    for (const ask of ['有好吃的火鍋嗎？', '晚上有什麼好玩的？', '這週末倫敦有什麼 AI 黑客松？', '幫我抽一張塔羅牌看這週工作']) {
      await sim.say(ZACK, ask);
      await sim.run(60_000);
    }
    for (const name of ['FOOD', 'EVENTS', 'DATA', 'TAROT']) {
      const { brainPrompts, brainCalls } = sim.agent(name);
      expect(brainPrompts.length, name).toBeGreaterThan(0);
      for (const [i, body] of brainPrompts.entries()) {
        const env = envelopeOf(body);
        for (const rule of BRAIN_CONTRACT) expect(env, name).toContain(rule);
        // The sender's request is not labelled as untrusted, and it is the last thing the brain reads.
        expect(env).not.toMatch(/message body (?:is|are) untrusted/i);
        expect(env.trimEnd().endsWith(brainCalls[i])).toBe(true);
        expect(env.indexOf(RULES)).toBeLessThan(env.lastIndexOf(brainCalls[i]));
      }
    }
  });

  it('asking for one card when the agent only reads three gets told so, not a silent swap', async () => {
    const sim = createRoomSim([food(), events(), tarot()], HUMANS);
    const q = await sim.say(PIKA, 'Draw one card for my work this week, tarot please');
    await sim.run(60_000);
    expect(sim.answersTo(q)).toEqual(['TAROT']);
    expect(sim.answerTexts(q).join('\n')).toContain('我用三張牌來讀');
  });

  it('a new question after an earlier reading gets a fresh reading, not "already read"', async () => {
    const sim = createRoomSim([food(), events(), tarot()], HUMANS);
    const a = await sim.say(ZACK, '幫我抽塔羅，這週運勢抽三張牌');
    await sim.run(60_000);
    const b = await sim.say(ZACK, '幫我抽一張塔羅牌看這週工作');
    await sim.run(60_000);
    expect(sim.answersTo(a)).toEqual(['TAROT']);
    expect(sim.answersTo(b)).toEqual(['TAROT']);
    const reply = sim.answerTexts(b).join('\n');
    expect(reply).not.toMatch(/已經解讀過|already read/);
    expect(reply).toContain('抽三張');
  });

  it('an agent that does not know tonight\'s hours says so instead of saying places are open', async () => {
    const sim = createRoomSim([food(), eventsNoHours(), data()], HUMANS);
    const q = await sim.say(PIKA, '今晚有什麼好玩的？');
    await sim.run(60_000);
    expect(sim.answersTo(q)).toEqual(['EVENTS']);
    const reply = sim.answerTexts(q).join('\n');
    expect(reply).toContain('未確認');
    expect(reply).not.toContain('都有開');
  });
});

describe('v2 room: a bare follow-up survives someone else talking in between', () => {
  it('"第二個呢" after another member\'s unrelated ask still goes to the agent that listed things', async () => {
    const sim = createRoomSim([food(), events(), data()], HUMANS);
    const a = await sim.say(ZACK, '這週末倫敦有什麼 AI 黑客松？');
    await sim.run(30_000);
    const b = await sim.say(PIKA, '有好吃的火鍋嗎？');
    await sim.run(30_000);
    const c = await sim.say(ZACK, '第二個呢');
    await sim.run(60_000);
    expect(sim.answersTo(a)).toEqual(['DATA']);
    expect(sim.answersTo(b)).toEqual(['FOOD']);
    expect(sim.answersTo(c)).toEqual(['DATA']);
  });
});

// Found in the zack test live run (2026-11-26, pika): Penny reacted 👍 to thanks meant for another agent.
describe('v2 room: emoji acknowledgements come from the agent you talked with', () => {
  it('thanks after an answer: the answering agent reacts, a looking-in agent does not', async () => {
    const thanks = (name: string) => (t: string) => (/謝謝/.test(t) ? '[REACT 👍]' : /玩|快閃|活動/.test(t) && name === 'EVENTS' ? 'EVENTS: 三個活動' : '[NO_REPLY]');
    const sim = createRoomSim([food(), events({ brain: thanks('EVENTS') }), penny({ bill: true }, { brain: thanks('PENNY') })], HUMANS);
    const a = await sim.say(PIKA, '這週末有什麼快閃活動');
    await sim.run(30_000);
    expect(sim.answersTo(a)).toEqual(['EVENTS']);
    const q = await sim.say(PIKA, '謝謝');
    await sim.run(60_000);
    const redacted = new Set(sim.timeline.filter((e) => e.type === 'm.room.redaction').map((e) => e.redacts));
    const reactions = sim.timeline
      .filter((e) => e.type === 'm.reaction' && !redacted.has(e.event_id))
      .filter((e) => (e.content['m.relates_to'] as { event_id: string }).event_id === q)
      .map((e) => `${sim.agent('EVENTS').id === e.sender ? 'EVENTS' : sim.agent('PENNY').id === e.sender ? 'PENNY' : 'OTHER'} ${(e.content['m.relates_to'] as { key: string }).key}`);
    expect(sim.answersTo(q)).toEqual([]);
    expect(reactions).toEqual(['EVENTS 👍']);
    expect(await sim.logOf('PENNY')).not.toMatch(/v2 reacted/);
  });
});
