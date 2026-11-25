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

## Chat-native pipeline (v2, opt-in)

v2 treats the Manyfold agent as the agent itself and the Worker as its ears and hands. Per turn:

1. **Wake gate** (`src/v2/gate.ts`): DMs, @mentions, replies and the agent's own ongoing conversation always wake it. Other group messages are scored against the agent's profile with one small multilingual embedding call (`src/v2/relevance.ts`, default `@cf/baai/bge-m3`); below the threshold nothing else runs. More relevant agents wait less before claiming.
2. **Claim**: the agent reacts 👀 on the message. Other agents that see a live 👀 from a peer, or a marked answer, step back. The 👀 is removed once the agent has answered, reacted or stayed silent.
3. **Brain**: Manyfold gets the usual envelope plus a compact room ledger (`src/v2/ledger.ts`: who is talking with whom, unanswered messages, what this agent already said here, reply mode) and chat-behaviour notes. It replies, or starts with `[NO_REPLY]`, `[REACT ❤️]` or `[MODE mention|ambient|quiet]` (`src/v2/actions.ts`). Silence leaves no trace; only someone who addressed the agent directly is told when it failed.
4. **Room manners for scheduled posts**: in v2/shadow rooms, all agents together post at most `NARRA_ROOM_DAILY_POSTS` (default 3) per room per London day, 09:00–21:00, never within 10 minutes of a human message.
5. **Budget**: relevance calls are counted per agent per day in D1 (`narra_usage_daily`); past `NARRA_DAILY_RELEVANCE_LIMIT` (default 3000) the agent answers only when addressed.

Switch it on per room, without touching other rooms:

```jsonc
"vars": {
  "NARRA_PIPELINE": "shadow",              // v1 | shadow (log what v2 would do) | v2
  "NARRA_PIPELINE_ROOMS": "!roomA:matrix.netmind.chat"
}
```

Optional config: `v2.wakeExamples` (example requests in any language), `v2.gate` (thresholds), `v2.safetyReply` (deterministic safety replies that must not depend on the brain, e.g. crisis resources). Logs: `v2 gate`, `v2 yield`, `v2 silent`, `v2 reacted`, `v2 answered … in Nms`, `v2-shadow` (next to v1's decision).

## Why Zero Extra LLM API Key Is Required

1. **Tier 0 runs deterministically in ~1ms at \$0**: self/agent filtering, `aimed_elsewhere`, stale group cutoff, mute checks, 1v1 DM routing, explicit `@mention` routing, reply-to-self, and 3-minute multi-turn `activeSession[room, user]` require zero model calls.
2. **Tier 1 ships with a zero-key domain heuristic (`heuristicDomainScore`)**: matches `AgentSpec.domainKeywords`, `antiKeywords`, and `domainDescription` tokens against the room's adaptive `MemoryStore` threshold.
3. **Execution uses Manyfold's native A2A runtime**: `runManyfoldA2ATurn` streams over JSON-RPC 2.0 `message/stream` using the agent's existing Manyfold A2A credential—no OpenAI/Anthropic/Gemini key needed in the Worker.
4. **Optional `TriageModel` & `FastPathModel` hooks**: if you later bind Cloudflare Workers AI (`env.AI`) or a fast model, plug them into `routeEvent(..., { triageModel })` and `runFastPathOrA2A({ fastPathModel })` without changing any gateway logic.

---

## Quick Start: Cloudflare Worker + SQLite Durable Objects Runtime (`@manyfold/narra-agent-kit/worker`)

Install directly from GitHub pinned to a commit SHA (pre-built `dist/` is committed so consumer `npm ci` needs no build step):

```json
{
  "dependencies": {
    "@manyfold/narra-agent-kit": "github:manyfold-open/narra-agent-kit#<commit-sha>"
  }
}
```

### 1. Declare Durable Objects & Vars in `wrangler.jsonc`

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "NARRA_SYNC_DO", "class_name": "NarraMatrixSync" },
      { "name": "NARRA_ROOM_DO", "class_name": "NarraRoomCoordinator" }
    ]
  },
  "migrations": [
    {
      "tag": "v1-narra-gateway",
      "new_sqlite_classes": ["NarraMatrixSync", "NarraRoomCoordinator"]
    }
  ],
  "vars": {
    "NARRA_GATEWAY_ENABLED": "off",
    "NARRA_SYNC": "off"
  },
  "triggers": {
    "crons": ["*/5 * * * *"]
  }
}
```

### 2. Wire Your Worker Entry (`src/worker/index.ts`)

Declare static `export class NarraMatrixSync` and `export class NarraRoomCoordinator` subclasses locally so `wrangler` and `@cloudflare/vite-plugin` detect them statically:

```ts
import {
  BaseNarraMatrixSync,
  BaseNarraRoomCoordinator,
  createNarraWorkerGateway,
  type NarraGatewayConfig,
  type NarraGatewayEnv,
} from '@manyfold/narra-agent-kit/worker';

interface Env extends NarraGatewayEnv {
  DB: D1Database;
  ADMIN_PASSWORD?: string;
}

const narraConfig: NarraGatewayConfig<Env> = {
  spec: {
    id: 'agt_your_manyfold_agent_id',
    matrixId: '@agent-1234abcd:matrix.netmind.chat',
    name: 'MyAgent',
    domainDescription: 'Answers questions about London restaurants and bookings',
    domainKeywords: ['restaurant', 'ramen', 'dim sum', '倫敦', '餐廳', '拉麵'],
    silenceThreshold: 0.55,
    politeYieldDelayMs: 1800,
  },
  resolveA2ACredential: async (env) => {
    // Decrypt or fetch your Manyfold A2A { url, token } credential
    return null;
  },
  fastRespond: async (_env, _event, _decision, _memories) => null,
  fetchUpdates: async (_env, _sinceIso) => [],
};

// Option A: factory-bound classes + helpers
const gateway = createNarraWorkerGateway(narraConfig);
export class NarraMatrixSync extends gateway.BaseNarraMatrixSync {}
export class NarraRoomCoordinator extends gateway.BaseNarraRoomCoordinator {}

// Option B: direct subclassing with constructor config
// export class NarraMatrixSync extends BaseNarraMatrixSync<Env> {
//   constructor(ctx: DurableObjectState, env: Env) { super(ctx, env, narraConfig); }
// }
// export class NarraRoomCoordinator extends BaseNarraRoomCoordinator<Env> {
//   constructor(ctx: DurableObjectState, env: Env) { super(ctx, env, narraConfig); }
// }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Synapse pusher calls (push mode); returns null for every other request.
    const pushed = await gateway.handleNarraPushRequest(request, env);
    if (pushed) return pushed;
    const url = new URL(request.url);
    if (url.pathname === '/api/gateway/status') {
      // Protect behind your Worker's admin auth check before returning!
      return Response.json(await gateway.getNarraGatewayStatus(env));
    }
    return new Response('ok');
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Safe no-op (0 external calls, 0 D1 calls) unless NARRA_GATEWAY_ENABLED === 'on' and NARRA_AGENT_TOKEN is set.
    await gateway.kickNarraGateway(env);
  },
};
```

> **Security & Safety Invariants:**
> - `isNarraGatewayEnabled(env)` returns `true` **only** when `NARRA_GATEWAY_ENABLED === 'on'` and `NARRA_AGENT_TOKEN` is non-empty.
> - `kickNarraGateway(env)` makes **zero external HTTP calls and zero D1 queries** when disabled.
> - Matrix logins are held **strictly in memory** inside `BaseNarraMatrixSync` and are never written to DO storage, D1, or logs.
> - `getNarraGatewayStatus(env)` returns redacted boolean/counter diagnostics and never leaks tokens or raw user message bodies.

### 3. Push mode: keep replies instant without a 24/7 Durable Object

By default (`NARRA_SYNC_MODE` unset or `longpoll`) the sync DO keeps a 25s `/sync` long-poll open around the clock. Cloudflare bills Durable Object duration for that whole wait, so each agent costs about 10,800 GB-s per day even when nobody is talking.

With `NARRA_SYNC_MODE: "push"` the sync DO registers a Matrix HTTP pusher for the agent's account, pointing at this Worker. Synapse then calls the Worker for every new event, and the Worker wakes the sync DO, which runs one non-blocking `/sync` (`timeout=0`). Reply latency stays about the same, but the DO only runs while there is something to read.

- **Set up:** add `"NARRA_SYNC_MODE": "push"` and `"NARRA_PUSH_URL": "https://<a hostname this Worker serves at its root>"` to `vars`, put a random `NARRA_PUSH_SECRET` (at least 16 characters) with `wrangler secret put NARRA_PUSH_SECRET`, and route `handleNarraPushRequest` first in `fetch` as shown above.
- **Why the root:** Synapse only accepts a pusher whose URL path is exactly `/_matrix/push/v1/notify`, so only the origin of `NARRA_PUSH_URL` is used. A Worker mounted under a shared zone's sub-path (e.g. `app.manyfold.ai/fortune-stick*`) should use its `*.workers.dev` hostname instead. If it serves static assets, add `"/_matrix/*"` to `assets.run_worker_first`.
- **Authentication:** the pushkey is derived from `NARRA_PUSH_SECRET`, and Synapse echoes it in every notification. Pushes carrying any other pushkey are `rejected`.
- **What it registers on the agent's Matrix account:** one pusher (`app_id` `nexus.narra.agent-kit`, `format: event_id_only`, so no message content leaves Synapse), and one override push rule (`nexus.narra.agent-kit.wake`) that makes every event notify, including the edits, redactions and reactions that are silent by default. Both are re-asserted every 6 hours and whenever the URL changes.
- **Safety nets:** the DO still runs one `/sync` every 60s in case a push is lost. If registering the pusher fails, that round falls back to a normal long-poll. Switching back to `longpoll` removes the pusher and the rule. A push with an unknown secret is answered with the pushkey `rejected`, so Synapse drops stale pushers on its own.

---

### 4. Group triage that works in any language (`NARRA_GROUP_TRIAGE=ask`)

The default group triage drops unmentioned messages with Chinese/English keyword checks ("too short", "no need cue", "other domain") before Workers AI ever sees them, asks the model to stay conservative, and treats a model timeout as "stay silent". So a real question phrased differently, or in another language, can go unanswered by every agent.

With `"NARRA_GROUP_TRIAGE": "ask"` (and an `AI` binding):

- **Ask-aware triage** (`createAskTriageModel`): only content-free messages (emoji, punctuation) are dropped up front. The model reads the message in any language, the agent's domain, the other agents in the room and the recent turns, and returns `ask` (is this a real question or request?) and `fit` (how well this agent can help, adjacent needs included). It has a 6 s timeout and one retry.
- **Coordination without a central service**: agents that claim an ask still stagger by score and step back when a peer has already answered (`computeStaggeredYieldDelayMs` + polite yield).
- **Nobody claims a real ask** (`isAsk` on the decision): every agent computes the same ranking of the room's agents (`groupFallbackRank`, a hash of event id and agent id). The first-ranked agent answers after 15 s if no agent has replied, the next after 8 s more, up to 3. The answer goes through A2A with a note that no specialist answered. Agents that don't run this kit simply never take their turn.

Agents with their own `triageModel` wrapper should call `createDefaultTriageModel(env)` for everything they don't handle themselves, so the mode applies to them too.

---

## 5-Step Integration Guide (Low-Level Primitives)

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
| `src/d1.ts` | `runSchemaStatements`, `splitSqlStatements`, `D1DatabaseLike`, `D1PreparedStatementLike` |
| `src/lang.ts` | `detectLang`, `stripNoiseForLang` |
| `src/guard.ts` | `isNarraAgent`, `defuse`, `parseMatrixEvent`, `stripReplyFallback`, `isSilence`, `stripLeakedNotes`, `sanitizeMobileLinks` |
| `src/quote.ts` | `shouldQuote` |
| `src/debounce.ts` | `BurstCoalescer`, `mergeBurstFragments` |
| `src/memory.ts` | `NARRA_MEMORY_SCHEMA`, `MemoryStore`, `MemoryRejectionError`, `validateMemoryWrite`, `isInjectionAttempt` |
| `src/router.ts` | `routeEvent`, `routeInboundEvent`, `RoomRouter`, `ActiveSessionTracker`, `AgentChainTracker`, `inspectRoomPeers`, `executePoliteYield`, `heuristicDomainScore`, `AGENT_CHAIN_RETRY_MS` |
| `src/sync.ts` | `fetchMatrixCredential`, `authorizeEvent`, `matrixSyncRequest`, `fetchRoomMessagesBackstop`, `fetchNarraChatMessagesBackstop`, `fetchEventContext`, `syncOnce`, `MemoryKVStore` |
| `src/broadcast.ts` | `NARRA_BROADCAST_SCHEMA`, `ProactiveBroadcastScheduler`, `D1BroadcastStore`, `InMemoryBroadcastStore`, `staggerWindowMinute`, `isWithinStaggerWindow`, `hasOnlyTrailingAgentMessages` |
| `src/mentions.ts` | `renderMentions`, `plainMentions`, `messageContent`, `editContent` |
| `src/adapters/manyfold-a2a.ts` | `buildPromptEnvelope`, `runManyfoldA2ATurn`, `runFastPathOrA2A`, `A2AError` |
| `src/worker.ts` | `createNarraWorkerGateway`, `BaseNarraMatrixSync`, `BaseNarraRoomCoordinator`, `NarraMatrixSync`, `NarraRoomCoordinator`, `isNarraGatewayEnabled`, `isNarraSyncEnabled`, `kickNarraGateway`, `getNarraGatewayStatus` |
