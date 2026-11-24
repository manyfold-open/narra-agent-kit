import { describe, expect, it, vi } from 'vitest';
import { createAskTriageModel, routeEvent, type AgentSpec, type InboundEvent, type RoomContext } from '../src/index.js';

const NOW = 1_790_000_000_000;
const event = (text: string): InboundEvent => ({
  roomId: '!g:matrix.netmind.chat',
  chatType: 'group',
  eventId: `$e_${Math.random().toString(36).slice(2, 8)}`,
  senderId: '@cassie:matrix.netmind.chat',
  senderName: 'Cassie',
  type: 'm.room.message',
  kind: 'text',
  msgtype: 'm.text',
  timestampMs: NOW,
  timeIso: new Date(NOW).toISOString(),
  mentions: [],
  text,
});
const context: RoomContext = {
  roomId: '!g:matrix.netmind.chat',
  chatType: 'group',
  members: [
    { matrixId: '@agent-3add8bb6:matrix.netmind.chat', displayName: 'AI in 5', isAgent: true },
    { matrixId: '@agent-b2b526f3:matrix.netmind.chat', displayName: 'London Chinese Food', isAgent: true },
  ],
  recentHistory: [],
} as RoomContext;
const spec: AgentSpec = {
  id: 'agt_spotted',
  matrixId: '@agent-f9388b28:matrix.netmind.chat',
  name: 'Spotted London',
  domainDescription: 'London pop-ups, markets, exhibitions and things to do',
  domainKeywords: [],
  antiKeywords: [],
} as AgentSpec;
const verdict = (json: string) => ({ response: json });

describe('createAskTriageModel', () => {
  it.each(['👍', '...', '😂😂', '  '])('drops content-free "%s" without a model call', async (text) => {
    const run = vi.fn();
    expect(await createAskTriageModel({ run }).score({ event: event(text), context, spec, detectedLang: 'en' })).toMatchObject({
      score: 0,
      ask: false,
      reason: 'no_content',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['可以去哪儿玩', '明日どこに行く？', '¿Qué hacemos esta noche?', 'Wat kunnen we vanavond doen?', '好餓'])(
    'asks the model about "%s" whatever the language, with the room\'s agents in the prompt',
    async (text) => {
      const run = vi.fn(async () => verdict('{"ask":true,"fit":0.82,"reason":"things_to_do"}'));
      const res = await createAskTriageModel({ run }).score({ event: event(text), context, spec, detectedLang: 'en' });
      expect(res).toEqual({ score: 0.82, ask: true, reason: 'ask:things_to_do' });
      const prompt = JSON.stringify(run.mock.calls[0]);
      expect(prompt).toContain('AI in 5');
      expect(prompt).toContain('London Chinese Food');
      expect(prompt).toContain(text);
    },
  );

  it('keeps statements and acknowledgements near zero and marks them as not an ask', async () => {
    const run = vi.fn(async () => verdict('{"ask":false,"fit":0.7,"reason":"already_decided"}'));
    expect(await createAskTriageModel({ run }).score({ event: event('我等等要去吃'), context, spec, detectedLang: 'zh-Hant' })).toEqual({
      score: 0.05,
      ask: false,
      reason: 'not_ask:already_decided',
    });
  });

  it('retries once after a failure before falling back', async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('upstream');
      return verdict('```json\n{"ask": "true", "fit": "0.9", "reason": "plans"}\n```');
    });
    expect(await createAskTriageModel({ run }).score({ event: event('what can we do tomorrow?'), context, spec, detectedLang: 'en' })).toEqual({
      score: 0.9,
      ask: true,
      reason: 'ask:plans',
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('falls back to the heuristic (and no ask flag) when the model never answers usefully', async () => {
    const run = vi.fn(async () => verdict('sorry, I cannot help'));
    const res = await createAskTriageModel({ run }, { retries: 1 }).score({ event: event('any plans?'), context, spec, detectedLang: 'en' });
    expect(res.reason).toBe('ask_triage_unavailable');
    expect(res.ask).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('times out a slow model call without leaving a timer behind', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(() => new Promise<never>(() => undefined));
      const pending = createAskTriageModel({ run }, { timeoutMs: 1_000, retries: 0 }).score({
        event: event('any plans?'),
        context,
        spec,
        detectedLang: 'en',
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await pending).reason).toBe('ask_triage_unavailable');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routeEvent carries the ask flag on both reply and silence decisions', async () => {
    const opts = (json: string) => ({ nowMs: NOW, triageModel: createAskTriageModel({ run: async () => verdict(json) }) });
    const mine = await routeEvent(event('可以去哪儿玩'), context, spec, opts('{"ask":true,"fit":0.85,"reason":"plans"}'));
    expect(mine).toMatchObject({ shouldReply: true, isAsk: true });
    const notMine = await routeEvent(event('有啥新聞'), context, spec, opts('{"ask":true,"fit":0.1,"reason":"news"}'));
    expect(notMine).toMatchObject({ shouldReply: false, isAsk: true });
    const chatter = await routeEvent(event('哈哈哈'), context, spec, opts('{"ask":false,"fit":0,"reason":"laugh"}'));
    expect(chatter).toMatchObject({ shouldReply: false, isAsk: false });
  });
});
