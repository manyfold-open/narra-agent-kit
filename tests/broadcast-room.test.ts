import { describe, expect, it } from 'vitest';
import {
  InMemoryBroadcastStore,
  ProactiveBroadcastScheduler,
  roomLanguage,
  type AgentUpdateItem,
  type HistoryTurn,
} from '../src/index.js';

const turn = (text: string, i: number, isAgent = false): HistoryTurn => ({
  eventId: `$${i}`,
  senderId: isAgent ? '@agent-3add8bb6:x' : '@sp-zack:x',
  isAgent,
  text,
  timestampMs: i,
});

describe('roomLanguage', () => {
  it('follows what people in the room write, not the agents', () => {
    const h = [
      turn('週末可以去哪玩', 1),
      turn('有啥新聞嗎今天', 2),
      turn('AI in 5 No. 39: Google DeepMind launches', 3, true),
      turn('Holborn', 4),
    ];
    expect(roomLanguage(h)).toBe('zh-Hant');
    expect(roomLanguage([turn('Here is the digest', 1, true)])).toBeNull();
  });
});

describe('digests in the room language, without repeats', () => {
  const run = async (store: InMemoryBroadcastStore, keys: string[], history: HistoryTurn[]) => {
    const sent: string[] = [];
    const item: AgentUpdateItem = {
      updateKey: `popups:${keys.join(',')}`,
      roomId: '!london:x',
      text: 'Newly verified upcoming pop-ups',
      lang: 'en',
      itemKeys: keys,
      render: (lang, fresh) => `${lang}:${fresh.join(',')}`,
    };
    const scheduler = new ProactiveBroadcastScheduler({
      agentId: 'spotted',
      dedupeStore: store,
      getRecentHistory: () => history,
      send: async (_i, text) => {
        sent.push(text);
      },
    });
    const res = await scheduler.run([item]);
    return { sent, res };
  };

  it('posts in Chinese to a Chinese room and never repeats a pop-up the room already saw', async () => {
    const store = new InMemoryBroadcastStore();
    const history = [turn('这个周末有什么活动', 1), turn('离公司近吗', 2)];
    expect((await run(store, ['gta6', 'canopy'], history)).sent).toEqual(['zh-Hans:gta6,canopy']);
    // Next day the list changes order and adds one: only the new one goes out.
    expect((await run(store, ['canopy', 'gta6', 'chippie'], history)).sent).toEqual(['zh-Hans:chippie']);
    const again = await run(store, ['gta6', 'chippie'], history);
    expect(again.sent).toEqual([]);
    expect(again.res.skipped[0]?.reason).toBe('duplicate_items');
  });

  it('falls back to the item language when nobody has written yet', async () => {
    expect((await run(new InMemoryBroadcastStore(), ['a'], [])).sent).toEqual(['en:a']);
  });
});
