import { expect, it } from 'vitest';
import { handleStandardMemoryCommand, MemoryStore } from '../src/memory.js';
import type { InboundEvent, RoomContext } from '../src/types.js';
import { createD1 } from './d1.js';

it('keeps explicit notes in their origin group and preserves private and global language preferences', async () => {
  const store = new MemoryStore(createD1(), 'agent');
  await store.ensureSchema();
  const userId = '@zack:x';
  const a = { roomId: '!a:x', userId, chatType: 'group' } as const;
  const b = { ...a, roomId: '!b:x' };
  const dm = { ...a, roomId: '!dm:x', chatType: 'dm' } as const;
  await store.rememberUser({ userId, key: 'note_legacy', value: 'legacy Holborn', originRoomId: a.roomId, originChatType: 'group' });
  await store.rememberUser({ userId, key: 'note_private', value: 'private preference', originRoomId: dm.roomId, originChatType: 'dm' });
  await store.rememberUser({ userId, key: 'lang', value: 'en', originRoomId: a.roomId, originChatType: 'group' });

  async function command(scope: typeof a | typeof b, text: string) {
    const context: RoomContext = { ...scope, members: [], recentHistory: [] };
    await handleStandardMemoryCommand({
      store,
      context,
      event: { text, senderId: userId, roomId: scope.roomId } as InboundEvent,
      decision: { shouldReply: true, tier: 0, confidence: 1, shouldQuote: false, reason: 'explicit_mention', detectedLang: 'en' },
      memories: await store.recallForTurn(scope),
      spec: { id: 'agent', name: 'Agent', domainDescription: 'Test agent' },
    });
  }

  await command(a, 'Remember: I prefer Holborn');
  await command(b, 'Remember: I prefer Holborn');
  const values = async (scope: typeof a | typeof b | typeof dm) =>
    (await store.recallForTurn(scope)).userMemories.map(({ value }) => value).sort();

  expect(await values(a)).toEqual(['I prefer Holborn', 'en', 'legacy Holborn']);
  expect(await values(b)).toEqual(['I prefer Holborn', 'en']);
  expect(await values(dm)).toEqual(['en', 'private preference']);
  expect((await store.recallForTurn({ ...a, userId: '@peer:x' })).userMemories).toEqual([]);

  await command(b, 'Forget about Holborn');
  expect(await values(a)).toEqual(['I prefer Holborn', 'en', 'legacy Holborn']);
  expect(await values(b)).toEqual(['en']);
});
