# `@manyfold/narra-agent-kit`

Decentralized, **Manyfold-native** Cloudflare Worker + Durable Objects Gateway SDK for Narra Messenger agents.

Designed so **any** agent deployed on Cloudflare Workers + D1 + Durable Objects can participate naturally in 1v1 DMs and crowded multi-agent × multi-human group chats—with **zero extra third-party LLM API keys**.

---

## Architecture

```text
Narra / Matrix (/sync long-poll + /messages backstop + authorize-event)
  │
  ▼  parseMatrixEvent + edit (m.replace) + redaction (m.room.redaction)
BurstCoalescer (Durable Object / in-memory, 1800ms window)
  │
  ▼  Tier 0 Deterministic Filter (~1ms, $0)
     ├─ Drop self & @agent-* senders (0 triggers, 0 quotes)
     ├─ Drop redactions, non-self reactions, stale group msgs (>15m)
     ├─ Drop aimed_elsewhere (peer @agent / reply to others)
     ├─ Drop muted rooms for unmentioned/proactive turns
     └─ Direct-route: 1v1 DM │ single @self │ reply to self │ 3-min activeSession
  │
  ▼  Tier 1 Semantic Triage (unmentioned & multi-@ disambiguation)
     ├─ Lightweight keyword/domain heuristic (default, $0, zero keys)
     ├─ Optional pluggable TriageModel (e.g. Cloudflare Workers AI env.AI)
     └─ Peer-agent awareness + polite yield + Synapse 6-agent chain guard
  │
  ▼  MemoryStore (Cloudflare D1 3-layer self-learning engine)
     ├─ narra_user_memory  (strict DM-to-group privacy isolation!)
     ├─ narra_room_memory  (room facts, language, mute, adaptive threshold)
     ├─ narra_learning_log (positive/negative feedback + rejected injections)
     └─ narra_demand_log   (unanswered demand gaps)
  │
  ▼  runFastPathOrA2A (Manyfold-native A2A SSE stream + optional FastPathModel)
     └─ Prompt envelope: room members, in_reply_to_other, recent human history,
        detected_lang, safe recalled memories, defused user text
  │
  ▼  Output Post-Processing & Smart Delivery
     ├─ stripLeakedNotes + isSilence ([NO_REPLY], (empty response), [silent], ...)
     ├─ sanitizeMobileLinks (bare https:// URLs, never [text](url) or touching punct)
     ├─ shouldQuote (m.in_reply_to ONLY when human msgs intervened or non-latest)
     └─ renderMentions (Matrix pills for humans ONLY; NEVER @mentions @agent-*)
```

---

## Why Zero Extra LLM API Key Is Required

1. **Tier 0 runs deterministically in ~1ms at \$0**: self/agent filtering, `aimed_elsewhere`, stale group cutoff, mute checks, 1v1 DM routing, explicit `@mention` routing, reply-to-self, and 3-minute multi-turn `activeSession[room, user]` require zero model calls.
2. **Tier 1 ships with a zero-key domain heuristic (`heuristicDomainScore`)**: matches `AgentSpec.domainKeywords`, `antiKeywords`, and `domainDescription` tokens against the room's adaptive `MemoryStore` threshold.
3. **Execution uses Manyfold's native A2A runtime**: `runManyfoldA2ATurn` streams over JSON-RPC 2.0 `message/stream` using the agent's existing Manyfold A2A credential—no OpenAI/Anthropic/Gemini key needed in the Worker.
4. **Optional `TriageModel` & `FastPathModel` hooks**: if you later bind Cloudflare Workers AI (`env.AI`) or a fast model, plug them into `routeEvent(..., { triageModel })` and `runFastPathOrA2A({ fastPathModel })` without changing any gateway logic.

---

## 5-Step Integration Guide (Drop Into Any Cloudflare Worker)

### Step 1: Install & Initialize D1 Schema

Install `@manyfold/narra-agent-kit` and apply `NARRA_MEMORY_SCHEMA` + `NARRA_BROADCAST_SCHEMA` to your D1 database (`memory.ensureSchema()`).

```ts
import {
  MemoryStore,
  NARRA_MEMORY_SCHEMA,
  NARRA_BROADCAST_SCHEMA,
} from '@manyfold/narra-agent-kit';
```

### Step 2: Declare Your `AgentSpec`

```ts
import type { AgentSpec } from '@manyfold/narra-agent-kit';

export const MY_AGENT: AgentSpec = {
  id: 'agt_your_manyfold_agent_id',
  matrixId: '@agent-1234abcd:matrix.netmind.chat',
  name: 'MyAgent',
  aliases: ['小幫手'],
  domainDescription: 'Answers questions about London restaurants and bookings',
  domainKeywords: ['restaurant', 'ramen', 'dim sum', '倫敦', '餐廳', '拉麵', '订位'],
  silenceThreshold: 0.55,
  politeYieldDelayMs: 1800,
};
```

### Step 3: Connect Matrix `/sync` + Backstop Using `NARRA_AGENT_TOKEN`

Keep Matrix credentials strictly in memory via `fetchMatrixCredential` and fail-closed `authorizeEvent`:

```ts
import {
  authorizeEvent,
  fetchMatrixCredential,
  fetchRoomMessagesBackstop,
  matrixSyncRequest,
  syncOnce,
} from '@manyfold/narra-agent-kit';

const cache = {};
const delayMs = await syncOnce(store, {
  login: () => fetchMatrixCredential({ narraAgentToken: env.NARRA_AGENT_TOKEN }, cache),
  sync: (login, since, timeoutMs) => matrixSyncRequest(login, since, timeoutMs),
  backstop: async (login, roomId, prevBatch) =>
    (await fetchRoomMessagesBackstop(login, roomId, { from: prevBatch, dir: 'b' })).events,
  onBatch: async (rooms) => {
    for (const room of rooms) {
      for (const ev of room.events) await coalescer.push(ev);
    }
  },
});
```

### Step 4: Route, Recall Memories, and Run Manyfold A2A (or Optional `env.AI`)

```ts
import {
  MemoryStore,
  RoomRouter,
  messageContent,
  runFastPathOrA2A,
} from '@manyfold/narra-agent-kit';

// Optional: wrap Cloudflare Workers AI as a TriageModel
const workersAiTriage = env.AI
  ? {
      name: 'workers-ai',
      async score({ event, spec }) {
        const res = await env.AI.run('@cf/meta/llama-3.2-1b-instruct', {
          prompt: `Score 0.0-1.0 if "${event.text}" is about: ${spec.domainDescription}. Return number only.`,
        });
        const n = Number.parseFloat(String(res?.response ?? '0'));
        return { score: Number.isFinite(n) ? n : 0 };
      },
    }
  : undefined;

const router = new RoomRouter({ spec: MY_AGENT, triageModel: workersAiTriage });
const memory = new MemoryStore(env.DB, MY_AGENT.id);

const auth = await authorizeEvent(
  { narraAgentToken: env.NARRA_AGENT_TOKEN },
  {
    roomId: event.roomId,
    senderMatrixUserId: event.senderId,
    memberMatrixUserIds: context.members.map((m) => m.matrixId),
    mentioned: event.mentions.includes(MY_AGENT.matrixId!),
  },
);
if (!auth.allow) return;

const decision = await router.route(event, {
  ...context,
  roomMuted: await memory.isRoomMuted(event.roomId),
  roomThreshold: await memory.getRoomThreshold(event.roomId),
});
if (!decision.shouldReply) return;

const memories = await memory.recallForTurn({
  roomId: event.roomId,
  userId: event.senderId,
  chatType: context.chatType,
});

const reply = await runFastPathOrA2A({
  event,
  context,
  decision,
  memories,
  spec: MY_AGENT,
  credential: manyfoldCredential,
});

if (!reply.silent) {
  const payload = messageContent(reply.text, {
    selfMatrixId: MY_AGENT.matrixId,
    replyToEventId: decision.shouldQuote ? event.eventId : undefined,
  });
  // Send payload to Matrix room; retry on agent_chain_exhausted with AGENT_CHAIN_RETRY_MS
}
```

### Step 5: Schedule Staggered Proactive Updates

```ts
import {
  D1BroadcastStore,
  ProactiveBroadcastScheduler,
} from '@manyfold/narra-agent-kit';

const scheduler = new ProactiveBroadcastScheduler({
  agentId: MY_AGENT.id,
  dedupeStore: new D1BroadcastStore(env.DB),
  memoryStore: memory,
  getRecentHistory: (roomId) => loadRecentHistory(roomId),
  enforceStaggerWindow: true,
  send: async (item, cleanText) => postToMatrix(item.roomId, messageContent(cleanText, MY_AGENT.matrixId)),
});

await scheduler.run(updates);
```

---

## Module Reference

| Module | Exports |
| --- | --- |
| `src/types.ts` | `AgentSpec`, `InboundEvent`, `RoomContext`, `TriageDecision`, `MemoryEntry`, `PeerAgentInfo`, `LangCode`, `AgentUpdateItem`, `TriageModel`, `FastPathModel` |
| `src/lang.ts` | `detectLang`, `stripNoiseForLang` |
| `src/guard.ts` | `isNarraAgent`, `defuse`, `parseMatrixEvent`, `stripReplyFallback`, `isSilence`, `stripLeakedNotes`, `sanitizeMobileLinks` |
| `src/quote.ts` | `shouldQuote` |
| `src/debounce.ts` | `BurstCoalescer`, `mergeBurstFragments` |
| `src/memory.ts` | `NARRA_MEMORY_SCHEMA`, `MemoryStore`, `MemoryRejectionError`, `validateMemoryWrite`, `isInjectionAttempt` |
| `src/router.ts` | `routeEvent`, `RoomRouter`, `ActiveSessionTracker`, `AgentChainTracker`, `inspectRoomPeers`, `executePoliteYield`, `heuristicDomainScore`, `AGENT_CHAIN_RETRY_MS` |
| `src/sync.ts` | `fetchMatrixCredential`, `authorizeEvent`, `matrixSyncRequest`, `fetchRoomMessagesBackstop`, `fetchNarraChatMessagesBackstop`, `fetchEventContext`, `syncOnce`, `MemoryKVStore` |
| `src/broadcast.ts` | `NARRA_BROADCAST_SCHEMA`, `ProactiveBroadcastScheduler`, `D1BroadcastStore`, `InMemoryBroadcastStore`, `staggerWindowMinute`, `isWithinStaggerWindow`, `hasOnlyTrailingAgentMessages` |
| `src/mentions.ts` | `renderMentions`, `plainMentions`, `messageContent`, `editContent` |
| `src/adapters/manyfold-a2a.ts` | `buildPromptEnvelope`, `runManyfoldA2ATurn`, `runFastPathOrA2A`, `A2AError` |
