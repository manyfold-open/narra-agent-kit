import { buildPromptEnvelope, runManyfoldA2ATurn, A2AError } from './adapters/manyfold-a2a.js';
import {
  D1BroadcastStore,
  InMemoryBroadcastStore,
  ProactiveBroadcastScheduler,
  type BroadcastScheduleResult,
} from './broadcast.js';
import { runSchemaStatements } from './d1.js';
import { BurstCoalescer, type PendingBurstBuffer } from './debounce.js';
import {
  isNarraAgent,
  isSilence,
  parseMatrixEvent,
  sanitizeMobileLinks,
  stripLeakedNotes,
} from './guard.js';
import { detectLang } from './lang.js';
import { MemoryStore, type RecallTurnResult } from './memory.js';
import { editContent, messageContent, plainMentions } from './mentions.js';
import { shouldQuote } from './quote.js';
import {
  AGENT_CHAIN_CAP,
  AGENT_CHAIN_RETRY_MS,
  AgentChainTracker,
  DEFAULT_SESSION_WINDOW_MS,
  executePoliteYield,
  hasPeerRepliedAfter,
  inspectRoomPeers,
  isChainExhaustedError,
  routeEvent,
} from './router.js';
import {
  fetchEventContext,
  fetchMatrixCredential,
  fetchRoomMessagesBackstop,
  matrixSyncRequest,
  redactSecrets,
  SyncError,
  syncOnce,
  type MatrixLogin,
  type RawMatrixSyncResponse,
  type SyncBatchRoom,
  type SyncState,
} from './sync.js';
import type {
  AgentSpec,
  AgentUpdateItem,
  ChatType,
  HistoryTurn,
  InboundEvent,
  KeyValueStore,
  LangCode,
  ReplyTargetContext,
  RoomContext,
  RoomMemberInfo,
  TriageDecision,
  TriageModel,
} from './types.js';

const DEFAULT_NARRA_API_ENDPOINT = 'https://api.netmind.chat';
const DEFAULT_MATRIX_HOMESERVER = 'https://matrix.netmind.chat';
const ROOM_META_REFRESH_MS = 5 * 60_000;
const TYPING_REFRESH_MS = 20_000;
const MAX_TURN_AGE_MS = 30 * 60_000;
const MAX_POST_ATTEMPTS = 3;
const MAX_QUEUE_SIZE = 200;
const MAX_HANDLED_IDS = 300;
const MAX_REDACTED_IDS = 300;
const MAX_RECENT_HISTORY = 30;
const MAX_OWN_MESSAGES = 30;
const MAX_MESSAGE_CACHE = 50;
const MAX_LOG_LINES = 40;
const STALE_ROOM_STATUS_LIMIT = 20;

export const NARRA_GATEWAY_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS narra_gateway_state (
  agent_id TEXT PRIMARY KEY,
  last_broadcast_iso TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export interface NarraGatewayEnv {
  DB?: D1Database;
  NARRA_GATEWAY_ENABLED?: string;
  NARRA_SYNC?: string;
  NARRA_AGENT_TOKEN?: string;
  NARRA_API_ENDPOINT?: string;
  MATRIX_ACCESS_TOKEN?: string;
  MATRIX_HOMESERVER_URL?: string;
  MATRIX_USER_ID?: string;
  NARRA_SYNC_DO?: DurableObjectNamespace;
  NARRA_ROOM_DO?: DurableObjectNamespace;
  MANYFOLD_API_BASE_URL?: string;
  MANYFOLD_A2A_URL?: string;
  MANYFOLD_A2A_TOKEN?: string;
  NARRA_BROADCAST_STAGGER?: string;
  NARRA_AUTHORIZE_EVENTS?: string;
  ENVIRONMENT?: string;
  AI?: unknown;
}

export interface NarraA2ACredentialResult {
  url: string;
  token: string;
  label?: string;
}

export interface NarraGatewayConfig<TEnv extends NarraGatewayEnv = NarraGatewayEnv> {
  spec: AgentSpec;
  fetchUpdates?: (env: TEnv, sinceIso: string) => Promise<AgentUpdateItem[]>;
  fastRespond?: (
    env: TEnv,
    event: InboundEvent,
    decision: TriageDecision,
    memories: RecallTurnResult,
  ) => Promise<string | null>;
  resolveA2ACredential?: (env: TEnv) => Promise<NarraA2ACredentialResult | null>;
  triageModel?: (env: TEnv) => TriageModel | undefined;
  /** Optional custom fetch implementation (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Optional extra allowed Matrix homeserver hostnames (in addition to netmind.chat / *.netmind.chat). */
  allowedHomeserverHosts?: string[];
  /** Optional room opt-out hook for proactive broadcasts. */
  isRoomOptedOut?: (env: TEnv, roomId: string) => Promise<boolean> | boolean;
  /** Enforce deterministic minute-slot staggering for broadcasts (defaults to true unless NARRA_BROADCAST_STAGGER==='off'). */
  enforceBroadcastStagger?: boolean;
  /** Opt-in fail-closed check against Narra `/api/agent-runtime/matrix/authorize-event`. */
  authorizeEvents?: boolean;
  /** Injectable clock for deterministic testing. */
  now?: () => number;
  /** Injectable sleep for deterministic testing. */
  sleep?: (ms: number) => Promise<void>;
}

export type NarraMatrixOp =
  | { op: 'send'; roomId: string; txnId?: string; content: Record<string, unknown> }
  | {
      op: 'edit';
      roomId: string;
      eventId?: string;
      text?: string;
      txnId?: string;
      selfMatrixId?: string;
      content?: Record<string, unknown>;
    }
  | { op: 'typing'; roomId: string; typing: boolean; timeoutMs?: number }
  | { op: 'receipt'; roomId: string; eventId: string }
  | { op: 'fetchEvent'; roomId: string; eventId: string };

export type NarraMatrixOpResult =
  | { ok: true; eventId?: string; event?: InboundEvent | null }
  | { ok: false; status: number; errcode?: string; narraCode?: string };

export interface NarraGatewayKickResult {
  enabled: boolean;
  syncKicked: boolean;
  syncRunning: boolean;
  broadcast: BroadcastScheduleResult | null;
}

export interface NarraGatewayStatus {
  enabled: boolean;
  syncEnabled: boolean;
  agentId: string | null;
  agentName: string | null;
  matrixId: string | null;
  config: {
    NARRA_GATEWAY_ENABLED: string;
    NARRA_SYNC: string;
    hasNarraAgentToken: boolean;
    hasMatrixAccessToken: boolean;
    hasSyncDoBinding: boolean;
    hasRoomDoBinding: boolean;
    hasDatabaseBinding: boolean;
    narraApiEndpoint: string;
  };
  sync: Record<string, unknown> | null;
  rooms: Record<string, Record<string, unknown>>;
}

interface RoomMeta {
  roomId: string;
  roomName?: string;
  chatType: ChatType;
  members: RoomMemberInfo[];
  updatedAtMs: number;
}

interface StoredOwnMessage {
  eventId: string;
  text: string;
  timestampMs: number;
}

interface StoredCachedMessage {
  eventId: string;
  senderId: string;
  senderName?: string;
  isAgent: boolean;
  isSelf: boolean;
  text: string;
  timestampMs: number;
}

interface StoredSessionEntry {
  lastAgentReplyAtMs: number;
  lastUserTurnAtMs: number;
  expiresAtMs: number;
}

interface PendingTurn {
  event: InboundEvent;
  attempts: number;
  enqueuedAtMs: number;
  dueAtMs: number;
  answer?: string;
  decision?: TriageDecision;
  lastError?: string;
}

interface SendFailureError extends Error {
  status: number;
  errcode?: string;
  narraCode?: string;
  retryable: boolean;
}

const schemaInitCache = new WeakMap<D1Database, Promise<void>>();

/**
 * Ensures `NARRA_MEMORY_SCHEMA`, `NARRA_BROADCAST_SCHEMA`, and `narra_gateway_state`
 * exist in D1 once per isolate/D1 instance. Call ONLY when `isNarraGatewayEnabled(env)` is true.
 */
async function ensureGatewaySchemas(db: D1Database): Promise<void> {
  let pending = schemaInitCache.get(db);
  if (!pending) {
    pending = (async () => {
      const mem = new MemoryStore(db, '__init__');
      await mem.ensureSchema();
      const bcast = new D1BroadcastStore(db);
      await bcast.ensureSchema();
      await runSchemaStatements(db, NARRA_GATEWAY_STATE_SCHEMA);
    })().catch((err) => {
      schemaInitCache.delete(db);
      throw err;
    });
    schemaInitCache.set(db, pending);
  }
  await pending;
}

/**
 * Returns `true` ONLY when BOTH `NARRA_GATEWAY_ENABLED` is `'on'` AND `NARRA_AGENT_TOKEN` is non-empty.
 */
export function isNarraGatewayEnabled(env: NarraGatewayEnv | undefined | null): boolean {
  if (!env) return false;
  return (
    (env.NARRA_GATEWAY_ENABLED ?? '').trim() === 'on' &&
    (env.NARRA_AGENT_TOKEN ?? '').trim().length > 0
  );
}

export function isNarraSyncEnabled(env: NarraGatewayEnv | undefined | null): boolean {
  return isNarraGatewayEnabled(env) && (env?.NARRA_SYNC ?? '').trim() === 'on';
}

function scrubSecrets(value: unknown, env?: NarraGatewayEnv, extraSecrets: string[] = []): string {
  let text = redactSecrets(value);
  const candidates = [
    env?.NARRA_AGENT_TOKEN,
    env?.MATRIX_ACCESS_TOKEN,
    env?.MANYFOLD_A2A_TOKEN,
    ...extraSecrets,
  ];
  for (const raw of candidates) {
    const clean = (raw ?? '').trim();
    if (clean.length >= 6 && text.includes(clean)) {
      text = text.split(clean).join('[redacted]');
    }
  }
  return text.slice(0, 600);
}

function narraEndpoint(env: NarraGatewayEnv): string {
  return (env.NARRA_API_ENDPOINT ?? DEFAULT_NARRA_API_ENDPOINT).replace(/\/+$/, '');
}

function doKeyValueStore(storage: DurableObjectStorage): KeyValueStore {
  return {
    get: <T>(key: string) => storage.get<T>(key),
    put: (key: string, value: unknown) => storage.put(key, value),
    delete: (key: string) => storage.delete(key),
    list: <T>(options: { prefix: string; limit?: number }) => storage.list<T>(options),
  };
}

async function appendDoLog(
  storage: DurableObjectStorage,
  line: string,
  nowMs: number,
  env?: NarraGatewayEnv,
): Promise<void> {
  const existing = (await storage.get<string[]>('log')) ?? [];
  const entry = `${new Date(nowMs).toISOString()} ${scrubSecrets(line, env)}`;
  await storage.put('log', [...existing, entry].slice(-MAX_LOG_LINES));
}

async function deterministicTxnId(seed: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`narra-gw:${seed}`)),
  ).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isAllowedHomeserverOrigin(rawUrl: string, extraAllowed: string[] = []): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SyncError('Invalid Matrix homeserver URL.');
  }
  if (url.protocol !== 'https:') {
    throw new SyncError('Matrix homeserver URL must use https.');
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    host === 'netmind.chat' ||
    host.endsWith('.netmind.chat') ||
    extraAllowed.some((item) => {
      const clean = item.toLowerCase();
      return host === clean || (clean.startsWith('.') && host.endsWith(clean));
    });
  if (!allowed) {
    throw new SyncError(`Unexpected Matrix homeserver host (${url.hostname}).`);
  }
  return url.origin;
}

function makeSendFailure(
  message: string,
  status: number,
  opts: { errcode?: string; narraCode?: string; retryable?: boolean } = {},
): SendFailureError {
  const err = new Error(redactSecrets(message)) as SendFailureError;
  err.name = 'NarraSendError';
  err.status = status;
  err.errcode = opts.errcode;
  err.narraCode = opts.narraCode;
  err.retryable =
    opts.retryable ??
    (status === 401 || status === 403 || status === 429 || status >= 500 || status === 0);
  return err;
}

function hasExplicitLangSignal(text: string, extraMentionNames?: readonly string[]): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;
  const options = extraMentionNames?.length ? { extraMentionNames: [...extraMentionNames] } : undefined;
  const a = detectLang(trimmed, 'zh-Hant', 'zh-Hant', options);
  const b = detectLang(trimmed, 'zh-Hans', 'zh-Hans', options);
  const c = detectLang(trimmed, 'en', 'en', options);
  return a === b && b === c;
}

function isNormalizedInboundEvent(raw: unknown): raw is InboundEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj.eventId === 'string' &&
    typeof obj.senderId === 'string' &&
    typeof obj.roomId === 'string' &&
    typeof obj.kind === 'string' &&
    typeof obj.text === 'string' &&
    Array.isArray(obj.mentions)
  );
}

async function defaultResolveA2ACredential(env: NarraGatewayEnv, spec: AgentSpec): Promise<NarraA2ACredentialResult | null> {
  const url = (env.MANYFOLD_A2A_URL ?? '').trim();
  const token = (env.MANYFOLD_A2A_TOKEN ?? '').trim();
  if (url && token) {
    return { url, token, label: spec.name };
  }
  return null;
}

async function postViaNarraChatApi(
  env: NarraGatewayEnv,
  input: {
    roomId: string;
    text: string;
    txnId: string;
    replyToEventId?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<{ eventId: string }> {
  const token = (env.NARRA_AGENT_TOKEN ?? '').trim();
  if (!token) {
    throw makeSendFailure('NARRA_AGENT_TOKEN is not set.', 0, { retryable: false });
  }
  const doFetch = input.fetchImpl ?? fetch;
  const base = narraEndpoint(env);
  let response: Response;
  try {
    response = await doFetch(`${base}/api/agent-runtime/chat/send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        room_id: input.roomId,
        text: input.text,
        txn_id: input.txnId,
        ...(input.replyToEventId ? { reply_to_event_id: input.replyToEventId } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw makeSendFailure(
      `Narra chat/send unreachable: ${scrubSecrets(error instanceof Error ? error.message : error, env)}`,
      599,
      { retryable: true },
    );
  }

  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const data = (
    parsed && typeof parsed.data === 'object' && parsed.data ? parsed.data : parsed
  ) as Record<string, unknown> | null;

  if (!response.ok || (parsed && typeof parsed.status === 'string' && parsed.status !== 'ok')) {
    const issues = Array.isArray(parsed?.issues)
      ? (parsed.issues as Array<Record<string, unknown>>)
      : [];
    const issueCode = issues.find((i) => typeof i?.code === 'string')?.code as string | undefined;
    const narraCode =
      typeof parsed?.narra_error_code === 'string' ? parsed.narra_error_code : issueCode;
    const errcode = typeof parsed?.errcode === 'string' ? parsed.errcode : undefined;
    throw makeSendFailure(
      `Narra chat/send failed: HTTP ${response.status}${narraCode ? ` (${narraCode})` : ''}`,
      response.status,
      {
        errcode,
        narraCode,
        retryable:
          response.status === 429 ||
          response.status >= 500 ||
          response.status === 403 ||
          narraCode === 'agent_chain_exhausted' ||
          narraCode === 'matrix-membership-unverified',
      },
    );
  }

  return {
    eventId: typeof data?.event_id === 'string' ? data.event_id : '',
  };
}

function emptyMemories(): RecallTurnResult {
  return { userMemories: [], roomMemories: [], promptSafeLines: [] };
}

function findSubsequentHistory(
  recentHistory: HistoryTurn[],
  event: InboundEvent,
): HistoryTurn[] {
  const coalescedSet = new Set(event.coalescedEventIds ?? [event.eventId]);
  let lastIdx = -1;
  for (let i = 0; i < recentHistory.length; i++) {
    if (coalescedSet.has(recentHistory[i].eventId) || recentHistory[i].eventId === event.eventId) {
      lastIdx = i;
    }
  }
  if (lastIdx >= 0) {
    return recentHistory.slice(lastIdx + 1);
  }
  return recentHistory.filter(
    (h) => !coalescedSet.has(h.eventId) && h.eventId !== event.eventId && h.timestampMs > event.timestampMs,
  );
}

/**
 * Base Durable Object for Matrix `/sync` + `/messages` backstop + in-memory credential handling.
 * Consumer Workers subclass this locally (e.g. `export class NarraMatrixSync extends BaseNarraMatrixSync {}`)
 * so `@cloudflare/vite-plugin` and `wrangler` detect Durable Objects statically.
 */
export class BaseNarraMatrixSync<TEnv extends NarraGatewayEnv = NarraGatewayEnv> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: TEnv;
  private readonly explicitConfig?: NarraGatewayConfig<TEnv>;
  /** Strictly in-memory Matrix login cache; NEVER persisted to DO storage or logged. */
  private readonly cache: { login?: MatrixLogin } = {};

  constructor(ctx: DurableObjectState, env: TEnv, config?: NarraGatewayConfig<TEnv>) {
    this.ctx = ctx;
    this.env = env;
    this.explicitConfig = config;
  }

  protected getConfig(): NarraGatewayConfig<TEnv> {
    if (this.explicitConfig) return this.explicitConfig;
    throw new Error(
      'BaseNarraMatrixSync requires config via super(ctx, env, config), createNarraWorkerGateway(config), or getConfig() override.',
    );
  }

  private nowMs(): number {
    return this.getConfigSafe()?.now?.() ?? Date.now();
  }

  private getConfigSafe(): NarraGatewayConfig<TEnv> | undefined {
    try {
      return this.getConfig();
    } catch {
      return undefined;
    }
  }

  private isSyncActive(): boolean {
    return isNarraSyncEnabled(this.env);
  }

  private async resolveLogin(forceRefresh = false): Promise<{ login: MatrixLogin; wasCached: boolean }> {
    if (forceRefresh) {
      this.cache.login = undefined;
    }
    if (this.cache.login) {
      return { login: this.cache.login, wasCached: true };
    }

    const cfg = this.getConfig();
    const directAccessToken = (this.env.MATRIX_ACCESS_TOKEN ?? '').trim();
    const fallbackUserId = (this.env.MATRIX_USER_ID ?? cfg.spec.matrixId ?? '').trim();

    if (directAccessToken && fallbackUserId) {
      const origin = isAllowedHomeserverOrigin(
        (this.env.MATRIX_HOMESERVER_URL ?? DEFAULT_MATRIX_HOMESERVER).trim(),
        cfg.allowedHomeserverHosts,
      );
      const login: MatrixLogin = {
        homeserverUrl: origin,
        userId: fallbackUserId,
        accessToken: directAccessToken,
      };
      this.cache.login = login;
      await this.ctx.storage.put('matrixUserId', login.userId);
      return { login, wasCached: false };
    }

    const login = await fetchMatrixCredential(
      {
        narraApiEndpoint: narraEndpoint(this.env),
        narraAgentToken: this.env.NARRA_AGENT_TOKEN,
        allowedHomeserverHosts: cfg.allowedHomeserverHosts,
        fetchImpl: cfg.fetchImpl,
      },
      this.cache,
    );
    await this.ctx.storage.put('matrixUserId', login.userId);
    return { login, wasCached: false };
  }

  private async callHomeserver(
    login: MatrixLogin,
    op: NarraMatrixOp,
    fetchImpl: typeof fetch,
  ): Promise<NarraMatrixOpResult> {
    const enc = encodeURIComponent;
    if (op.op === 'fetchEvent') {
      const event = await fetchEventContext(login, op.roomId, op.eventId, fetchImpl);
      if (!event) return { ok: false, status: 404, errcode: 'M_NOT_FOUND' };
      return { ok: true, event };
    }

    const roomBase = `${login.homeserverUrl}/_matrix/client/v3/rooms/${enc(op.roomId)}`;
    let method = 'PUT';
    let url: string;
    let body: unknown;

    if (op.op === 'send') {
      const txnId = op.txnId || crypto.randomUUID();
      url = `${roomBase}/send/m.room.message/${enc(txnId)}`;
      body = op.content;
    } else if (op.op === 'edit') {
      const txnId = op.txnId || crypto.randomUUID();
      url = `${roomBase}/send/m.room.message/${enc(txnId)}`;
      if (op.content) {
        body = op.content;
      } else if (op.eventId && typeof op.text === 'string') {
        body = editContent(op.eventId, op.text, {
          selfMatrixId: op.selfMatrixId ?? login.userId,
        });
      } else {
        return { ok: false, status: 400, errcode: 'BAD_EDIT_OP' };
      }
    } else if (op.op === 'typing') {
      url = `${roomBase}/typing/${enc(login.userId)}`;
      body = op.typing ? { typing: true, timeout: op.timeoutMs ?? 30_000 } : { typing: false };
    } else {
      method = 'POST';
      url = `${roomBase}/receipt/m.read/${enc(op.eventId)}`;
      body = {};
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${login.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return {
        ok: false,
        status: 599,
        errcode: scrubSecrets(error instanceof Error ? error.message : error, this.env).slice(0, 120),
      };
    }

    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) {
      return {
        ok: true,
        ...(typeof parsed.event_id === 'string' ? { eventId: parsed.event_id } : {}),
      };
    }

    return {
      ok: false,
      status: response.status,
      ...(typeof parsed.errcode === 'string' ? { errcode: parsed.errcode } : {}),
      ...(typeof parsed.narra_error_code === 'string' ? { narraCode: parsed.narra_error_code } : {}),
    };
  }

  private async executeMatrixOp(op: NarraMatrixOp): Promise<NarraMatrixOpResult> {
    if (!this.isSyncActive()) {
      return { ok: false, status: 0, errcode: isNarraGatewayEnabled(this.env) ? 'SYNC_OFF' : 'GATEWAY_DISABLED' };
    }

    const cfg = this.getConfig();
    const doFetch = cfg.fetchImpl ?? fetch;

    let resolved: { login: MatrixLogin; wasCached: boolean };
    try {
      resolved = await this.resolveLogin(false);
    } catch (error) {
      await appendDoLog(
        this.ctx.storage,
        `matrix login failed: ${scrubSecrets(error instanceof Error ? error.message : error, this.env)}`,
        this.nowMs(),
        this.env,
      );
      return { ok: false, status: 0, errcode: 'NO_LOGIN' };
    }

    let result = await this.callHomeserver(resolved.login, op, doFetch);
    if (!result.ok && result.status === 401) {
      this.cache.login = undefined;
      if (resolved.wasCached) {
        try {
          const refreshed = await this.resolveLogin(true);
          result = await this.callHomeserver(refreshed.login, op, doFetch);
          if (!result.ok && result.status === 401) {
            this.cache.login = undefined;
          }
        } catch {
          return { ok: false, status: 401, errcode: 'M_UNKNOWN_TOKEN' };
        }
      }
    }
    return result;
  }

  private async updateRoomMetaFromSync(response: RawMatrixSyncResponse, nowMs: number): Promise<void> {
    const joinedRooms = response.rooms?.join ?? {};
    if (Object.keys(joinedRooms).length === 0) return;
    const knownRoomIds = new Set((await this.ctx.storage.get<string[]>('roomIds')) ?? []);

    for (const [roomId, joined] of Object.entries(joinedRooms)) {
      knownRoomIds.add(roomId);
      const existing = await this.ctx.storage.get<RoomMeta>(`roomMeta:${roomId}`);
      const memberMap = new Map<string, RoomMemberInfo>();
      for (const m of existing?.members ?? []) {
        memberMap.set(m.matrixId, m);
      }
      let roomName = existing?.roomName;

      for (const st of joined.state?.events ?? []) {
        if (st.type === 'm.room.name') {
          const content = (st.content ?? {}) as Record<string, unknown>;
          if (typeof content.name === 'string' && content.name.trim()) {
            roomName = content.name.trim();
          }
        } else if (st.type === 'm.room.member' && typeof st.state_key === 'string') {
          const content = (st.content ?? {}) as Record<string, unknown>;
          if (content.membership === 'join') {
            memberMap.set(st.state_key, {
              matrixId: st.state_key,
              displayName: typeof content.displayname === 'string' ? content.displayname : undefined,
              isAgent: isNarraAgent(st.state_key),
            });
          } else if (content.membership === 'leave' || content.membership === 'ban') {
            memberMap.delete(st.state_key);
          }
        }
      }

      const members = [...memberMap.values()];
      const inferredChatType: ChatType =
        existing?.chatType ?? (members.length === 2 && !roomName ? 'dm' : 'group');

      await this.ctx.storage.put(`roomMeta:${roomId}`, {
        roomId,
        ...(roomName ? { roomName } : {}),
        chatType: inferredChatType,
        members,
        updatedAtMs: nowMs,
      } satisfies RoomMeta);
    }

    await this.ctx.storage.put('roomIds', [...knownRoomIds].slice(-100));
  }

  private async refreshNarraRoomsMeta(nowMs: number, force = false): Promise<void> {
    const lastRefreshed = (await this.ctx.storage.get<number>('roomsMetaRefreshedAt')) ?? 0;
    if (!force && nowMs - lastRefreshed < ROOM_META_REFRESH_MS) return;

    const token = (this.env.NARRA_AGENT_TOKEN ?? '').trim();
    if (!token) return;

    const cfg = this.getConfig();
    const doFetch = cfg.fetchImpl ?? fetch;
    try {
      const url = new URL(`${narraEndpoint(this.env)}/api/agent-runtime/chat/rooms`);
      url.searchParams.set('conversation_type', 'all');
      url.searchParams.set('include_members', 'true');
      const res = await doFetch(url.toString(), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const data = (
        body && typeof body.data === 'object' && body.data ? body.data : body
      ) as Record<string, unknown> | null;
      if (!data) return;

      const agent = (data.agent ?? {}) as Record<string, unknown>;
      if (typeof agent.matrix_user_id === 'string' && agent.matrix_user_id.startsWith('@')) {
        await this.ctx.storage.put('matrixUserId', agent.matrix_user_id);
      }

      const rooms = Array.isArray(data.rooms) ? (data.rooms as Array<Record<string, unknown>>) : [];
      const roomIds = new Set((await this.ctx.storage.get<string[]>('roomIds')) ?? []);
      for (const r of rooms) {
        const roomId = typeof r.room_id === 'string' ? r.room_id : '';
        if (!roomId) continue;
        roomIds.add(roomId);
        const rawMembers = Array.isArray(r.members) ? (r.members as Array<Record<string, unknown>>) : [];
        const members: RoomMemberInfo[] = rawMembers
          .filter((m) => typeof m.matrix_user_id === 'string')
          .map((m) => ({
            matrixId: String(m.matrix_user_id),
            displayName: typeof m.display_name === 'string' ? m.display_name : undefined,
            isAgent: isNarraAgent(String(m.matrix_user_id)),
          }));
        const rawType = String(r.conversation_type ?? r.chat_type ?? r.type ?? '').toLowerCase();
        const chatType: ChatType = ['dm', 'direct', 'private', 'one_on_one'].includes(rawType)
          ? 'dm'
          : 'group';
        const roomName = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : undefined;
        await this.ctx.storage.put(`roomMeta:${roomId}`, {
          roomId,
          ...(roomName ? { roomName } : {}),
          chatType,
          members,
          updatedAtMs: nowMs,
        } satisfies RoomMeta);
      }
      await this.ctx.storage.put('roomIds', [...roomIds].slice(-100));
      await this.ctx.storage.put('roomsMetaRefreshedAt', nowMs);
    } catch {
      // Non-fatal: sync falls back cleanly to /sync m.room.member state events.
    }
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (request.method === 'POST' && path.endsWith('/matrix')) {
      const body = (await request.json().catch(() => null)) as NarraMatrixOp | null;
      if (!body || typeof body.op !== 'string' || typeof body.roomId !== 'string') {
        return Response.json({ ok: false, status: 400, errcode: 'BAD_MATRIX_OP' }, { status: 400 });
      }
      const result = await this.executeMatrixOp(body);
      return Response.json(result);
    }

    if (request.method === 'GET' && path.endsWith('/status')) {
      const syncState = (await this.ctx.storage.get<SyncState>('sync')) ?? null;
      const roomIds = (await this.ctx.storage.get<string[]>('roomIds')) ?? [];
      const logs = (await this.ctx.storage.get<string[]>('log')) ?? [];
      return Response.json({
        enabled: this.isSyncActive(),
        gatewayEnabled: isNarraGatewayEnabled(this.env),
        syncFlag: (this.env.NARRA_SYNC ?? '').trim() === 'on',
        alarm: await this.ctx.storage.getAlarm(),
        started: Boolean(syncState?.since),
        failures: syncState?.failures ?? 0,
        lastOk: (await this.ctx.storage.get<number>('lastOk')) ?? null,
        hasInMemoryLogin: Boolean(this.cache.login),
        matrixUserId: (await this.ctx.storage.get<string>('matrixUserId')) ?? null,
        roomCount: roomIds.length,
        roomIds,
        log: logs.map((line) => scrubSecrets(line, this.env)),
      });
    }

    if (request.method === 'POST' && path.endsWith('/kick')) {
      if (!this.isSyncActive()) {
        await this.ctx.storage.deleteAlarm();
        this.cache.login = undefined;
        return Response.json({ ok: true, enabled: false, running: false });
      }
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(this.nowMs());
      }
      return Response.json({ ok: true, enabled: true, running: true });
    }

    return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  async alarm(): Promise<void> {
    if (!this.isSyncActive()) {
      await this.ctx.storage.deleteAlarm();
      this.cache.login = undefined;
      return;
    }

    const cfg = this.getConfig();
    const doFetch = cfg.fetchImpl ?? fetch;
    const nowMs = this.nowMs();
    const storage = this.ctx.storage;

    await this.refreshNarraRoomsMeta(nowMs);

    const delay = await syncOnce(
      doKeyValueStore(storage),
      {
        login: async () => (await this.resolveLogin(false)).login,
        sync: async (login, since, timeoutMs) => {
          const response = await matrixSyncRequest(login, since, timeoutMs, doFetch);
          await this.updateRoomMetaFromSync(response, nowMs);
          return response;
        },
        backstop: async (login, roomId, prevBatch) => {
          const res = await fetchRoomMessagesBackstop(
            login,
            roomId,
            { ...(prevBatch ? { from: prevBatch } : {}), dir: 'b', limit: 50 },
            doFetch,
          );
          return res.events;
        },
        onBatch: async (rooms: SyncBatchRoom[]) => {
          const selfMatrixId =
            this.cache.login?.userId ??
            (await storage.get<string>('matrixUserId')) ??
            cfg.spec.matrixId;

          if (this.env.NARRA_ROOM_DO) {
            let forcedRefresh = false;
            for (const room of rooms) {
              if (room.events.length === 0) continue;
              let meta = await storage.get<RoomMeta>(`roomMeta:${room.roomId}`);
              if (!meta && !forcedRefresh) {
                forcedRefresh = true;
                await this.refreshNarraRoomsMeta(this.nowMs(), true);
                meta = await storage.get<RoomMeta>(`roomMeta:${room.roomId}`);
              }
              const mergedMembers = meta?.members?.length ? meta.members : room.members ?? [];
              const stub = this.env.NARRA_ROOM_DO.get(this.env.NARRA_ROOM_DO.idFromName(room.roomId));
              const response = await stub.fetch('https://narra-room/events', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  roomId: room.roomId,
                  ...(meta?.roomName ? { roomName: meta.roomName } : {}),
                  chatType: meta?.chatType ?? (mergedMembers.length === 2 && !meta?.roomName ? 'dm' : 'group'),
                  members: mergedMembers,
                  ...(selfMatrixId ? { selfMatrixId } : {}),
                  events: room.events,
                  limited: room.limited,
                  withheldGap: room.withheldGap,
                }),
              });
              if (!response.ok) {
                throw new SyncError(`Room coordinator ${room.roomId} returned HTTP ${response.status}`);
              }
            }
          }
          await storage.put('lastOk', this.nowMs());
        },
        log: (line) => {
          void appendDoLog(storage, line, this.nowMs(), this.env);
        },
      },
      this.cache,
    );

    if (this.isSyncActive()) {
      await storage.setAlarm(this.nowMs() + delay);
    } else {
      await storage.deleteAlarm();
      this.cache.login = undefined;
    }
  }
}

/**
 * Per-room Durable Object coordinator:
 * - Receives synced events (`POST /events`)
 * - Coalesces 1.8s bursts via `BurstCoalescer`, handles `m.room.redaction` and `m.replace` edits
 * - Hydrates `m.in_reply_to` parent snippets, tracks `latestEventId` / `latestHumanEventId` (`shouldQuote`)
 * - Maintains 3-min `activeSession[room, user]`, runs `routeEvent`, initializes & queries D1 `MemoryStore`
 * - Sends read receipt + `typing…`, runs `fastRespond` -> fallback `runManyfoldA2ATurn`
 * - Sanitizes output (`isSilence`, `stripLeakedNotes`, `sanitizeMobileLinks`, `renderMentions`)
 * - Posts with smart `m.in_reply_to` and Synapse 403 `agent_chain_exhausted` retry schedule `[15s, 45s, 120s]`
 */
export class BaseNarraRoomCoordinator<TEnv extends NarraGatewayEnv = NarraGatewayEnv> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: TEnv;
  private readonly explicitConfig?: NarraGatewayConfig<TEnv>;

  constructor(ctx: DurableObjectState, env: TEnv, config?: NarraGatewayConfig<TEnv>) {
    this.ctx = ctx;
    this.env = env;
    this.explicitConfig = config;
  }

  protected getConfig(): NarraGatewayConfig<TEnv> {
    if (this.explicitConfig) return this.explicitConfig;
    throw new Error(
      'BaseNarraRoomCoordinator requires config via super(ctx, env, config), createNarraWorkerGateway(config), or getConfig() override.',
    );
  }

  private nowMs(): number {
    return this.getConfig().now?.() ?? Date.now();
  }

  private async runLocked<T>(fn: () => Promise<T>): Promise<T> {
    if (typeof this.ctx.blockConcurrencyWhile === 'function') {
      return this.ctx.blockConcurrencyWhile(fn);
    }
    return fn();
  }

  private createCoalescer(nowMs: number, buffers?: PendingBurstBuffer[]): BurstCoalescer {
    const coalescer = new BurstCoalescer({
      windowMs: 1_800,
      scheduleTimers: false,
      now: () => nowMs,
    });
    if (buffers?.length) {
      coalescer.importState(buffers);
    }
    return coalescer;
  }

  private async getEffectiveSpec(): Promise<AgentSpec> {
    const cfg = this.getConfig();
    const storedMatrixId = await this.ctx.storage.get<string>('selfMatrixId');
    const matrixId = cfg.spec.matrixId ?? storedMatrixId ?? this.env.MATRIX_USER_ID;
    return matrixId ? { ...cfg.spec, matrixId } : cfg.spec;
  }

  private async getMemoryStore(): Promise<MemoryStore | null> {
    if (!isNarraGatewayEnabled(this.env) || !this.env.DB) return null;
    await ensureGatewaySchemas(this.env.DB);
    return new MemoryStore(this.env.DB, this.getConfig().spec.id);
  }

  private async matrixOp(op: NarraMatrixOp): Promise<NarraMatrixOpResult> {
    if (!isNarraSyncEnabled(this.env) || !this.env.NARRA_SYNC_DO) {
      return { ok: false, status: 0, errcode: 'SYNC_OFF' };
    }
    try {
      const stub = this.env.NARRA_SYNC_DO.get(this.env.NARRA_SYNC_DO.idFromName('narra'));
      const response = await stub.fetch('https://narra-sync/matrix', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(op),
      });
      return (await response.json()) as NarraMatrixOpResult;
    } catch {
      return { ok: false, status: 599, errcode: 'SYNC_DO_UNREACHABLE' };
    }
  }

  private async hydrateReplyTarget(
    roomId: string,
    replyToEventId: string | undefined,
    selfMatrixId: string | undefined,
  ): Promise<ReplyTargetContext | undefined> {
    if (!replyToEventId) return undefined;

    const ownMessages = (await this.ctx.storage.get<StoredOwnMessage[]>('ownMessages')) ?? [];
    const ownHit = ownMessages.find((m) => m.eventId === replyToEventId);
    if (ownHit) {
      return {
        eventId: replyToEventId,
        senderId: selfMatrixId ?? '',
        senderName: this.getConfig().spec.name,
        isSelf: true,
        isAgent: true,
        text: ownHit.text,
      };
    }

    const cache = (await this.ctx.storage.get<Record<string, StoredCachedMessage>>('messageCache')) ?? {};
    const cached = cache[replyToEventId];
    if (cached) {
      return {
        eventId: cached.eventId,
        senderId: cached.senderId,
        ...(cached.senderName ? { senderName: cached.senderName } : {}),
        isSelf: cached.isSelf || Boolean(selfMatrixId && cached.senderId === selfMatrixId),
        isAgent: cached.isAgent || isNarraAgent(cached.senderId),
        text: cached.text,
      };
    }

    const history = (await this.ctx.storage.get<HistoryTurn[]>('recentHistory')) ?? [];
    const histHit = history.find((h) => h.eventId === replyToEventId);
    if (histHit) {
      return {
        eventId: histHit.eventId,
        senderId: histHit.senderId,
        ...(histHit.senderName ? { senderName: histHit.senderName } : {}),
        isSelf: Boolean(histHit.isSelf) || Boolean(selfMatrixId && histHit.senderId === selfMatrixId),
        isAgent: histHit.isAgent || isNarraAgent(histHit.senderId),
        text: histHit.text,
      };
    }

    const fetched = await this.matrixOp({ op: 'fetchEvent', roomId, eventId: replyToEventId });
    if (fetched.ok && fetched.event) {
      const ev = fetched.event;
      const isSelf = Boolean(selfMatrixId && ev.senderId === selfMatrixId);
      const isAgent = isSelf || isNarraAgent(ev.senderId);
      cache[ev.eventId] = {
        eventId: ev.eventId,
        senderId: ev.senderId,
        ...(ev.senderName ? { senderName: ev.senderName } : {}),
        isSelf,
        isAgent,
        text: ev.text.slice(0, 1000),
        timestampMs: ev.timestampMs,
      };
      await this.trimAndPutMessageCache(cache);
      return {
        eventId: ev.eventId,
        senderId: ev.senderId,
        ...(ev.senderName ? { senderName: ev.senderName } : {}),
        isSelf,
        isAgent,
        text: ev.text,
      };
    }

    return undefined;
  }

  private async trimAndPutMessageCache(cache: Record<string, StoredCachedMessage>): Promise<void> {
    const entries = Object.values(cache)
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .slice(-MAX_MESSAGE_CACHE);
    const next: Record<string, StoredCachedMessage> = {};
    for (const item of entries) next[item.eventId] = item;
    await this.ctx.storage.put('messageCache', next);
  }

  private async scheduleNextAlarm(nowMs: number): Promise<number | null> {
    const bursts = (await this.ctx.storage.get<PendingBurstBuffer[]>('bursts')) ?? [];
    const coalescer = this.createCoalescer(nowMs, bursts);
    const burstAt = coalescer.nextFlushAt();
    const pendingTurns = (await this.ctx.storage.get<PendingTurn[]>('pendingTurns')) ?? [];
    let turnAt: number | null = null;
    for (const turn of pendingTurns) {
      if (turnAt === null || turn.dueAtMs < turnAt) turnAt = turn.dueAtMs;
    }
    let nextAt: number | null = null;
    if (burstAt !== null && turnAt !== null) nextAt = Math.min(burstAt, turnAt);
    else nextAt = burstAt ?? turnAt;

    if (nextAt !== null) {
      await this.ctx.storage.setAlarm(nextAt);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
    return nextAt;
  }

  private async computeShouldQuote(event: InboundEvent, chatType: ChatType): Promise<boolean> {
    const recentHistory = (await this.ctx.storage.get<HistoryTurn[]>('recentHistory')) ?? [];
    const latestEventId = await this.ctx.storage.get<string>('latestEventId');
    const latestHumanEventId = await this.ctx.storage.get<string>('latestHumanEventId');
    const coalescedSet = new Set(event.coalescedEventIds ?? [event.eventId]);

    const subsequentEvents = findSubsequentHistory(recentHistory, event).map((h) => ({
      eventId: h.eventId,
      senderId: h.senderId,
    }));

    // If the trigger event's own coalesced ID includes the latestHumanEventId, check whether
    // any non-coalesced human event sits strictly after it.
    const effectiveLatestHumanId =
      latestHumanEventId && coalescedSet.has(latestHumanEventId) ? event.eventId : latestHumanEventId;
    const effectiveLatestId =
      latestEventId && coalescedSet.has(latestEventId) ? event.eventId : latestEventId;

    return shouldQuote(event, {
      chatType,
      latestEventId: effectiveLatestId,
      latestHumanEventId: effectiveLatestHumanId,
      subsequentEvents,
    });
  }

  private async postReplyToRoom(
    roomId: string,
    text: string,
    txnSeed: string,
    selfMatrixId: string | undefined,
    replyToEventId: string | undefined,
  ): Promise<{ eventId: string }> {
    const txnId = await deterministicTxnId(txnSeed);
    const content = messageContent(text, {
      selfMatrixId,
      replyToEventId,
    });

    if (isNarraSyncEnabled(this.env) && this.env.NARRA_SYNC_DO) {
      const matrixRes = await this.matrixOp({
        op: 'send',
        roomId,
        txnId,
        content,
      });
      if (matrixRes.ok) {
        return { eventId: matrixRes.eventId ?? '' };
      }
      if (matrixRes.status !== 0) {
        const code = matrixRes.narraCode ?? matrixRes.errcode;
        throw makeSendFailure(
          `Matrix send failed: HTTP ${matrixRes.status}${code ? ` (${code})` : ''}`,
          matrixRes.status,
          { errcode: matrixRes.errcode, narraCode: matrixRes.narraCode },
        );
      }
    }

    return postViaNarraChatApi(this.env, {
      roomId,
      text: plainMentions(text, selfMatrixId ?? ''),
      txnId,
      replyToEventId,
      fetchImpl: this.getConfig().fetchImpl,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (request.method === 'GET' && path.endsWith('/status')) {
      const meta = (await this.ctx.storage.get<RoomMeta>('roomMeta')) ?? null;
      const bursts = (await this.ctx.storage.get<PendingBurstBuffer[]>('bursts')) ?? [];
      const pendingTurns = (await this.ctx.storage.get<PendingTurn[]>('pendingTurns')) ?? [];
      const history = (await this.ctx.storage.get<HistoryTurn[]>('recentHistory')) ?? [];
      const sessions = (await this.ctx.storage.get<Record<string, StoredSessionEntry>>('sessions')) ?? {};
      const nowMs = this.nowMs();
      const activeSessionCount = Object.values(sessions).filter((s) => s.expiresAtMs >= nowMs).length;
      const logs = (await this.ctx.storage.get<string[]>('log')) ?? [];

      let roomMuted = false;
      let roomThreshold: number | null = null;
      if (isNarraGatewayEnabled(this.env) && this.env.DB && meta?.roomId) {
        try {
          const mem = await this.getMemoryStore();
          if (mem) {
            roomMuted = await mem.isRoomMuted(meta.roomId);
            roomThreshold = await mem.getRoomThreshold(meta.roomId);
          }
        } catch {
          // Leave default flags if D1 check fails.
        }
      }

      return Response.json({
        enabled: isNarraGatewayEnabled(this.env),
        roomId: meta?.roomId ?? null,
        chatType: meta?.chatType ?? null,
        alarm: await this.ctx.storage.getAlarm(),
        bufferedBursts: bursts.length,
        pendingTurns: pendingTurns.length,
        latestEventId: (await this.ctx.storage.get<string>('latestEventId')) ?? null,
        latestHumanEventId: (await this.ctx.storage.get<string>('latestHumanEventId')) ?? null,
        consecutiveAgentMessages: (await this.ctx.storage.get<number>('consecutiveAgentMessages')) ?? 0,
        activeSessionCount,
        roomMuted,
        roomThreshold,
        recentHistoryCount: history.length,
        lastError: (await this.ctx.storage.get<string>('lastError')) ?? null,
        log: logs.map((l) => scrubSecrets(l, this.env)),
      });
    }

    if (request.method === 'GET' && path.endsWith('/history')) {
      if (!isNarraGatewayEnabled(this.env)) {
        return Response.json({ history: [] });
      }
      const history = (await this.ctx.storage.get<HistoryTurn[]>('recentHistory')) ?? [];
      return Response.json({ history });
    }

    if (request.method === 'POST' && path.endsWith('/agent-sent')) {
      if (!isNarraGatewayEnabled(this.env)) {
        return Response.json({ ok: true, enabled: false });
      }
      const body = (await request.json().catch(() => null)) as {
        roomId?: string;
        eventId?: string;
        senderId?: string;
        text?: string;
        timestampMs?: number;
      } | null;
      if (!body || typeof body.text !== 'string') {
        return Response.json({ ok: false, error: 'bad_payload' }, { status: 400 });
      }
      await this.runLocked(async () => {
        const nowMs = body.timestampMs ?? this.nowMs();
        const spec = await this.getEffectiveSpec();
        const senderId = body.senderId || spec.matrixId || '';
        const eventId = body.eventId || `broadcast:${nowMs}`;
        const history = (await this.ctx.storage.get<HistoryTurn[]>('recentHistory')) ?? [];
        history.push({
          eventId,
          senderId,
          senderName: spec.name,
          isAgent: true,
          isSelf: true,
          text: body.text!.slice(0, 1000),
          timestampMs: nowMs,
        });
        await this.ctx.storage.put('recentHistory', history.slice(-MAX_RECENT_HISTORY));
        const consec = ((await this.ctx.storage.get<number>('consecutiveAgentMessages')) ?? 0) + 1;
        await this.ctx.storage.put('consecutiveAgentMessages', consec);
        if (eventId) await this.ctx.storage.put('latestEventId', eventId);
      });
      return Response.json({ ok: true });
    }

    if (request.method === 'POST' && path.endsWith('/events')) {
      if (!isNarraGatewayEnabled(this.env)) {
        await this.ctx.storage.deleteAlarm();
        return Response.json({ ok: true, enabled: false, ignored: true });
      }

      const payload = (await request.json().catch(() => null)) as {
        roomId?: string;
        roomName?: string;
        chatType?: ChatType;
        members?: RoomMemberInfo[];
        selfMatrixId?: string;
        events?: unknown[];
      } | null;

      if (!payload || !Array.isArray(payload.events)) {
        return Response.json({ ok: false, error: 'bad_events_payload' }, { status: 400 });
      }

      const outcome = await this.runLocked(async () => {
        const nowMs = this.nowMs();
        if (payload.selfMatrixId && payload.selfMatrixId.startsWith('@')) {
          await this.ctx.storage.put('selfMatrixId', payload.selfMatrixId);
        }
        const effectiveSpec = await this.getEffectiveSpec();
        const selfMatrixId = effectiveSpec.matrixId;

        const existingMeta = await this.ctx.storage.get<RoomMeta>('roomMeta');
        const roomId = payload.roomId || existingMeta?.roomId || '';
        const chatType: ChatType =
          payload.chatType === 'dm' || payload.chatType === 'group'
            ? payload.chatType
            : (existingMeta?.chatType ?? 'group');
        const roomName = payload.roomName ?? existingMeta?.roomName;
        const members = payload.members?.length ? payload.members : (existingMeta?.members ?? []);
        if (roomId) {
          await this.ctx.storage.put('roomMeta', {
            roomId,
            ...(roomName ? { roomName } : {}),
            chatType,
            members,
            updatedAtMs: nowMs,
          } satisfies RoomMeta);
        }

        const handledList = (await this.ctx.storage.get<string[]>('handledIds')) ?? [];
        const handledSet = new Set(handledList);
        const redactedList = (await this.ctx.storage.get<string[]>('redactedIds')) ?? [];
        const redactedSet = new Set(redactedList);
        let history = (await this.ctx.storage.get<HistoryTurn[]>('recentHistory')) ?? [];
        let ownMessages = (await this.ctx.storage.get<StoredOwnMessage[]>('ownMessages')) ?? [];
        const messageCache =
          (await this.ctx.storage.get<Record<string, StoredCachedMessage>>('messageCache')) ?? {};
        let latestEventId = await this.ctx.storage.get<string>('latestEventId');
        let latestHumanEventId = await this.ctx.storage.get<string>('latestHumanEventId');
        let consecutiveAgentMessages =
          (await this.ctx.storage.get<number>('consecutiveAgentMessages')) ?? 0;
        let roomLanguageHint = await this.ctx.storage.get<LangCode>('roomLanguageHint');
        const userLanguageHints =
          (await this.ctx.storage.get<Record<string, LangCode>>('userLanguageHints')) ?? {};
        const storedBursts = (await this.ctx.storage.get<PendingBurstBuffer[]>('bursts')) ?? [];
        let pendingTurns = (await this.ctx.storage.get<PendingTurn[]>('pendingTurns')) ?? [];
        const coalescer = this.createCoalescer(nowMs, storedBursts);

        let accepted = 0;

        const mentionNames = [
          effectiveSpec.name,
          ...(effectiveSpec.aliases ?? []),
          ...members.flatMap((m) => (m.displayName ? [m.displayName] : [])),
        ].filter((s): s is string => typeof s === 'string' && s.trim().length > 0);

        for (const rawEv of payload.events!) {
          const ev = isNormalizedInboundEvent(rawEv)
            ? {
                ...rawEv,
                roomId: rawEv.roomId || roomId,
                chatType:
                  payload.chatType === 'dm' || payload.chatType === 'group'
                    ? payload.chatType
                    : (rawEv.chatType ?? chatType),
                ...(rawEv.roomName || roomName ? { roomName: rawEv.roomName ?? roomName } : {}),
              }
            : parseMatrixEvent(rawEv, {
                roomId,
                roomName,
                chatType,
              });

          if (!ev) continue;
          if (handledSet.has(ev.eventId)) continue;
          handledSet.add(ev.eventId);
          handledList.push(ev.eventId);
          accepted++;

          if (ev.roomId && !roomId) {
            await this.ctx.storage.put('roomMeta', {
              roomId: ev.roomId,
              ...(ev.roomName ? { roomName: ev.roomName } : {}),
              chatType: ev.chatType,
              members,
              updatedAtMs: nowMs,
            } satisfies RoomMeta);
          }

          if (ev.kind === 'redaction' && ev.redactsEventId) {
            const targetId = ev.redactsEventId;
            if (!redactedSet.has(targetId)) {
              redactedSet.add(targetId);
              redactedList.push(targetId);
            }
            await coalescer.push(ev);
            pendingTurns = pendingTurns.filter((turn) => {
              const ids = turn.event.coalescedEventIds ?? [turn.event.eventId];
              return turn.event.eventId !== targetId && !ids.includes(targetId);
            });
            history = history.filter((h) => h.eventId !== targetId);
            ownMessages = ownMessages.filter((o) => o.eventId !== targetId);
            delete messageCache[targetId];
            if (latestEventId === targetId) {
              latestEventId = history.at(-1)?.eventId;
            }
            if (latestHumanEventId === targetId) {
              const prevHuman = [...history].reverse().find((h) => !h.isAgent && !isNarraAgent(h.senderId));
              latestHumanEventId = prevHuman?.eventId;
            }
            continue;
          }

          if (redactedSet.has(ev.eventId)) continue;

          if (ev.kind === 'edit' && ev.replacesEventId) {
            const targetId = ev.replacesEventId;
            const histMatch = history.find((h) => h.eventId === targetId);
            if (histMatch) histMatch.text = ev.text.slice(0, 1000);
            const ownMatch = ownMessages.find((o) => o.eventId === targetId);
            if (ownMatch) ownMatch.text = ev.text.slice(0, 1000);
            if (messageCache[targetId]) {
              messageCache[targetId].text = ev.text.slice(0, 1000);
            }
            await coalescer.push(ev);
            for (const turn of pendingTurns) {
              if (turn.answer !== undefined) continue;
              const ids = turn.event.coalescedEventIds ?? [turn.event.eventId];
              if (turn.event.eventId === targetId || ids.includes(targetId)) {
                turn.event = {
                  ...turn.event,
                  text: ev.text,
                  mentions: ev.mentions.length ? ev.mentions : turn.event.mentions,
                };
              }
            }
            continue;
          }

          const isSelf = Boolean(selfMatrixId && ev.senderId === selfMatrixId);
          const isAgent = isSelf || isNarraAgent(ev.senderId);

          if (isSelf) {
            if (ev.kind !== 'reaction') {
              ownMessages.push({
                eventId: ev.eventId,
                text: ev.text.slice(0, 1000),
                timestampMs: ev.timestampMs,
              });
              history.push({
                eventId: ev.eventId,
                senderId: ev.senderId,
                senderName: ev.senderName ?? effectiveSpec.name,
                isAgent: true,
                isSelf: true,
                text: ev.text.slice(0, 1000),
                timestampMs: ev.timestampMs,
              });
              messageCache[ev.eventId] = {
                eventId: ev.eventId,
                senderId: ev.senderId,
                senderName: ev.senderName ?? effectiveSpec.name,
                isAgent: true,
                isSelf: true,
                text: ev.text.slice(0, 1000),
                timestampMs: ev.timestampMs,
              };
              latestEventId = ev.eventId;
              consecutiveAgentMessages++;
            }
            continue;
          }

          if (isAgent) {
            if (ev.kind !== 'reaction') {
              history.push({
                eventId: ev.eventId,
                senderId: ev.senderId,
                ...(ev.senderName ? { senderName: ev.senderName } : {}),
                isAgent: true,
                isSelf: false,
                text: ev.text.slice(0, 1000),
                timestampMs: ev.timestampMs,
              });
              messageCache[ev.eventId] = {
                eventId: ev.eventId,
                senderId: ev.senderId,
                ...(ev.senderName ? { senderName: ev.senderName } : {}),
                isAgent: true,
                isSelf: false,
                text: ev.text.slice(0, 1000),
                timestampMs: ev.timestampMs,
              };
              latestEventId = ev.eventId;
              consecutiveAgentMessages++;
            }
            continue;
          }

          // Human event
          if (ev.kind !== 'reaction') {
            consecutiveAgentMessages = 0;
            latestEventId = ev.eventId;
            latestHumanEventId = ev.eventId;
            history.push({
              eventId: ev.eventId,
              senderId: ev.senderId,
              ...(ev.senderName ? { senderName: ev.senderName } : {}),
              isAgent: false,
              isSelf: false,
              text: ev.text.slice(0, 1000),
              timestampMs: ev.timestampMs,
            });
            messageCache[ev.eventId] = {
              eventId: ev.eventId,
              senderId: ev.senderId,
              ...(ev.senderName ? { senderName: ev.senderName } : {}),
              isAgent: false,
              isSelf: false,
              text: ev.text.slice(0, 1000),
              timestampMs: ev.timestampMs,
            };
            if (hasExplicitLangSignal(ev.text, mentionNames)) {
              const explicit = detectLang(ev.text, undefined, undefined, {
                extraMentionNames: mentionNames,
              });
              userLanguageHints[ev.senderId] = explicit;
              roomLanguageHint = explicit;
            }
          }

          const pushed = await coalescer.push(ev);
          if (pushed.status === 'flushed' || pushed.status === 'bypass') {
            const target = pushed.event;
            const alreadyQueued = pendingTurns.some((t) => t.event.eventId === target.eventId);
            if (!alreadyQueued && pendingTurns.length < MAX_QUEUE_SIZE) {
              pendingTurns.push({
                event: target,
                attempts: 0,
                enqueuedAtMs: nowMs,
                dueAtMs: nowMs,
              });
            }
          }
        }

        await this.ctx.storage.put('handledIds', handledList.slice(-MAX_HANDLED_IDS));
        await this.ctx.storage.put('redactedIds', redactedList.slice(-MAX_REDACTED_IDS));
        await this.ctx.storage.put('recentHistory', history.slice(-MAX_RECENT_HISTORY));
        await this.ctx.storage.put('ownMessages', ownMessages.slice(-MAX_OWN_MESSAGES));
        await this.trimAndPutMessageCache(messageCache);
        if (latestEventId !== undefined) await this.ctx.storage.put('latestEventId', latestEventId);
        else await this.ctx.storage.delete('latestEventId');
        if (latestHumanEventId !== undefined) {
          await this.ctx.storage.put('latestHumanEventId', latestHumanEventId);
        } else {
          await this.ctx.storage.delete('latestHumanEventId');
        }
        await this.ctx.storage.put('consecutiveAgentMessages', consecutiveAgentMessages);
        if (roomLanguageHint) await this.ctx.storage.put('roomLanguageHint', roomLanguageHint);
        await this.ctx.storage.put('userLanguageHints', userLanguageHints);
        await this.ctx.storage.put('bursts', coalescer.exportState());
        await this.ctx.storage.put('pendingTurns', pendingTurns);

        const nextAlarmAt = await this.scheduleNextAlarm(nowMs);
        return {
          ok: true,
          enabled: true,
          accepted,
          buffered: coalescer.pendingCount(),
          queued: pendingTurns.length,
          nextAlarmAt,
        };
      });

      return Response.json(outcome);
    }

    return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  private async isTurnRedacted(turn: PendingTurn): Promise<boolean> {
    const redactedSet = new Set((await this.ctx.storage.get<string[]>('redactedIds')) ?? []);
    const ids = turn.event.coalescedEventIds ?? [turn.event.eventId];
    return redactedSet.has(turn.event.eventId) || ids.every((id) => redactedSet.has(id));
  }

  private async removePendingTurn(eventId: string): Promise<void> {
    await this.runLocked(async () => {
      const current = (await this.ctx.storage.get<PendingTurn[]>('pendingTurns')) ?? [];
      const filtered = current.filter((t) => t.event.eventId !== eventId);
      await this.ctx.storage.put('pendingTurns', filtered);
    });
  }

  private async updatePendingTurn(updated: PendingTurn): Promise<void> {
    await this.runLocked(async () => {
      const current = (await this.ctx.storage.get<PendingTurn[]>('pendingTurns')) ?? [];
      const idx = current.findIndex((t) => t.event.eventId === updated.event.eventId);
      if (idx >= 0) {
        current[idx] = updated;
        await this.ctx.storage.put('pendingTurns', current);
      }
    });
  }

  private async buildRoomContextForTurn(
    turn: PendingTurn,
    effectiveSpec: AgentSpec,
    memoryStore: MemoryStore | null,
    nowMs: number,
  ): Promise<RoomContext> {
    const meta = (await this.ctx.storage.get<RoomMeta>('roomMeta')) ?? {
      roomId: turn.event.roomId,
      chatType: turn.event.chatType,
      members: [],
      updatedAtMs: nowMs,
    };
    const recentHistory = (await this.ctx.storage.get<HistoryTurn[]>('recentHistory')) ?? [];
    const consecutiveAgentMessages =
      (await this.ctx.storage.get<number>('consecutiveAgentMessages')) ?? 0;
    const roomLanguageHint = await this.ctx.storage.get<LangCode>('roomLanguageHint');
    const userLanguageHints =
      (await this.ctx.storage.get<Record<string, LangCode>>('userLanguageHints')) ?? {};
    const sessions = (await this.ctx.storage.get<Record<string, StoredSessionEntry>>('sessions')) ?? {};
    const latestEventId = await this.ctx.storage.get<string>('latestEventId');
    const latestHumanEventId = await this.ctx.storage.get<string>('latestHumanEventId');

    const replyToTarget = await this.hydrateReplyTarget(
      turn.event.roomId,
      turn.event.replyToEventId,
      effectiveSpec.matrixId,
    );

    const session = sessions[turn.event.senderId];
    const activeSession =
      session && session.expiresAtMs >= nowMs
        ? { active: true, ...session }
        : { active: false };

    let roomMuted = false;
    let roomThreshold: number | undefined;
    if (memoryStore) {
      roomMuted = await memoryStore.isRoomMuted(turn.event.roomId);
      roomThreshold = await memoryStore.getRoomThreshold(turn.event.roomId);
    }

    const coalescedSet = new Set(turn.event.coalescedEventIds ?? [turn.event.eventId]);
    const subsequentEvents = findSubsequentHistory(recentHistory, turn.event).map((h) => ({
      eventId: h.eventId,
      senderId: h.senderId,
    }));

    const effectiveLatestHumanId =
      latestHumanEventId && coalescedSet.has(latestHumanEventId)
        ? turn.event.eventId
        : latestHumanEventId;
    const effectiveLatestId =
      latestEventId && coalescedSet.has(latestEventId) ? turn.event.eventId : latestEventId;

    const members = meta.members;
    const peers = inspectRoomPeers(members, effectiveSpec.matrixId);

    return {
      roomId: turn.event.roomId,
      roomName: turn.event.roomName ?? meta.roomName,
      chatType: meta.chatType ?? turn.event.chatType,
      members,
      peers,
      recentHistory,
      ...(replyToTarget ? { replyToTarget } : {}),
      consecutiveAgentMessages,
      ...(roomLanguageHint ? { roomLanguageHint } : {}),
      ...(userLanguageHints[turn.event.senderId]
        ? { userLanguageHint: userLanguageHints[turn.event.senderId] }
        : {}),
      roomMuted,
      ...(roomThreshold !== undefined ? { roomThreshold } : {}),
      activeSession,
      subsequentEvents,
      ...(effectiveLatestId ? { latestEventId: effectiveLatestId } : {}),
      ...(effectiveLatestHumanId ? { latestHumanEventId: effectiveLatestHumanId } : {}),
    };
  }

  async alarm(): Promise<void> {
    if (!isNarraGatewayEnabled(this.env)) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const cfg = this.getConfig();
    const nowMs = this.nowMs();
    const chainTracker = new AgentChainTracker(AGENT_CHAIN_CAP, AGENT_CHAIN_RETRY_MS);

    // 1. Flush any due BurstCoalescer buffers into pendingTurns atomically.
    await this.runLocked(async () => {
      const storedBursts = (await this.ctx.storage.get<PendingBurstBuffer[]>('bursts')) ?? [];
      const coalescer = this.createCoalescer(nowMs, storedBursts);
      const flushed = await coalescer.flushDue(nowMs);
      const pendingTurns = (await this.ctx.storage.get<PendingTurn[]>('pendingTurns')) ?? [];
      const redactedSet = new Set((await this.ctx.storage.get<string[]>('redactedIds')) ?? []);

      for (const merged of flushed) {
        const ids = merged.coalescedEventIds ?? [merged.eventId];
        if (redactedSet.has(merged.eventId) || ids.every((id) => redactedSet.has(id))) {
          continue;
        }
        if (!pendingTurns.some((t) => t.event.eventId === merged.eventId) && pendingTurns.length < MAX_QUEUE_SIZE) {
          pendingTurns.push({
            event: merged,
            attempts: 0,
            enqueuedAtMs: nowMs,
            dueAtMs: nowMs,
          });
        }
      }

      await this.ctx.storage.put('bursts', coalescer.exportState());
      await this.ctx.storage.put('pendingTurns', pendingTurns);
    });

    // 2. Drain due pendingTurns sequentially in FIFO order.
    while (true) {
      const pendingTurns = (await this.ctx.storage.get<PendingTurn[]>('pendingTurns')) ?? [];
      const nextTurn = pendingTurns.find((t) => t.dueAtMs <= this.nowMs());
      if (!nextTurn) break;

      const currentNowMs = this.nowMs();
      if (currentNowMs - nextTurn.enqueuedAtMs > MAX_TURN_AGE_MS) {
        await appendDoLog(this.ctx.storage, `dropped stale turn ${nextTurn.event.eventId}`, currentNowMs, this.env);
        await this.removePendingTurn(nextTurn.event.eventId);
        continue;
      }

      if (await this.isTurnRedacted(nextTurn)) {
        await appendDoLog(this.ctx.storage, `dropped redacted turn ${nextTurn.event.eventId}`, currentNowMs, this.env);
        await this.removePendingTurn(nextTurn.event.eventId);
        continue;
      }

      const effectiveSpec = await this.getEffectiveSpec();
      const memoryStore = await this.getMemoryStore();

      try {
        let answer = nextTurn.answer;
        let decision = nextTurn.decision;

        if (answer === undefined) {
          const context = await this.buildRoomContextForTurn(
            nextTurn,
            effectiveSpec,
            memoryStore,
            currentNowMs,
          );

          decision = await routeEvent(nextTurn.event, context, effectiveSpec, {
            nowMs: currentNowMs,
            triageModel: cfg.triageModel?.(this.env),
            chainCap: AGENT_CHAIN_CAP,
          });

          if (!decision.shouldReply) {
            await appendDoLog(
              this.ctx.storage,
              `dropped ${nextTurn.event.eventId}: ${decision.reason}`,
              currentNowMs,
              this.env,
            );
            await this.removePendingTurn(nextTurn.event.eventId);
            continue;
          }

          // Slide active 3-min session on user follow-up inside group.
          if (context.chatType === 'group' && nextTurn.event.senderId) {
            await this.runLocked(async () => {
              const sessions =
                (await this.ctx.storage.get<Record<string, StoredSessionEntry>>('sessions')) ?? {};
              const prev = sessions[nextTurn.event.senderId];
              if (prev) {
                const win = effectiveSpec.sessionWindowMs ?? DEFAULT_SESSION_WINDOW_MS;
                sessions[nextTurn.event.senderId] = {
                  ...prev,
                  lastUserTurnAtMs: currentNowMs,
                  expiresAtMs: currentNowMs + win,
                };
                await this.ctx.storage.put('sessions', sessions);
              }
            });
          }

          // Polite yield for unmentioned / multi-@ turns so peers don't pile on.
          if (decision.yieldDelayMs && decision.yieldDelayMs > 0) {
            const yieldOutcome = await executePoliteYield({
              delayMs: decision.yieldDelayMs,
              sleep: cfg.sleep,
              checkPeerAnswered: async () => {
                const latestHistory =
                  (await this.ctx.storage.get<HistoryTurn[]>('recentHistory')) ?? [];
                return hasPeerRepliedAfter(
                  nextTurn.event,
                  { ...context, recentHistory: latestHistory },
                  effectiveSpec.matrixId,
                );
              },
            });
            if (yieldOutcome.yield) {
              await appendDoLog(
                this.ctx.storage,
                `yielded ${nextTurn.event.eventId}: ${yieldOutcome.reason}`,
                this.nowMs(),
                this.env,
              );
              await this.removePendingTurn(nextTurn.event.eventId);
              continue;
            }
          }

          if (await this.isTurnRedacted(nextTurn)) {
            await this.removePendingTurn(nextTurn.event.eventId);
            continue;
          }

          // Optional fail-closed Narra authorize-event check.
          if (cfg.authorizeEvents || (this.env.NARRA_AUTHORIZE_EVENTS ?? '').trim() === 'on') {
            const { authorizeEvent } = await import('./sync.js');
            const auth = await authorizeEvent(
              {
                narraApiEndpoint: narraEndpoint(this.env),
                narraAgentToken: this.env.NARRA_AGENT_TOKEN,
                fetchImpl: cfg.fetchImpl,
              },
              {
                roomId: nextTurn.event.roomId,
                senderMatrixUserId: nextTurn.event.senderId,
                memberMatrixUserIds: context.members.map((m) => m.matrixId),
                mentioned:
                  Boolean(effectiveSpec.matrixId && nextTurn.event.mentions.includes(effectiveSpec.matrixId)),
              },
            );
            if (!auth.allow) {
              await appendDoLog(
                this.ctx.storage,
                `unauthorized ${nextTurn.event.eventId}: ${auth.reason ?? 'denied'}`,
                this.nowMs(),
                this.env,
              );
              await this.removePendingTurn(nextTurn.event.eventId);
              continue;
            }
          }

          const memories = memoryStore
            ? await memoryStore.recallForTurn({
                roomId: nextTurn.event.roomId,
                userId: nextTurn.event.senderId,
                chatType: context.chatType,
              })
            : emptyMemories();

          // Send read receipt + typing indicator before generating response.
          if (nextTurn.event.eventId) {
            await this.matrixOp({
              op: 'receipt',
              roomId: nextTurn.event.roomId,
              eventId: nextTurn.event.eventId,
            }).catch(() => undefined);
          }

          let typingActive = false;
          let typingTimer: ReturnType<typeof setInterval> | undefined;
          const typingRes = await this.matrixOp({
            op: 'typing',
            roomId: nextTurn.event.roomId,
            typing: true,
          }).catch(() => ({ ok: false as const, status: 0 }));
          if (typingRes.ok) {
            typingActive = true;
            typingTimer = setInterval(() => {
              void this.matrixOp({
                op: 'typing',
                roomId: nextTurn.event.roomId,
                typing: true,
              }).catch(() => undefined);
            }, TYPING_REFRESH_MS);
          }

          let rawAnswer = '';
          try {
            const envelope = buildPromptEnvelope({
              event: nextTurn.event,
              context,
              decision,
              memories,
              spec: effectiveSpec,
            });

            let handledFast = false;
            if (cfg.fastRespond) {
              try {
                const fast = await cfg.fastRespond(this.env, nextTurn.event, decision, memories);
                if (fast !== null && fast !== undefined) {
                  rawAnswer = fast;
                  handledFast = true;
                }
              } catch {
                // Fall back seamlessly to Manyfold A2A.
              }
            }

            if (!handledFast) {
              const cred = await (cfg.resolveA2ACredential?.(this.env) ??
                defaultResolveA2ACredential(this.env, effectiveSpec));
              if (!cred || !cred.url || !cred.token) {
                throw new A2AError('No A2A credential available for Narra gateway.', false);
              }
              rawAnswer = await runManyfoldA2ATurn({
                credential: {
                  rpcUrl: cred.url,
                  token: cred.token,
                  label: cred.label ?? effectiveSpec.name,
                },
                envelope,
                eventId: nextTurn.event.eventId,
                fetchImpl: cfg.fetchImpl,
              });
            }
          } finally {
            if (typingTimer !== undefined) clearInterval(typingTimer);
            if (typingActive) {
              await this.matrixOp({
                op: 'typing',
                roomId: nextTurn.event.roomId,
                typing: false,
              }).catch(() => undefined);
            }
          }

          const { text: withoutNotes } = stripLeakedNotes(rawAnswer);
          const cleaned = withoutNotes ? sanitizeMobileLinks(withoutNotes) : '';
          if (!cleaned || isSilence(cleaned)) {
            await appendDoLog(
              this.ctx.storage,
              `silent ${nextTurn.event.eventId} (${decision.reason})`,
              this.nowMs(),
              this.env,
            );
            await this.removePendingTurn(nextTurn.event.eventId);
            continue;
          }

          // Persist generated answer before posting so 403/5xx retries never re-bill an LLM turn.
          answer = cleaned;
          nextTurn.answer = answer;
          nextTurn.decision = decision;
          await this.updatePendingTurn(nextTurn);
        }

        if (await this.isTurnRedacted(nextTurn)) {
          await this.removePendingTurn(nextTurn.event.eventId);
          continue;
        }

        const meta = await this.ctx.storage.get<RoomMeta>('roomMeta');
        const chatType = meta?.chatType ?? nextTurn.event.chatType;
        const quoteNow = await this.computeShouldQuote(nextTurn.event, chatType);
        const replyToEventId = quoteNow ? nextTurn.event.eventId : undefined;

        const posted = await this.postReplyToRoom(
          nextTurn.event.roomId,
          answer,
          nextTurn.event.eventId,
          effectiveSpec.matrixId,
          replyToEventId,
        );

        const repliedAtMs = this.nowMs();
        await this.runLocked(async () => {
          const ownMessages = (await this.ctx.storage.get<StoredOwnMessage[]>('ownMessages')) ?? [];
          const postedEventId = posted.eventId || `sent:${nextTurn.event.eventId}`;
          ownMessages.push({
            eventId: postedEventId,
            text: answer.slice(0, 1000),
            timestampMs: repliedAtMs,
          });
          await this.ctx.storage.put('ownMessages', ownMessages.slice(-MAX_OWN_MESSAGES));

          const history = (await this.ctx.storage.get<HistoryTurn[]>('recentHistory')) ?? [];
          history.push({
            eventId: postedEventId,
            senderId: effectiveSpec.matrixId ?? '',
            senderName: effectiveSpec.name,
            isAgent: true,
            isSelf: true,
            text: answer.slice(0, 1000),
            timestampMs: repliedAtMs,
          });
          await this.ctx.storage.put('recentHistory', history.slice(-MAX_RECENT_HISTORY));

          const consec = ((await this.ctx.storage.get<number>('consecutiveAgentMessages')) ?? 0) + 1;
          await this.ctx.storage.put('consecutiveAgentMessages', consec);
          if (posted.eventId) {
            await this.ctx.storage.put('latestEventId', posted.eventId);
          }

          if (nextTurn.event.senderId) {
            const sessions =
              (await this.ctx.storage.get<Record<string, StoredSessionEntry>>('sessions')) ?? {};
            const win = effectiveSpec.sessionWindowMs ?? DEFAULT_SESSION_WINDOW_MS;
            sessions[nextTurn.event.senderId] = {
              lastAgentReplyAtMs: repliedAtMs,
              lastUserTurnAtMs: nextTurn.event.timestampMs,
              expiresAtMs: repliedAtMs + win,
            };
            await this.ctx.storage.put('sessions', sessions);
          }
        });

        await this.ctx.storage.delete('lastError');
        await appendDoLog(
          this.ctx.storage,
          `answered ${nextTurn.event.eventId} (quote=${quoteNow})`,
          repliedAtMs,
          this.env,
        );
        await this.removePendingTurn(nextTurn.event.eventId);
      } catch (error) {
        const attempts = nextTurn.attempts + 1;
        const failNow = this.nowMs();
        const errMsg = scrubSecrets(error instanceof Error ? error.message : error, this.env);
        await this.ctx.storage.put('lastError', errMsg);

        let delayMs: number | null = null;
        if (isChainExhaustedError(error)) {
          delayMs = chainTracker.nextRetryDelayMs(attempts);
        } else if (error instanceof A2AError) {
          delayMs = error.retryable && attempts < MAX_POST_ATTEMPTS ? 5_000 * 2 ** (attempts - 1) : null;
        } else if (typeof (error as Partial<SendFailureError>)?.retryable === 'boolean') {
          const sf = error as SendFailureError;
          delayMs = sf.retryable && attempts < MAX_POST_ATTEMPTS ? 5_000 * 2 ** (attempts - 1) : null;
        } else {
          delayMs = attempts < MAX_POST_ATTEMPTS ? 5_000 * 2 ** (attempts - 1) : null;
        }

        if (delayMs === null) {
          await appendDoLog(
            this.ctx.storage,
            `gave up on ${nextTurn.event.eventId} after ${attempts} attempt(s): ${errMsg}`,
            failNow,
            this.env,
          );
          await this.removePendingTurn(nextTurn.event.eventId);
          continue;
        }

        nextTurn.attempts = attempts;
        nextTurn.dueAtMs = failNow + delayMs;
        nextTurn.lastError = errMsg;
        await this.updatePendingTurn(nextTurn);
        await appendDoLog(
          this.ctx.storage,
          `retry ${nextTurn.event.eventId} attempt=${attempts} in ${delayMs}ms: ${errMsg}`,
          failNow,
          this.env,
        );
        // Stop draining this room so FIFO order is preserved until retry dueAtMs.
        break;
      }
    }

    // 3. Schedule next alarm for any remaining burst buffers or pending turn retries.
    await this.scheduleNextAlarm(this.nowMs());
  }
}

/**
 * Kicks the Narra Gateway on cron/request:
 * - When `isNarraGatewayEnabled(env)` is false, returns IMMEDIATELY with 0 external calls,
 *   0 D1 queries, and 0 DO fetches.
 * - When enabled, kicks `NARRA_SYNC_DO` (`POST /kick`) and runs staggered `ProactiveBroadcastScheduler`
 *   against `config.fetchUpdates` if provided.
 */
export async function kickNarraGateway<TEnv extends NarraGatewayEnv = NarraGatewayEnv>(
  env: TEnv,
  config?: NarraGatewayConfig<TEnv>,
): Promise<NarraGatewayKickResult> {
  if (!isNarraGatewayEnabled(env)) {
    return {
      enabled: false,
      syncKicked: false,
      syncRunning: false,
      broadcast: null,
    };
  }

  let syncKicked = false;
  let syncRunning = false;

  if (env.NARRA_SYNC_DO) {
    try {
      const stub = env.NARRA_SYNC_DO.get(env.NARRA_SYNC_DO.idFromName('narra'));
      const response = await stub.fetch('https://narra-sync/kick', { method: 'POST' });
      syncKicked = response.ok;
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as { running?: boolean } | null;
        syncRunning = body?.running === true;
      }
    } catch {
      syncKicked = false;
    }
  }

  let broadcast: BroadcastScheduleResult | null = null;
  if (config?.fetchUpdates) {
    const nowMs = config.now?.() ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    let sinceIso = new Date(nowMs - 24 * 60 * 60_000).toISOString();
    let memoryStore: MemoryStore | undefined;
    const dedupeStore = env.DB
      ? await (async () => {
          await ensureGatewaySchemas(env.DB!);
          memoryStore = new MemoryStore(env.DB!, config.spec.id);
          const row = await env.DB!
            .prepare('SELECT last_broadcast_iso FROM narra_gateway_state WHERE agent_id = ?')
            .bind(config.spec.id)
            .first<{ last_broadcast_iso: string }>();
          if (row?.last_broadcast_iso) {
            sinceIso = row.last_broadcast_iso;
          }
          return new D1BroadcastStore(env.DB!);
        })()
      : new InMemoryBroadcastStore();

    const updates = await config.fetchUpdates(env, sinceIso);
    const enforceStaggerWindow =
      config.enforceBroadcastStagger ?? (env.NARRA_BROADCAST_STAGGER ?? '').trim() !== 'off';

    const scheduler = new ProactiveBroadcastScheduler({
      agentId: config.spec.id,
      dedupeStore,
      memoryStore,
      enforceStaggerWindow,
      nowMs: () => nowMs,
      ...(config.isRoomOptedOut
        ? { isRoomOptedOut: (roomId: string) => config.isRoomOptedOut!(env, roomId) }
        : {}),
      getRecentHistory: async (roomId: string) => {
        if (!env.NARRA_ROOM_DO) return [];
        try {
          const stub = env.NARRA_ROOM_DO.get(env.NARRA_ROOM_DO.idFromName(roomId));
          const res = await stub.fetch('https://narra-room/history');
          if (!res.ok) return [];
          const body = (await res.json().catch(() => null)) as { history?: HistoryTurn[] } | null;
          return Array.isArray(body?.history) ? body.history : [];
        } catch {
          return [];
        }
      },
      send: async (item: AgentUpdateItem, cleanText: string) => {
        const txnId = await deterministicTxnId(`broadcast:${config.spec.id}:${item.roomId}:${item.updateKey}`);
        let postedEventId = '';
        if (isNarraSyncEnabled(env) && env.NARRA_SYNC_DO) {
          const syncStub = env.NARRA_SYNC_DO.get(env.NARRA_SYNC_DO.idFromName('narra'));
          const matRes = await syncStub.fetch('https://narra-sync/matrix', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              op: 'send',
              roomId: item.roomId,
              txnId,
              content: messageContent(cleanText, { selfMatrixId: config.spec.matrixId }),
            } satisfies NarraMatrixOp),
          });
          const matBody = (await matRes.json().catch(() => null)) as NarraMatrixOpResult | null;
          if (matBody?.ok) {
            postedEventId = matBody.eventId ?? '';
          } else if (matBody && matBody.status !== 0) {
            throw makeSendFailure(
              `Broadcast Matrix send failed: HTTP ${matBody.status}`,
              matBody.status,
              { errcode: matBody.errcode, narraCode: matBody.narraCode },
            );
          } else {
            const fallback = await postViaNarraChatApi(env, {
              roomId: item.roomId,
              text: plainMentions(cleanText, config.spec.matrixId ?? ''),
              txnId,
              fetchImpl: config.fetchImpl,
            });
            postedEventId = fallback.eventId;
          }
        } else {
          const fallback = await postViaNarraChatApi(env, {
            roomId: item.roomId,
            text: plainMentions(cleanText, config.spec.matrixId ?? ''),
            txnId,
            fetchImpl: config.fetchImpl,
          });
          postedEventId = fallback.eventId;
        }

        if (env.NARRA_ROOM_DO) {
          try {
            const roomStub = env.NARRA_ROOM_DO.get(env.NARRA_ROOM_DO.idFromName(item.roomId));
            await roomStub.fetch('https://narra-room/agent-sent', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                roomId: item.roomId,
                eventId: postedEventId,
                senderId: config.spec.matrixId,
                text: cleanText,
                timestampMs: nowMs,
              }),
            });
          } catch {
            // Non-fatal: message already delivered.
          }
        }
      },
    });

    broadcast = await scheduler.run(updates);

    if (env.DB) {
      await env.DB
        .prepare(
          `INSERT INTO narra_gateway_state (agent_id, last_broadcast_iso, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT (agent_id) DO UPDATE SET
             last_broadcast_iso = excluded.last_broadcast_iso,
             updated_at = excluded.updated_at`,
        )
        .bind(config.spec.id, nowIso, nowIso)
        .run();
    }
  }

  return {
    enabled: true,
    syncKicked,
    syncRunning,
    broadcast,
  };
}

/**
 * Returns redacted gateway status JSON. NEVER exposes tokens, secrets, or raw user message bodies.
 */
export async function getNarraGatewayStatus<TEnv extends NarraGatewayEnv = NarraGatewayEnv>(
  env: TEnv,
  config?: Pick<NarraGatewayConfig<TEnv>, 'spec'>,
): Promise<NarraGatewayStatus> {
  const enabled = isNarraGatewayEnabled(env);
  const syncEnabled = isNarraSyncEnabled(env);

  let syncStatus: Record<string, unknown> | null = null;
  const rooms: Record<string, Record<string, unknown>> = {};

  if (env.NARRA_SYNC_DO) {
    try {
      const stub = env.NARRA_SYNC_DO.get(env.NARRA_SYNC_DO.idFromName('narra'));
      const res = await stub.fetch('https://narra-sync/status');
      if (res.ok) {
        syncStatus = (await res.json()) as Record<string, unknown>;
        const roomIds = Array.isArray(syncStatus.roomIds)
          ? (syncStatus.roomIds as string[]).slice(0, STALE_ROOM_STATUS_LIMIT)
          : [];
        if (env.NARRA_ROOM_DO) {
          for (const roomId of roomIds) {
            try {
              const roomStub = env.NARRA_ROOM_DO.get(env.NARRA_ROOM_DO.idFromName(roomId));
              const roomRes = await roomStub.fetch('https://narra-room/status');
              if (roomRes.ok) {
                rooms[roomId] = (await roomRes.json()) as Record<string, unknown>;
              }
            } catch {
              // Skip unreachable room DO in status report.
            }
          }
        }
      }
    } catch (error) {
      syncStatus = {
        error: scrubSecrets(error instanceof Error ? error.message : error, env),
      };
    }
  }

  return {
    enabled,
    syncEnabled,
    agentId: config?.spec.id ?? null,
    agentName: config?.spec.name ?? null,
    matrixId:
      config?.spec.matrixId ??
      (typeof syncStatus?.matrixUserId === 'string' ? syncStatus.matrixUserId : null),
    config: {
      NARRA_GATEWAY_ENABLED: (env.NARRA_GATEWAY_ENABLED ?? '').trim() || 'off',
      NARRA_SYNC: (env.NARRA_SYNC ?? '').trim() || 'off',
      hasNarraAgentToken: Boolean((env.NARRA_AGENT_TOKEN ?? '').trim()),
      hasMatrixAccessToken: Boolean((env.MATRIX_ACCESS_TOKEN ?? '').trim()),
      hasSyncDoBinding: Boolean(env.NARRA_SYNC_DO),
      hasRoomDoBinding: Boolean(env.NARRA_ROOM_DO),
      hasDatabaseBinding: Boolean(env.DB),
      narraApiEndpoint: narraEndpoint(env),
    },
    sync: syncStatus,
    rooms,
  };
}

export interface NarraDurableObjectClass<TEnv extends NarraGatewayEnv, TInstance> {
  new (ctx: DurableObjectState, env: TEnv): TInstance;
}

export interface NarraWorkerGateway<TEnv extends NarraGatewayEnv = NarraGatewayEnv> {
  BaseNarraMatrixSync: NarraDurableObjectClass<TEnv, BaseNarraMatrixSync<TEnv>>;
  BaseNarraRoomCoordinator: NarraDurableObjectClass<TEnv, BaseNarraRoomCoordinator<TEnv>>;
  NarraMatrixSync: NarraDurableObjectClass<TEnv, BaseNarraMatrixSync<TEnv>>;
  NarraRoomCoordinator: NarraDurableObjectClass<TEnv, BaseNarraRoomCoordinator<TEnv>>;
  isNarraGatewayEnabled: (env: TEnv) => boolean;
  kickNarraGateway: (env: TEnv) => Promise<NarraGatewayKickResult>;
  getNarraGatewayStatus: (env: TEnv) => Promise<NarraGatewayStatus>;
}

/**
 * Factory binding `NarraGatewayConfig` to pre-configured Durable Object base classes
 * and gateway helpers. Consumers can still declare static DO subclasses locally:
 * ```ts
 * const gateway = createNarraWorkerGateway(config);
 * export class NarraMatrixSync extends gateway.BaseNarraMatrixSync {}
 * export class NarraRoomCoordinator extends gateway.BaseNarraRoomCoordinator {}
 * ```
 */
export function createNarraWorkerGateway<TEnv extends NarraGatewayEnv = NarraGatewayEnv>(
  config: NarraGatewayConfig<TEnv>,
): NarraWorkerGateway<TEnv> {
  class ConfiguredNarraMatrixSync extends BaseNarraMatrixSync<TEnv> {
    constructor(ctx: DurableObjectState, env: TEnv) {
      super(ctx, env, config);
    }
  }

  class ConfiguredNarraRoomCoordinator extends BaseNarraRoomCoordinator<TEnv> {
    constructor(ctx: DurableObjectState, env: TEnv) {
      super(ctx, env, config);
    }
  }

  return {
    BaseNarraMatrixSync: ConfiguredNarraMatrixSync,
    BaseNarraRoomCoordinator: ConfiguredNarraRoomCoordinator,
    NarraMatrixSync: ConfiguredNarraMatrixSync,
    NarraRoomCoordinator: ConfiguredNarraRoomCoordinator,
    isNarraGatewayEnabled: (env: TEnv) => isNarraGatewayEnabled(env),
    kickNarraGateway: (env: TEnv) => kickNarraGateway(env, config),
    getNarraGatewayStatus: (env: TEnv) => getNarraGatewayStatus(env, config),
  };
}

export {
  BaseNarraMatrixSync as NarraMatrixSync,
  BaseNarraRoomCoordinator as NarraRoomCoordinator,
};
