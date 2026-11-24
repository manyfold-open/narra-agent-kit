import { parseMatrixEvent } from './guard.js';
import type { InboundEvent, KeyValueStore, RoomMemberInfo } from './types.js';

export const DEFAULT_SYNC_TIMEOUT_MS = 25_000;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_NARRA_BASE = 'https://api.netmind.chat';
const SEEN_LIMIT_PER_ROOM = 400;

export interface MatrixLogin {
  homeserverUrl: string;
  userId: string;
  accessToken: string;
}

export class SyncError extends Error {
  readonly unauthorized: boolean;

  constructor(message: string, unauthorized = false) {
    super(redactSecrets(message));
    this.name = 'SyncError';
    this.unauthorized = unauthorized;
  }
}

export function redactSecrets(value: unknown): string {
  return String(value ?? '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]')
    .replace(/\bsyt_[A-Za-z0-9_.-]+/g, '[redacted-matrix-token]')
    .replace(/([?&](?:token|access_token|key|secret)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 600);
}

/**
 * `fetch` with a deadline whose timer is cleared as soon as the response arrives. A pending
 * `AbortSignal.timeout()` timer keeps a Durable Object running, and billed, until it fires, even
 * after the request finished: a push-mode /sync that answered in 0.1 s held the DO for its whole
 * 20 s deadline.
 */
export async function fetchWithDeadline(
  fetchImpl: typeof fetch,
  input: string | URL | Request,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    ms,
  );
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const SYNC_FILTER = JSON.stringify({
  presence: { types: [] },
  account_data: { types: [] },
  room: {
    timeline: {
      limit: 50,
      types: ['m.room.message', 'm.reaction', 'm.room.redaction'],
    },
    state: { types: ['m.room.member'] },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
});

export interface RawMatrixSyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<
      string,
      {
        timeline?: {
          events?: Array<Record<string, unknown>>;
          limited?: boolean;
          prev_batch?: string;
        };
        state?: {
          events?: Array<Record<string, unknown>>;
        };
      }
    >;
    /** Rooms the agent has been invited to but not joined yet (e.g. a new user's DM). */
    invite?: Record<string, { invite_state?: { events?: Array<Record<string, unknown>> } }>;
  };
}

export interface SyncBatchRoom {
  roomId: string;
  events: InboundEvent[];
  limited: boolean;
  withheldGap: boolean;
  prevBatch?: string;
  members?: RoomMemberInfo[];
  backstopped?: boolean;
}

export interface NarraSyncConfig {
  narraApiEndpoint?: string;
  narraAgentToken?: string;
  /** Optional direct token provider (alternative to NARRA_AGENT_TOKEN). Kept in memory only. */
  loginProvider?: () => Promise<MatrixLogin>;
  /** Allowed homeserver hostnames (default allows netmind.chat and *.netmind.chat). */
  allowedHomeserverHosts?: string[];
  fetchImpl?: typeof fetch;
}

function isAllowedHomeserver(url: URL, extraAllowed: string[] = []): boolean {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'netmind.chat' || host.endsWith('.netmind.chat')) return true;
  return extraAllowed.some((allowed) => {
    const clean = allowed.toLowerCase();
    return host === clean || (clean.startsWith('.') && host.endsWith(clean));
  });
}

/**
 * Fetches Matrix login credentials from Narra (`POST /api/agent-runtime/matrix-credential`)
 * using `NARRA_AGENT_TOKEN`, or delegates to `loginProvider`.
 * Credentials stay strictly in memory and are never logged or persisted.
 */
export async function fetchMatrixCredential(
  config: NarraSyncConfig,
  cache?: { login?: MatrixLogin },
): Promise<MatrixLogin> {
  if (cache?.login) return cache.login;

  let login: MatrixLogin;
  if (config.loginProvider) {
    login = await config.loginProvider();
  } else {
    const token = (config.narraAgentToken ?? '').trim();
    if (!token) throw new SyncError('NARRA_AGENT_TOKEN is not set.');
    const base = (config.narraApiEndpoint ?? DEFAULT_NARRA_BASE).replace(/\/+$/, '');
    const doFetch = config.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await fetchWithDeadline(doFetch, `${base}/api/agent-runtime/matrix-credential`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }, 15_000);
    } catch (error) {
      throw new SyncError(`Narra unreachable: ${redactSecrets(error instanceof Error ? error.message : error)}`);
    }

    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const data = (
      body && typeof body.data === 'object' && body.data ? body.data : body
    ) as Record<string, unknown> | null;
    const homeserverUrl = typeof data?.homeserver_url === 'string' ? data.homeserver_url : '';
    const userId = typeof data?.matrix_user_id === 'string' ? data.matrix_user_id : '';
    const accessToken = typeof data?.access_token === 'string' ? data.access_token : '';

    if (!response.ok || !accessToken || !userId) {
      // Never echo response body because on success/partial responses it could hold tokens.
      throw new SyncError(`Narra matrix-credential failed: HTTP ${response.status}`, response.status === 401);
    }

    let url: URL;
    try {
      url = new URL(homeserverUrl);
    } catch {
      throw new SyncError('Narra returned an invalid homeserver URL.');
    }
    if (!isAllowedHomeserver(url, config.allowedHomeserverHosts)) {
      throw new SyncError(`Unexpected Matrix homeserver host (${url.hostname}).`);
    }
    login = { homeserverUrl: url.origin, userId, accessToken };
  }

  if (cache) cache.login = login;
  return login;
}

export interface AuthorizeEventInput {
  roomId: string;
  senderMatrixUserId: string;
  memberMatrixUserIds: string[];
  mentioned: boolean;
}

export interface AuthorizeEventResult {
  allow: boolean;
  roomKind?: 'dm' | 'group';
  notice?: { send?: boolean; text?: string };
  reason?: string;
}

/**
 * Calls Narra's `POST /api/agent-runtime/matrix/authorize-event` fail-closed.
 * Any network failure, non-2xx response, or non-true `allow` returns `{ allow: false }`.
 */
export async function authorizeEvent(
  config: Pick<NarraSyncConfig, 'narraApiEndpoint' | 'narraAgentToken' | 'fetchImpl'>,
  input: AuthorizeEventInput,
): Promise<AuthorizeEventResult> {
  const token = (config.narraAgentToken ?? '').trim();
  if (!token) return { allow: false, reason: 'missing_token' };

  const base = (config.narraApiEndpoint ?? DEFAULT_NARRA_BASE).replace(/\/+$/, '');
  const doFetch = config.fetchImpl ?? fetch;

  try {
    const response = await fetchWithDeadline(doFetch, `${base}/api/agent-runtime/matrix/authorize-event`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    }, 10_000);
    if (!response.ok) {
      return { allow: false, reason: `http_${response.status}` };
    }
    const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const data = (
      parsed && typeof parsed.data === 'object' && parsed.data ? parsed.data : parsed
    ) as Record<string, unknown> | null;
    if (data?.allow !== true) {
      return {
        allow: false,
        roomKind: data?.roomKind === 'dm' ? 'dm' : data?.roomKind === 'group' ? 'group' : undefined,
        notice: data?.notice as AuthorizeEventResult['notice'],
        reason: 'denied',
      };
    }
    return {
      allow: true,
      roomKind: data.roomKind === 'dm' ? 'dm' : data.roomKind === 'group' ? 'group' : undefined,
    };
  } catch {
    return { allow: false, reason: 'network_error' };
  }
}

/** Executes one Matrix `/_matrix/client/v3/sync` call. */
export async function matrixSyncRequest(
  login: MatrixLogin,
  since: string | null,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RawMatrixSyncResponse> {
  const url = new URL(`${login.homeserverUrl}/_matrix/client/v3/sync`);
  url.searchParams.set('filter', SYNC_FILTER);
  url.searchParams.set('timeout', String(timeoutMs));
  url.searchParams.set('set_presence', 'offline');
  if (since) url.searchParams.set('since', since);

  let response: Response;
  try {
    response = await fetchWithDeadline(fetchImpl, url.toString(), {
      headers: { authorization: `Bearer ${login.accessToken}` },
    }, timeoutMs + 20_000);
  } catch (error) {
    throw new SyncError(`Homeserver unreachable: ${redactSecrets(error instanceof Error ? error.message : error)}`);
  }

  if (response.status === 401) {
    throw new SyncError('Homeserver refused Matrix token (401).', true);
  }
  const body = (await response.json().catch(() => null)) as RawMatrixSyncResponse | null;
  if (!response.ok || !body || typeof body.next_batch !== 'string') {
    throw new SyncError(`/sync failed: HTTP ${response.status}`);
  }
  return body;
}

/**
 * Fetches `/messages` backstop directly from Matrix homeserver (or Narra chat API fallback)
 * to recover events skipped by `withheld_gap` / `limited: true` sync batches or delivery filters.
 */
export async function fetchRoomMessagesBackstop(
  login: MatrixLogin,
  roomId: string,
  options: { from?: string; dir?: 'f' | 'b'; limit?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ events: InboundEvent[]; nextBatch?: string; prevBatch?: string }> {
  const url = new URL(
    `${login.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
  );
  url.searchParams.set('dir', options.dir ?? 'b');
  url.searchParams.set('limit', String(options.limit ?? 50));
  if (options.from) url.searchParams.set('from', options.from);

  const response = await fetchWithDeadline(fetchImpl, url.toString(), {
    headers: { authorization: `Bearer ${login.accessToken}` },
  }, 15_000);
  if (response.status === 401) {
    throw new SyncError('Homeserver refused Matrix token on /messages (401).', true);
  }
  if (!response.ok) {
    throw new SyncError(`/messages failed: HTTP ${response.status}`);
  }
  const parsed = (await response.json().catch(() => ({}))) as {
    chunk?: Array<Record<string, unknown>>;
    start?: string;
    end?: string;
  };
  const chunk = Array.isArray(parsed.chunk) ? parsed.chunk : [];
  // Matrix dir=b returns newest first; sort chronological oldest-first.
  const ordered = (options.dir ?? 'b') === 'b' ? [...chunk].reverse() : chunk;
  const events: InboundEvent[] = [];
  for (const raw of ordered) {
    const parsedEv = parseMatrixEvent(raw, { roomId });
    if (parsedEv) events.push(parsedEv);
  }
  return {
    events,
    nextBatch: typeof parsed.end === 'string' ? parsed.end : undefined,
    prevBatch: typeof parsed.start === 'string' ? parsed.start : undefined,
  };
}

/**
 * Fetches Narra's `/api/agent-runtime/chat/messages` backstop when using `NARRA_AGENT_TOKEN`
 * (bypasses Synapse `delivery_filter_mode` because it reads via chat API cursor).
 */
export async function fetchNarraChatMessagesBackstop(
  config: Pick<NarraSyncConfig, 'narraApiEndpoint' | 'narraAgentToken' | 'fetchImpl'>,
  roomId: string,
  options: { from?: string; dir?: 'f' | 'b'; limit?: number } = {},
): Promise<{ events: InboundEvent[]; nextBatch?: string; prevBatch?: string }> {
  const token = (config.narraAgentToken ?? '').trim();
  if (!token) throw new SyncError('NARRA_AGENT_TOKEN is not set.');
  const base = (config.narraApiEndpoint ?? DEFAULT_NARRA_BASE).replace(/\/+$/, '');
  const doFetch = config.fetchImpl ?? fetch;

  const url = new URL(`${base}/api/agent-runtime/chat/messages`);
  url.searchParams.set('room_id', roomId);
  url.searchParams.set('dir', options.dir ?? 'f');
  url.searchParams.set('limit', String(options.limit ?? 50));
  if (options.from) url.searchParams.set('from', options.from);

  const response = await fetchWithDeadline(doFetch, url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  }, 15_000);
  if (!response.ok) {
    throw new SyncError(`Narra chat/messages failed: HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const data = (body?.data ?? {}) as Record<string, unknown>;
  const messages = Array.isArray(data.messages) ? (data.messages as Array<Record<string, unknown>>) : [];
  const pagination = (data.pagination ?? {}) as Record<string, unknown>;
  const events: InboundEvent[] = [];
  for (const raw of messages) {
    const parsedEv = parseMatrixEvent(raw, { roomId });
    if (parsedEv) events.push(parsedEv);
  }
  return {
    events,
    nextBatch: typeof pagination.next_batch === 'string' ? pagination.next_batch : undefined,
    prevBatch: typeof pagination.prev_batch === 'string' ? pagination.prev_batch : undefined,
  };
}

/** Fetches a single Matrix event by ID so replies to older messages hydrate parent text (`in_reply_to_other`). */
export async function fetchEventContext(
  login: MatrixLogin,
  roomId: string,
  eventId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InboundEvent | null> {
  const url = `${login.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`;
  try {
    const response = await fetchWithDeadline(fetchImpl, url, {
      headers: { authorization: `Bearer ${login.accessToken}` },
    }, 10_000);
    if (!response.ok) return null;
    const raw = (await response.json().catch(() => null)) as unknown;
    return parseMatrixEvent(raw, { roomId });
  } catch {
    return null;
  }
}

export interface SyncState {
  since: string | null;
  failures: number;
}

export interface SyncDeps {
  login(): Promise<MatrixLogin>;
  sync(login: MatrixLogin, since: string | null, timeoutMs: number): Promise<RawMatrixSyncResponse>;
  backstop?(login: MatrixLogin, roomId: string, prevBatch?: string): Promise<InboundEvent[]>;
  onBatch(rooms: SyncBatchRoom[]): Promise<void>;
  onEdit?(event: InboundEvent): Promise<void> | void;
  onRedaction?(event: InboundEvent): Promise<void> | void;
  log?(line: string): void;
}

/**
 * Runs one Matrix `/sync` cycle with:
 * - In-memory login cache (never persisted to store)
 * - Automatic `withheld_gap` (`limited: true`) `/messages` backstop
 * - Event deduplication per room
 * - `edit` (`m.replace`) and `redaction` (`m.room.redaction`) dispatch
 * - Exponential backoff on errors & 401 credential refresh
 */
export async function syncOnce(
  store: KeyValueStore,
  deps: SyncDeps,
  cache: { login?: MatrixLogin },
  options: { timeoutMs?: number; replayInitial?: boolean } = {},
): Promise<number> {
  const state = (await store.get<SyncState>('sync')) ?? { since: null, failures: 0 };
  const timeoutMs = options.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;

  try {
    cache.login ??= await deps.login();
    const isInitial = state.since === null;
    const response = await deps.sync(
      cache.login,
      state.since,
      isInitial && !options.replayInitial ? 0 : timeoutMs,
    );

    const batches: SyncBatchRoom[] = [];
    if (!isInitial || options.replayInitial) {
      for (const [roomId, joined] of Object.entries(response.rooms?.join ?? {})) {
        const limited = joined.timeline?.limited === true;
        const prevBatch = joined.timeline?.prev_batch;
        const seenKey = `seen:${roomId}`;
        const seen = new Set((await store.get<string[]>(seenKey)) ?? []);

        const members: RoomMemberInfo[] = [];
        for (const st of joined.state?.events ?? []) {
          if (st.type === 'm.room.member' && typeof st.state_key === 'string') {
            const c = (st.content ?? {}) as Record<string, unknown>;
            if (c.membership === 'join') {
              members.push({
                matrixId: st.state_key,
                displayName: typeof c.displayname === 'string' ? c.displayname : undefined,
                isAgent: /^@agent-[0-9a-f]+:/i.test(st.state_key),
              });
            }
          }
        }

        const collected: InboundEvent[] = [];
        let backstopped = false;

        if (limited && deps.backstop) {
          const backstopEvents = await deps.backstop(cache.login, roomId, prevBatch);
          backstopped = true;
          for (const ev of backstopEvents) {
            if (!seen.has(ev.eventId)) {
              seen.add(ev.eventId);
              collected.push(ev);
            }
          }
        }

        for (const raw of joined.timeline?.events ?? []) {
          const parsed = parseMatrixEvent(raw, { roomId });
          if (!parsed) continue;
          if (seen.has(parsed.eventId)) continue;
          seen.add(parsed.eventId);
          collected.push(parsed);
        }

        for (const ev of collected) {
          if (ev.kind === 'edit' && deps.onEdit) await deps.onEdit(ev);
          if (ev.kind === 'redaction' && deps.onRedaction) await deps.onRedaction(ev);
        }

        await store.put(seenKey, [...seen].slice(-SEEN_LIMIT_PER_ROOM));

        if (collected.length > 0 || limited) {
          batches.push({
            roomId,
            events: collected,
            limited,
            withheldGap: limited,
            ...(prevBatch ? { prevBatch } : {}),
            ...(members.length ? { members } : {}),
            ...(backstopped ? { backstopped } : {}),
          });
        }
      }
    } else {
      deps.log?.('sync initialized at live timeline head');
    }

    await deps.onBatch(batches);
    await store.put('sync', { since: response.next_batch, failures: 0 } satisfies SyncState);
    return 0;
  } catch (error) {
    if (error instanceof SyncError && error.unauthorized) {
      cache.login = undefined;
    }
    const failures = state.failures + 1;
    await store.put('sync', { ...state, failures } satisfies SyncState);
    deps.log?.(`sync failed (${failures}): ${redactSecrets(error instanceof Error ? error.message : error)}`);
    return Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** (failures - 1));
  }
}

/**
 * Convenience in-memory `KeyValueStore` implementation for tests or ephemeral runtimes.
 */
export class MemoryKVStore implements KeyValueStore {
  private readonly map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  async list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    const keys = [...this.map.keys()].filter((k) => k.startsWith(options.prefix)).sort();
    for (const k of keys) {
      if (options.limit && out.size >= options.limit) break;
      out.set(k, this.map.get(k) as T);
    }
    return out;
  }
}
