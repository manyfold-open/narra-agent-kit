import type { InboundEvent, KeyValueStore, RoomMemberInfo } from './types.js';
export declare const DEFAULT_SYNC_TIMEOUT_MS = 25000;
export interface MatrixLogin {
    homeserverUrl: string;
    userId: string;
    accessToken: string;
}
export declare class SyncError extends Error {
    readonly unauthorized: boolean;
    constructor(message: string, unauthorized?: boolean);
}
export declare function redactSecrets(value: unknown): string;
export declare const SYNC_FILTER: string;
export interface RawMatrixSyncResponse {
    next_batch: string;
    rooms?: {
        join?: Record<string, {
            timeline?: {
                events?: Array<Record<string, unknown>>;
                limited?: boolean;
                prev_batch?: string;
            };
            state?: {
                events?: Array<Record<string, unknown>>;
            };
        }>;
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
/**
 * Fetches Matrix login credentials from Narra (`POST /api/agent-runtime/matrix-credential`)
 * using `NARRA_AGENT_TOKEN`, or delegates to `loginProvider`.
 * Credentials stay strictly in memory and are never logged or persisted.
 */
export declare function fetchMatrixCredential(config: NarraSyncConfig, cache?: {
    login?: MatrixLogin;
}): Promise<MatrixLogin>;
export interface AuthorizeEventInput {
    roomId: string;
    senderMatrixUserId: string;
    memberMatrixUserIds: string[];
    mentioned: boolean;
}
export interface AuthorizeEventResult {
    allow: boolean;
    roomKind?: 'dm' | 'group';
    notice?: {
        send?: boolean;
        text?: string;
    };
    reason?: string;
}
/**
 * Calls Narra's `POST /api/agent-runtime/matrix/authorize-event` fail-closed.
 * Any network failure, non-2xx response, or non-true `allow` returns `{ allow: false }`.
 */
export declare function authorizeEvent(config: Pick<NarraSyncConfig, 'narraApiEndpoint' | 'narraAgentToken' | 'fetchImpl'>, input: AuthorizeEventInput): Promise<AuthorizeEventResult>;
/** Executes one Matrix `/_matrix/client/v3/sync` call. */
export declare function matrixSyncRequest(login: MatrixLogin, since: string | null, timeoutMs: number, fetchImpl?: typeof fetch): Promise<RawMatrixSyncResponse>;
/**
 * Fetches `/messages` backstop directly from Matrix homeserver (or Narra chat API fallback)
 * to recover events skipped by `withheld_gap` / `limited: true` sync batches or delivery filters.
 */
export declare function fetchRoomMessagesBackstop(login: MatrixLogin, roomId: string, options?: {
    from?: string;
    dir?: 'f' | 'b';
    limit?: number;
}, fetchImpl?: typeof fetch): Promise<{
    events: InboundEvent[];
    nextBatch?: string;
    prevBatch?: string;
}>;
/**
 * Fetches Narra's `/api/agent-runtime/chat/messages` backstop when using `NARRA_AGENT_TOKEN`
 * (bypasses Synapse `delivery_filter_mode` because it reads via chat API cursor).
 */
export declare function fetchNarraChatMessagesBackstop(config: Pick<NarraSyncConfig, 'narraApiEndpoint' | 'narraAgentToken' | 'fetchImpl'>, roomId: string, options?: {
    from?: string;
    dir?: 'f' | 'b';
    limit?: number;
}): Promise<{
    events: InboundEvent[];
    nextBatch?: string;
    prevBatch?: string;
}>;
/** Fetches a single Matrix event by ID so replies to older messages hydrate parent text (`in_reply_to_other`). */
export declare function fetchEventContext(login: MatrixLogin, roomId: string, eventId: string, fetchImpl?: typeof fetch): Promise<InboundEvent | null>;
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
export declare function syncOnce(store: KeyValueStore, deps: SyncDeps, cache: {
    login?: MatrixLogin;
}, options?: {
    timeoutMs?: number;
    replayInitial?: boolean;
}): Promise<number>;
/**
 * Convenience in-memory `KeyValueStore` implementation for tests or ephemeral runtimes.
 */
export declare class MemoryKVStore implements KeyValueStore {
    private readonly map;
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    list<T>(options: {
        prefix: string;
        limit?: number;
    }): Promise<Map<string, T>>;
}
//# sourceMappingURL=sync.d.ts.map