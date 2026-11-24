import { type BroadcastScheduleResult } from './broadcast.js';
import { type RecallTurnResult } from './memory.js';
import type { AgentSpec, AgentUpdateItem, InboundEvent, LangCode, RoomContext, TriageDecision, TriageModel } from './types.js';
export declare const NARRA_GATEWAY_STATE_SCHEMA = "\nCREATE TABLE IF NOT EXISTS narra_gateway_state (\n  agent_id TEXT PRIMARY KEY,\n  last_broadcast_iso TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\n";
export interface NarraGatewayEnv {
    DB?: D1Database;
    NARRA_GATEWAY_ENABLED?: string;
    NARRA_SYNC?: string;
    /**
     * `longpoll` (default): the sync DO keeps a 25s `/sync` long-poll open around the clock.
     * `push`: Synapse pushes a wake-up to this Worker for each new event; the sync DO only runs a
     * non-blocking `/sync` when woken, plus a slow backstop. Needs NARRA_PUSH_URL + NARRA_PUSH_SECRET.
     */
    NARRA_SYNC_MODE?: string;
    /** Public https base URL of this Worker (including any base path), used to register the Matrix pusher. */
    NARRA_PUSH_URL?: string;
    /** Random secret (>= 16 chars) embedded in the pusher URL so only Synapse can wake the sync DO. */
    NARRA_PUSH_SECRET?: string;
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
    AI_TRIAGE_MODEL?: string;
    NARRA_AI_TRIAGE?: string;
}
export interface NarraA2ACredentialResult {
    url: string;
    token: string;
    label?: string;
}
export interface NarraGatewayConfig<TEnv extends NarraGatewayEnv = NarraGatewayEnv> {
    spec: AgentSpec;
    fetchUpdates?: (env: TEnv, sinceIso: string) => Promise<AgentUpdateItem[]>;
    fastRespond?: (env: TEnv, event: InboundEvent, decision: TriageDecision, memories: RecallTurnResult, context?: RoomContext) => Promise<string | null>;
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
    /** Optional D1/local pre-fetch hook injected into Manyfold A2A `extraFields` in parallel before calling A2A. */
    buildExtraEnvelopeFields?: (env: TEnv, event: InboundEvent, decision: TriageDecision, memories: RecallTurnResult, context: RoomContext) => Promise<Record<string, string> | null | undefined>;
    /** Custom progress status text shown if a directly addressed A2A turn exceeds `thinkingDelayMs`. */
    thinkingMessage?: (lang: LangCode, event: InboundEvent, decision: TriageDecision) => string;
    /** Delay before posting a progress status bubble on direct A2A turns (default 3500ms; 0 disables). */
    thinkingDelayMs?: number;
    /** When true, posts a brief human-like apology if a directly addressed A2A turn exhausts all retries. */
    enableA2AFailureReply?: boolean;
    /** Custom failure apology text when `enableA2AFailureReply` is enabled or a thinking bubble was already posted. */
    a2aFailureReply?: (lang: LangCode, event: InboundEvent) => string;
    /** Injectable clock for deterministic testing. */
    now?: () => number;
    /** Injectable sleep for deterministic testing. */
    sleep?: (ms: number) => Promise<void>;
}
export type NarraMatrixOp = {
    op: 'send';
    roomId: string;
    txnId?: string;
    content: Record<string, unknown>;
} | {
    op: 'edit';
    roomId: string;
    eventId?: string;
    text?: string;
    txnId?: string;
    selfMatrixId?: string;
    content?: Record<string, unknown>;
} | {
    op: 'typing';
    roomId: string;
    typing: boolean;
    timeoutMs?: number;
} | {
    op: 'receipt';
    roomId: string;
    eventId: string;
} | {
    op: 'fetchEvent';
    roomId: string;
    eventId: string;
} | {
    op: 'recentMessages';
    roomId: string;
    limit?: number;
};
export type NarraMatrixOpResult = {
    ok: true;
    eventId?: string;
    event?: InboundEvent | null;
    events?: InboundEvent[];
} | {
    ok: false;
    status: number;
    errcode?: string;
    narraCode?: string;
};
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
        NARRA_SYNC_MODE: string;
        hasPushUrl: boolean;
        hasPushSecret: boolean;
        pushModeActive: boolean;
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
/**
 * Returns `true` ONLY when BOTH `NARRA_GATEWAY_ENABLED` is `'on'` AND `NARRA_AGENT_TOKEN` is non-empty.
 */
export declare function isNarraGatewayEnabled(env: NarraGatewayEnv | undefined | null): boolean;
export declare function isNarraSyncEnabled(env: NarraGatewayEnv | undefined | null): boolean;
/** Matrix push gateway path Synapse requires at the end of every HTTP pusher URL. */
export declare const NARRA_PUSH_NOTIFY_SUFFIX = "/_matrix/push/v1/notify";
export declare const NARRA_PUSHER_APP_ID = "nexus.narra.agent-kit";
/** User-defined override push rule that makes every room event notify, so every event wakes the agent. */
export declare const NARRA_WAKE_PUSH_RULE_ID = "nexus.narra.agent-kit.wake";
/** In push mode, the sync DO still runs one non-blocking `/sync` this often in case a push is lost. */
export declare const NARRA_PUSH_BACKSTOP_MS = 60000;
/** Full pusher URL (contains the secret: never log or return it from status endpoints). */
export declare function narraPushNotifyUrl(env: NarraGatewayEnv | undefined | null): string | null;
/** True when sync is on, NARRA_SYNC_MODE is `push`, and a valid push URL + secret are configured. */
export declare function isNarraPushModeEnabled(env: NarraGatewayEnv | undefined | null): boolean;
/**
 * Handles Synapse's HTTP pusher call (`POST <NARRA_PUSH_URL>/narra/push/<secret>/_matrix/push/v1/notify`).
 * Returns `null` when the request is not a push call, so Workers can chain it before their own router:
 * ```ts
 * const pushed = await handleNarraPushRequest(request, env);
 * if (pushed) return pushed;
 * ```
 * A valid call only wakes the sync DO; events are still read through `/sync`, so dedupe, room meta
 * and backstops behave exactly as in long-poll mode. Unknown secrets or push mode being off answer
 * with the pushkeys `rejected`, which makes Synapse drop the stale pusher.
 */
export declare function handleNarraPushRequest(request: Request, env: NarraGatewayEnv): Promise<Response | null>;
/**
 * Base Durable Object for Matrix `/sync` + `/messages` backstop + in-memory credential handling.
 * Consumer Workers subclass this locally (e.g. `export class NarraMatrixSync extends BaseNarraMatrixSync {}`)
 * so `@cloudflare/vite-plugin` and `wrangler` detect Durable Objects statically.
 */
export declare class BaseNarraMatrixSync<TEnv extends NarraGatewayEnv = NarraGatewayEnv> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: TEnv;
    private readonly explicitConfig?;
    /** Strictly in-memory Matrix login cache; NEVER persisted to DO storage or logged. */
    private readonly cache;
    constructor(ctx: DurableObjectState, env: TEnv, config?: NarraGatewayConfig<TEnv>);
    protected getConfig(): NarraGatewayConfig<TEnv>;
    private nowMs;
    private getConfigSafe;
    private isSyncActive;
    private resolveLogin;
    private callHomeserver;
    private executeMatrixOp;
    private updateRoomMetaFromSync;
    private refreshNarraRoomsMeta;
    fetch(request: Request): Promise<Response>;
    private homeserverRequest;
    /**
     * Narra creates a new DM (or adds the agent to a group) with the agent only *invited*; nothing
     * joined on the agent's behalf, so those rooms never reached `/sync` `rooms.join` and new users
     * got no reply. Narra already decides who may start a chat with an agent (agent_request /
     * connection approval), so the agent accepts every invite it is sent.
     * Returns how many rooms were joined in this call.
     */
    private acceptInvites;
    private pusherKey;
    /**
     * Makes sure the homeserver pushes every new event of this agent to our Worker: one HTTP pusher
     * (event_id_only payload, no message content leaves Synapse) and one override rule that marks
     * every event as notifying (edits, redactions and reactions are silent by default).
     * Returns false (caller falls back to long-poll) when either call fails.
     */
    private ensurePushSetup;
    /** Removes the pusher + wake rule after switching back to long-poll (best effort). */
    private teardownPushSetup;
    alarm(): Promise<void>;
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
export declare class BaseNarraRoomCoordinator<TEnv extends NarraGatewayEnv = NarraGatewayEnv> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: TEnv;
    private readonly explicitConfig?;
    constructor(ctx: DurableObjectState, env: TEnv, config?: NarraGatewayConfig<TEnv>);
    protected getConfig(): NarraGatewayConfig<TEnv>;
    private nowMs;
    private runLocked;
    private createCoalescer;
    private getEffectiveSpec;
    private markEventHandled;
    private getMemoryStore;
    private matrixOp;
    private hydrateReplyTarget;
    private trimAndPutMessageCache;
    private scheduleNextAlarm;
    private computeShouldQuote;
    private postReplyToRoom;
    private editReplyInRoom;
    private loadExpandedHistoryForSummary;
    fetch(request: Request): Promise<Response>;
    private isTurnRedacted;
    private removePendingTurn;
    private updatePendingTurn;
    private clearUserSession;
    private hasLivePeerRepliedAfter;
    private buildRoomContextForTurn;
    alarm(): Promise<void>;
}
/**
 * Kicks the Narra Gateway on cron/request:
 * - When `isNarraGatewayEnabled(env)` is false, returns IMMEDIATELY with 0 external calls,
 *   0 D1 queries, and 0 DO fetches.
 * - When enabled, kicks `NARRA_SYNC_DO` (`POST /kick`) and runs staggered `ProactiveBroadcastScheduler`
 *   against `config.fetchUpdates` if provided.
 */
export declare function kickNarraGateway<TEnv extends NarraGatewayEnv = NarraGatewayEnv>(env: TEnv, config?: NarraGatewayConfig<TEnv>): Promise<NarraGatewayKickResult>;
/**
 * Returns redacted gateway status JSON. NEVER exposes tokens, secrets, or raw user message bodies.
 */
export declare function getNarraGatewayStatus<TEnv extends NarraGatewayEnv = NarraGatewayEnv>(env: TEnv, config?: Pick<NarraGatewayConfig<TEnv>, 'spec'>): Promise<NarraGatewayStatus>;
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
    /** Route Synapse pusher calls; returns null for any other request. */
    handleNarraPushRequest: (request: Request, env: TEnv) => Promise<Response | null>;
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
export declare function createNarraWorkerGateway<TEnv extends NarraGatewayEnv = NarraGatewayEnv>(config: NarraGatewayConfig<TEnv>): NarraWorkerGateway<TEnv>;
export { BaseNarraMatrixSync as NarraMatrixSync, BaseNarraRoomCoordinator as NarraRoomCoordinator, };
//# sourceMappingURL=worker.d.ts.map