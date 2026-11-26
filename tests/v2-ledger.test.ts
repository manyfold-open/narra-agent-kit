import { describe, expect, it } from 'vitest';
import {
  CLAIM_REACTION,
  CLAIM_RETRY_REASON,
  applyClaimReaction,
  applyClaimRedaction,
  claimsOn,
  emptyRoomState,
  openQuestion,
  peerClaimHolder,
} from '../src/v2/ledger.js';
import { claimPriority } from '../src/v2/gate.js';
import type { HistoryTurn, InboundEvent } from '../src/types.js';

const T0 = Date.UTC(2026, 10, 26, 14, 31, 0);
const FS = '@agent-bc3282c7:matrix.netmind.chat';
const PENNY = '@agent-54ebea3a:matrix.netmind.chat';
const DEMI = '@sp-demi:matrix.netmind.chat';
const PIKA = '@sp-pika:matrix.netmind.chat';

const human = (eventId: string, senderId: string, text: string, at: number): HistoryTurn => ({ eventId, senderId, text, timestampMs: at, isAgent: false });
const agent = (eventId: string, senderId: string, text: string, at: number, answers?: string): HistoryTurn => ({
  eventId,
  senderId,
  text,
  timestampMs: at,
  isAgent: true,
  ...(answers ? { answersEventId: answers } : {}),
});

describe('openQuestion', () => {
  const asked = [
    human('$q', DEMI, '@AI Fortune Stick 你可以给我抽一个签吗', T0),
    agent('$a', FS, '可以的。你想问的是什么事？工作、感情、某个决定都行，用一句话告诉我，我们再来摇签。', T0 + 20_000, '$q'),
  ];

  it('is the latest agent message that asks something, answerable by anyone', () => {
    const now = T0 + 13 * 60_000;
    const history = [...asked, human('$w', PIKA, '工作', now)];
    expect(openQuestion(history, now, '$w')).toMatchObject({ agentId: FS, askedTo: DEMI, eventId: '$a' });
  });

  it('closes after the window, after the agent speaks again, or after several human messages', () => {
    expect(openQuestion(asked, T0 + 16 * 60_000)).toBeUndefined();
    const answered = [...asked, human('$w', PIKA, '工作', T0 + 60_000), agent('$d', FS, '第 13 签 · 工作', T0 + 70_000, '$w')];
    expect(openQuestion(answered, T0 + 80_000)).toBeUndefined();
    const chatty = [...asked, ...[1, 2, 3, 4].map((i) => human(`$c${i}`, PIKA, `聊 ${i}`, T0 + i * 10_000))];
    expect(openQuestion(chatty, T0 + 60_000)).toBeUndefined();
  });

  it('ignores question marks inside links', () => {
    const history = [agent('$l', FS, '看這裡 https://x.test/a?b=1', T0)];
    expect(openQuestion(history, T0 + 1_000)).toBeUndefined();
  });
});

describe('ranked claims', () => {
  const claim = (eventId: string, senderId: string, at: number, priority?: number): InboundEvent =>
    ({
      roomId: '!r',
      chatType: 'group',
      eventId,
      senderId,
      type: 'm.reaction',
      kind: 'reaction',
      text: CLAIM_REACTION,
      timestampMs: at,
      timeIso: '',
      mentions: [],
      replyToEventId: '$m',
      reactionKey: CLAIM_REACTION,
      ...(priority !== undefined ? { claimPriority: priority } : {}),
    }) as InboundEvent;

  it('a weaker claim made first does not hold back a better fit', () => {
    const state = emptyRoomState();
    applyClaimReaction(state, claim('$p', PENNY, T0, claimPriority({ reason: 'relevant', score: 0.73, direct: false })), FS);
    const mine = claimPriority({ reason: 'relevant', score: 1, direct: false });
    expect(peerClaimHolder(state, ['$m'], FS, T0 + 1_000, mine)).toBeUndefined();
    // ...and once the better fit claimed, the weaker one sees it is outranked.
    applyClaimReaction(state, claim('$f', FS, T0 + 1_500, mine), PENNY);
    expect(peerClaimHolder(state, ['$m'], PENNY, T0 + 2_000, 1.73, T0)).toBe(FS);
  });

  it('equal claims go to the earlier one; legacy claims (no priority) always hold', () => {
    const state = emptyRoomState();
    applyClaimReaction(state, claim('$p', PENNY, T0, 2), FS);
    expect(peerClaimHolder(state, ['$m'], FS, T0 + 1_000, 2)).toBe(PENNY);
    expect(peerClaimHolder(state, ['$m'], FS, T0 + 1_000, 2, T0 - 1)).toBeUndefined();
    const legacy = emptyRoomState();
    applyClaimReaction(legacy, claim('$p', PENNY, T0), FS);
    expect(peerClaimHolder(legacy, ['$m'], FS, T0 + 1_000, 5)).toBe(PENNY);
  });

  it('a claim released to retry does not count as "chose not to answer"', () => {
    const state = emptyRoomState();
    applyClaimReaction(state, claim('$p', PENNY, T0, 1.7), FS);
    applyClaimRedaction(state, '$p', CLAIM_RETRY_REASON);
    expect(claimsOn(state, '$m')).toEqual([]);
    expect(state.released?.['$m']).toBeUndefined();
    applyClaimReaction(state, claim('$p2', PENNY, T0 + 30_000, 1.7), FS);
    applyClaimRedaction(state, '$p2');
    expect(state.released?.['$m']).toBe(1);
  });

  it('reads state saved by the previous kit (one claim per message)', () => {
    const state = { claims: { $m: { agentId: PENNY, atMs: T0, reactionEventId: '$p' } }, claimReactions: { $p: '$m' } };
    expect(peerClaimHolder(state, ['$m'], FS, T0 + 1_000, 2)).toBe(PENNY);
    applyClaimRedaction(state, '$p');
    expect(claimsOn(state, '$m')).toEqual([]);
  });
});
