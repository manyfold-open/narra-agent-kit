import { describe, expect, it, vi } from 'vitest';
import { createWorkersAiTriageModel, type AgentSpec, type InboundEvent, type RoomContext } from '../src/index.js';

const BASE = 1_790_000_000_000;
const event = (text: string): InboundEvent => ({
  roomId: '!grp:matrix.netmind.chat',
  roomName: 'zack test',
  chatType: 'group',
  eventId: `$ev_${Math.random().toString(36).slice(2, 10)}`,
  senderId: '@sp-zack:matrix.netmind.chat',
  senderName: 'Zack',
  type: 'm.room.message',
  kind: 'text',
  msgtype: 'm.text',
  timestampMs: BASE,
  timeIso: new Date(BASE).toISOString(),
  mentions: [],
  text,
});
const ctx = { chatType: 'group', members: [], peers: [], recentHistory: [] } as unknown as RoomContext;
const spec: AgentSpec = {
  id: 'agt_news',
  matrixId: '@agent-3add8bb6:matrix.netmind.chat',
  name: 'AI News',
  domainDescription: 'Daily AI news briefing',
  domainKeywords: ['AI 新聞', 'model release'],
  antiKeywords: [],
} as AgentSpec;

describe('colloquial asks reach the domain check (zack test group, 2026-11-24)', () => {
  // Each of these was dropped by every agent as triage_no_need_cue before.
  it.each(['有啥新聞可以看', '有啥新聞啊', '晚上可以幹嘛', '晚上有啥可以吃', '有啥可以吃', '有啥中餐好吃'])(
    '"%s" is asked to the model instead of being dropped as chatter',
    async (text) => {
      const run = vi.fn(async () => ({ response: '{"score":0.8,"reason":"asked"}' }));
      const res = await createWorkersAiTriageModel({ run }).score({ event: event(text), context: ctx, spec, detectedLang: 'zh-Hant' });
      expect(res.reason).not.toBe('triage_no_need_cue');
      expect(res.reason).not.toBe('triage_too_short');
    },
  );

  it.each([
    ['哈嘍', 'triage_too_short'],
    ['好', 'triage_too_short'],
    ['晚點七點地鐵站見喔', 'triage_no_need_cue'],
  ])('still leaves plain chatter "%s" alone (%s)', async (text, reason) => {
    const run = vi.fn(async () => ({ response: '{"score":0.9,"reason":"x"}' }));
    const res = await createWorkersAiTriageModel({ run }).score({ event: event(text), context: ctx, spec, detectedLang: 'zh-Hant' });
    expect(res.reason).toBe(reason);
    expect(run).not.toHaveBeenCalled();
  });
});
