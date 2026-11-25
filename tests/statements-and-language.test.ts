import { describe, expect, it, vi } from 'vitest';
import { detectForeignLanguage, routeEvent, type AgentSpec, type InboundEvent, type RoomContext, type TriageModel } from '../src/index.js';

describe('detectForeignLanguage', () => {
  it.each([
    ['明日の夜、ロンドンで何か食べたいな', 'ja'],
    ['오늘 저녁 뭐 먹을까', 'ko'],
    ['Что делать сегодня вечером?', 'ru'],
    ['¿Hay alguna noticia de IA hoy?', 'es'],
    ['Was kann ich heute Abend in London machen?', 'de'],
    ['Wat kunnen we vanavond doen?', 'nl'],
    ["Qu'est-ce qu'on peut faire ce soir à Londres ?", 'fr'],
  ])('"%s" is %s', (text, code) => {
    expect(detectForeignLanguage(text)).toBe(code);
  });

  it.each(['明天下班出去玩吗，可以去哪儿玩', '晚上有啥可以吃', 'What can we do tonight in London?', 'any news?', 'Soho dim sum?', '好'])(
    'leaves Chinese and English alone: "%s"',
    (text) => {
      expect(detectForeignLanguage(text)).toBeNull();
    },
  );
});

describe('statements inside an active session (ask-aware triage)', () => {
  const NOW = 1_790_000_000_000;
  const spec: AgentSpec = {
    id: 'agt_food',
    matrixId: '@agent-b2b526f3:matrix.netmind.chat',
    name: 'London Chinese Food',
    domainDescription: 'London Chinese restaurants',
    domainKeywords: ['火鍋', 'hotpot'],
    antiKeywords: [],
  } as AgentSpec;
  const event = (text: string): InboundEvent => ({
    roomId: '!g:x',
    chatType: 'group',
    eventId: `$e_${text.length}`,
    senderId: '@zack:x',
    senderName: 'Zack',
    type: 'm.room.message',
    kind: 'text',
    msgtype: 'm.text',
    timestampMs: NOW,
    timeIso: new Date(NOW).toISOString(),
    mentions: [],
    text,
  });
  const context = {
    roomId: '!g:x',
    chatType: 'group',
    members: [],
    recentHistory: [],
    activeSession: { active: true, expiresAtMs: NOW + 60_000 },
  } as unknown as RoomContext;
  const model = (ask: boolean, askAware = true): TriageModel => ({
    askAware,
    score: vi.fn(async () => ({ score: ask ? 0.8 : 0.02, ask, reason: ask ? 'ask:more' : 'not_ask:plans_made' })),
  });

  it('does not answer again when the model says it is a statement (我等等要去吃火鍋)', async () => {
    const d = await routeEvent(event('我等等要去吃火鍋'), context, spec, { nowMs: NOW, triageModel: model(false) });
    expect(d).toMatchObject({ shouldReply: false, reason: 'active_session_not_ask', isAsk: false });
  });

  it('answers a new question in its own domain mid-session even without a keyword (Covent Garden tonight)', async () => {
    const roomWithPeer = {
      ...context,
      members: [{ matrixId: '@agent-3add8bb6:matrix.netmind.chat', displayName: 'AI in 5', isAgent: true }],
    } as unknown as RoomContext;
    const d = await routeEvent(event('Is there anything fun near Covent Garden tonight?'), roomWithPeer, spec, {
      nowMs: NOW,
      triageModel: model(true),
    });
    expect(d).toMatchObject({ shouldReply: true, reason: 'active_session' });
    const chatter = await routeEvent(event('haha nice one'), roomWithPeer, spec, { nowMs: NOW, triageModel: model(false) });
    expect(chatter.shouldReply).toBe(false);
  });

  it('still answers a follow-up question in the session', async () => {
    const d = await routeEvent(event('還有別家火鍋嗎'), context, spec, { nowMs: NOW, triageModel: model(true) });
    expect(d).toMatchObject({ shouldReply: true, reason: 'active_session' });
  });

  it('leaves a question on another agent\'s topic to that agent, in any language', async () => {
    const offTopic: TriageModel = { askAware: true, score: vi.fn(async () => ({ score: 0.1, ask: true, reason: 'ask:food' })) };
    const d = await routeEvent(event('今夜ロンドンでおすすめの中華料理はある？'), context, spec, { nowMs: NOW, triageModel: offTopic });
    expect(d).toMatchObject({ shouldReply: false, reason: 'active_session_other_topic', isAsk: true });
  });

  it('keeps the old behavior with a keyword-gated (not ask-aware) model', async () => {
    const m = model(false, false);
    const d = await routeEvent(event('我等等要去吃火鍋'), context, spec, { nowMs: NOW, triageModel: m });
    expect(d).toMatchObject({ shouldReply: true, reason: 'active_session' });
    expect(m.score).not.toHaveBeenCalled();
  });
});
