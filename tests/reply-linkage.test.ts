import { describe, expect, it } from 'vitest';
import {
  hasPeerAnsweredTimeline,
  messageContent,
  parseMatrixEvent,
  peerSessionWithSender,
  routeEvent,
  type AgentSpec,
  type InboundEvent,
  type RoomContext,
  type TimelineTurn,
} from '../src/index.js';

const NOW = 1_795_600_000_000;
const ZACK = '@sp-zack:matrix.netmind.chat';
const SPOTTED = '@agent-f9388b28:matrix.netmind.chat';
const NEWS = '@agent-3add8bb6:matrix.netmind.chat';
const TAROT = '@agent-852feddf:matrix.netmind.chat';

const ev = (eventId: string, text: string, ts: number, extra: Partial<InboundEvent> = {}): InboundEvent => ({
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

describe('reply markers on kit agents\' messages', () => {
  it('round-trips ai.narra.answers and ai.narra.broadcast through the event parser', () => {
    const answer = parseMatrixEvent({
      room_id: '!g:x',
      event_id: '$a',
      sender: SPOTTED,
      type: 'm.room.message',
      content: messageContent('這週末倫敦有這些可以去', { answersEventId: '$weekend' }),
    });
    expect(answer?.answersEventId).toBe('$weekend');
    const digest = parseMatrixEvent({
      room_id: '!g:x',
      event_id: '$d',
      sender: NEWS,
      type: 'm.room.message',
      content: messageContent('AI in 5 No. 39', { broadcast: true }),
    });
    expect(digest?.isBroadcast).toBe(true);
    expect(digest?.answersEventId).toBeUndefined();
  });

  it('an unquoted answer to the previous question does not count as answering the next one (有啥新聞嗎今天)', () => {
    // 17:53:42 週末能幹嘛 -> Spotted answers it unquoted at 17:53:47, the same second Zack asks about news.
    const news = ev('$news', '有啥新聞嗎今天', NOW + 5_000);
    const timeline: TimelineTurn[] = [
      { eventId: '$weekend', senderId: ZACK, timestampMs: NOW },
      { eventId: '$news', senderId: ZACK, timestampMs: NOW + 5_000 },
      { eventId: '$spot', senderId: SPOTTED, isAgent: true, timestampMs: NOW + 5_300, answersEventId: '$weekend' },
    ];
    expect(hasPeerAnsweredTimeline(news, timeline, NEWS)).toBe(false);
    // Without the marker the old heuristic still treats it as answered.
    const unmarked = timeline.map((t) => ({ ...t, answersEventId: undefined }));
    expect(hasPeerAnsweredTimeline(news, unmarked, NEWS)).toBe(true);
  });

  it('a marked answer to this question counts even after a later human message', () => {
    const q = ev('$q', '晚上可以去哪玩', NOW);
    const timeline: TimelineTurn[] = [
      { eventId: '$q', senderId: ZACK, timestampMs: NOW },
      { eventId: '$h2', senderId: ZACK, timestampMs: NOW + 1_000 },
      { eventId: '$spot', senderId: SPOTTED, isAgent: true, timestampMs: NOW + 2_000, answersEventId: '$q' },
    ];
    expect(hasPeerAnsweredTimeline(q, timeline, NEWS)).toBe(true);
  });

  it('a digest never counts as an answer', () => {
    const q = ev('$q', '為啥不回答 明天晚上能去哪裡玩', NOW);
    const timeline: TimelineTurn[] = [
      { eventId: '$q', senderId: ZACK, timestampMs: NOW },
      { eventId: '$digest', senderId: NEWS, isAgent: true, timestampMs: NOW + 45_000, isBroadcast: true },
    ];
    expect(hasPeerAnsweredTimeline(q, timeline, SPOTTED)).toBe(false);
  });
});

describe('peerSessionWithSender (elected fallback stays out of another agent\'s exchange)', () => {
  it('is true for a follow-up seconds after a peer answered the same sender', () => {
    // 10:12:26 记得有什么market -> Spotted 10:12:32 -> 10:12:38 他中午都会有圣诞的东西
    const timeline: TimelineTurn[] = [
      { eventId: '$market', senderId: ZACK, timestampMs: NOW },
      { eventId: '$bubble', senderId: SPOTTED, isAgent: true, timestampMs: NOW + 6_000, answersEventId: '$market' },
    ];
    expect(peerSessionWithSender(ev('$xmas', '他中午都会有圣诞的东西', NOW + 12_000), timeline, TAROT)).toBe(true);
  });

  it('is false when the peer answered someone else, long ago, or only posted a digest', () => {
    const other = '@sp-cassie:matrix.netmind.chat';
    const q = ev('$q', '有什么推荐', NOW + 12_000);
    expect(
      peerSessionWithSender(q, [
        { eventId: '$c', senderId: other, timestampMs: NOW },
        { eventId: '$a', senderId: SPOTTED, isAgent: true, timestampMs: NOW + 6_000, answersEventId: '$c' },
      ], TAROT),
    ).toBe(false);
    expect(
      peerSessionWithSender(ev('$late', '有什么推荐', NOW + 200_000), [
        { eventId: '$z', senderId: ZACK, timestampMs: NOW },
        { eventId: '$a', senderId: SPOTTED, isAgent: true, timestampMs: NOW + 6_000, answersEventId: '$z' },
      ], TAROT),
    ).toBe(false);
    expect(
      peerSessionWithSender(q, [
        { eventId: '$z', senderId: ZACK, timestampMs: NOW },
        { eventId: '$d', senderId: NEWS, isAgent: true, timestampMs: NOW + 6_000, isBroadcast: true },
      ], TAROT),
    ).toBe(false);
  });
});

describe('reactions in groups', () => {
  const spec = {
    id: 'agt_news',
    matrixId: NEWS,
    name: 'AI in 5',
    domainDescription: 'AI news',
    domainKeywords: ['AI'],
    antiKeywords: [],
  } as AgentSpec;
  const reaction = (chatType: 'group' | 'dm') =>
    ev('$r', '😂', NOW, { kind: 'reaction', chatType, reactionKey: '😂', replyToEventId: '$bot' });
  const ctx = (chatType: 'group' | 'dm') =>
    ({
      roomId: '!g:x',
      chatType,
      members: [],
      recentHistory: [],
      replyToTarget: { eventId: '$bot', senderId: NEWS, isSelf: true, isAgent: true },
    }) as unknown as RoomContext;

  it('does not answer an emoji reaction on its own message in a group', async () => {
    const d = await routeEvent(reaction('group'), ctx('group'), spec, { nowMs: NOW });
    expect(d).toMatchObject({ shouldReply: false, reason: 'reaction_in_group' });
  });

  it('still may answer one in a DM', async () => {
    const d = await routeEvent(reaction('dm'), ctx('dm'), spec, { nowMs: NOW });
    expect(d.reason).not.toBe('reaction_in_group');
    expect(d.reason).not.toBe('reaction_not_for_self');
  });
});
