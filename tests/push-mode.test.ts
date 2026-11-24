import { describe, expect, it, vi } from 'vitest';
import {
  BaseNarraMatrixSync,
  NARRA_PUSH_BACKSTOP_MS,
  NARRA_PUSHER_APP_ID,
  NARRA_WAKE_PUSH_RULE_ID,
  handleNarraPushRequest,
  isNarraPushModeEnabled,
  narraPushNotifyUrl,
  type AgentSpec,
  type NarraGatewayEnv,
} from '../src/index.js';

class FakeDOStorage {
  readonly data = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of this.data) if (k.startsWith(options.prefix ?? '')) out.set(k, v as T);
    return out;
  }
  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }
  async setAlarm(at: number | Date): Promise<void> {
    this.alarmAt = typeof at === 'number' ? at : at.getTime();
  }
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

const SPEC: AgentSpec = {
  id: 'agt_push_test',
  matrixId: '@agent-bbbb2222:matrix.netmind.chat',
  name: 'Pushy',
  aliases: [],
  domainDescription: 'test agent',
  domainKeywords: [],
  antiKeywords: [],
} as AgentSpec;

const SECRET = 'push_secret_0123456789abcdef';
const BASE_ENV: NarraGatewayEnv = {
  NARRA_GATEWAY_ENABLED: 'on',
  NARRA_SYNC: 'on',
  NARRA_SYNC_MODE: 'push',
  NARRA_PUSH_URL: 'https://agent.example.com/tarot/',
  NARRA_PUSH_SECRET: SECRET,
  NARRA_AGENT_TOKEN: 'narra_tok_secret',
  MATRIX_ACCESS_TOKEN: 'syt_test_token_abc',
  MATRIX_USER_ID: SPEC.matrixId,
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function harness(envOverrides: Partial<NarraGatewayEnv> = {}, opts: { pusherStatus?: number } = {}) {
  let nowMs = 1_790_000_000_000;
  const calls: Call[] = [];
  let syncCount = 0;
  let onSync: (() => Promise<void>) | undefined;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url.includes('/api/agent-runtime/chat/rooms')) {
      return Response.json({ status: 'ok', data: { rooms: [] } });
    }
    if (url.includes('/pushers/set')) {
      return new Response('{}', { status: opts.pusherStatus ?? 200 });
    }
    if (url.includes('/pushrules/')) return new Response('{}', { status: 200 });
    if (url.includes('/_matrix/client/v3/sync')) {
      syncCount++;
      await onSync?.();
      return Response.json({ next_batch: `b${syncCount}`, rooms: { join: {} } });
    }
    return new Response('not found', { status: 404 });
  });

  const storage = new FakeDOStorage();
  const state = {
    storage,
    id: { toString: () => 'narra' },
    waitUntil: () => undefined,
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as DurableObjectState;
  const env: NarraGatewayEnv = { ...BASE_ENV, ...envOverrides };
  const sync = new BaseNarraMatrixSync(state, env, {
    spec: SPEC,
    fetchImpl: fetchMock as unknown as typeof fetch,
    now: () => nowMs,
  });
  return {
    sync,
    storage,
    env,
    calls,
    syncTimeouts: () =>
      calls.filter((c) => c.url.includes('/sync?')).map((c) => new URL(c.url).searchParams.get('timeout')),
    setNow: (ms: number) => {
      nowMs = ms;
    },
    now: () => nowMs,
    setOnSync: (fn: () => Promise<void>) => {
      onSync = fn;
    },
  };
}

describe('push mode (NARRA_SYNC_MODE=push)', () => {
  it('builds the pusher URL only for https + long secret, and gates push mode on it', () => {
    expect(narraPushNotifyUrl(BASE_ENV)).toBe(
      `https://agent.example.com/tarot/narra/push/${SECRET}/_matrix/push/v1/notify`,
    );
    expect(isNarraPushModeEnabled(BASE_ENV)).toBe(true);
    expect(narraPushNotifyUrl({ ...BASE_ENV, NARRA_PUSH_URL: 'http://agent.example.com' })).toBeNull();
    expect(narraPushNotifyUrl({ ...BASE_ENV, NARRA_PUSH_SECRET: 'short' })).toBeNull();
    expect(isNarraPushModeEnabled({ ...BASE_ENV, NARRA_SYNC_MODE: 'longpoll' })).toBe(false);
    expect(isNarraPushModeEnabled({ ...BASE_ENV, NARRA_SYNC: 'off' })).toBe(false);
  });

  it('registers pusher + wake rule once, syncs without waiting, and backs off to the slow backstop', async () => {
    const h = harness();
    await h.sync.alarm(); // initial sync (timeout 0 anyway)
    await h.sync.alarm(); // incremental sync: push mode must not long-poll

    const rule = h.calls.filter((c) => c.url.includes(`/pushrules/global/override/${NARRA_WAKE_PUSH_RULE_ID}`));
    expect(rule).toHaveLength(1);
    expect(rule[0]).toMatchObject({ method: 'PUT', body: { conditions: [], actions: ['notify'] } });

    const pushers = h.calls.filter((c) => c.url.endsWith('/pushers/set'));
    expect(pushers).toHaveLength(1);
    expect(pushers[0].body).toMatchObject({
      kind: 'http',
      app_id: NARRA_PUSHER_APP_ID,
      pushkey: `narra-agent-kit:${SPEC.id}`,
      data: {
        url: `https://agent.example.com/tarot/narra/push/${SECRET}/_matrix/push/v1/notify`,
        format: 'event_id_only',
      },
    });

    expect(h.syncTimeouts()).toEqual(['0', '0']);
    expect(h.storage.alarmAt).toBe(h.now() + NARRA_PUSH_BACKSTOP_MS);

    const status = (await (await h.sync.fetch(new Request('https://narra-sync/status'))).json()) as Record<
      string,
      unknown
    >;
    expect(status.syncMode).toBe('push');
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });

  it('a push wakes the DO immediately, including a push that lands mid-sync', async () => {
    const h = harness();
    await h.sync.alarm();
    expect(h.storage.alarmAt).toBe(h.now() + NARRA_PUSH_BACKSTOP_MS);

    h.setNow(h.now() + 5_000);
    const res = await (await h.sync.fetch(new Request('https://narra-sync/push', { method: 'POST' }))).json();
    expect(res).toEqual({ ok: true, woke: true });
    expect(h.storage.alarmAt).toBe(h.now());

    // The woken sync covers that push: no extra immediate run afterwards.
    await h.sync.alarm();
    expect(h.storage.alarmAt).toBe(h.now() + NARRA_PUSH_BACKSTOP_MS);

    // Another event arrives while the woken sync is still in flight.
    h.setOnSync(async () => {
      await h.sync.fetch(new Request('https://narra-sync/push', { method: 'POST' }));
    });
    await h.sync.alarm();
    expect(h.storage.alarmAt).toBe(h.now());
  });

  it('falls back to a normal long-poll when the pusher cannot be registered', async () => {
    const h = harness({}, { pusherStatus: 403 });
    await h.sync.alarm();
    await h.sync.alarm();
    expect(h.syncTimeouts()).toEqual(['0', '25000']);
    expect(h.storage.alarmAt).toBe(h.now());
    expect(await h.storage.get('pushSetup')).toBeUndefined();
  });

  it('removes the pusher and wake rule after switching back to long-poll', async () => {
    const h = harness();
    await h.sync.alarm();
    expect(await h.storage.get('pushSetup')).toBeDefined();

    (h.env as NarraGatewayEnv).NARRA_SYNC_MODE = 'longpoll';
    await h.sync.alarm();
    const removal = h.calls.filter((c) => c.url.endsWith('/pushers/set')).at(-1);
    expect(removal?.body).toMatchObject({ kind: null, pushkey: `narra-agent-kit:${SPEC.id}` });
    expect(
      h.calls.some((c) => c.method === 'DELETE' && c.url.includes(`/pushrules/global/override/${NARRA_WAKE_PUSH_RULE_ID}`)),
    ).toBe(true);
    expect(await h.storage.get('pushSetup')).toBeUndefined();
    expect(h.syncTimeouts().at(-1)).toBe('25000');
  });
});

describe('handleNarraPushRequest', () => {
  function envWithDo() {
    const doCalls: string[] = [];
    const ns = {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (url: string) => {
          doCalls.push(url);
          return Response.json({ ok: true, woke: true });
        },
      }),
    } as unknown as DurableObjectNamespace;
    return { env: { ...BASE_ENV, NARRA_SYNC_DO: ns }, doCalls };
  }
  const notify = (secret: string) =>
    new Request(`https://agent.example.com/tarot/narra/push/${secret}/_matrix/push/v1/notify`, {
      method: 'POST',
      body: JSON.stringify({ notification: { event_id: '$e', devices: [{ pushkey: 'pk1' }] } }),
    });

  it('ignores unrelated paths', async () => {
    const { env } = envWithDo();
    expect(await handleNarraPushRequest(new Request('https://agent.example.com/tarot/api/x'), env)).toBeNull();
  });

  it('wakes the sync DO for the right secret', async () => {
    const { env, doCalls } = envWithDo();
    const res = await handleNarraPushRequest(notify(SECRET), env);
    expect(await res!.json()).toEqual({ rejected: [] });
    expect(doCalls).toEqual(['https://narra-sync/push']);
  });

  it('rejects the pushkey (so Synapse drops the pusher) for a wrong secret or push mode off', async () => {
    const { env, doCalls } = envWithDo();
    expect(await (await handleNarraPushRequest(notify('wrong_secret_0123456789'), env))!.json()).toEqual({
      rejected: ['pk1'],
    });
    const off = { ...env, NARRA_SYNC_MODE: 'longpoll' };
    expect(await (await handleNarraPushRequest(notify(SECRET), off))!.json()).toEqual({ rejected: ['pk1'] });
    expect(doCalls).toEqual([]);
  });
});
