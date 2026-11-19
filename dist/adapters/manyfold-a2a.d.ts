import type { RecallTurnResult } from '../memory.js';
import type { AgentSpec, FastPathModel, InboundEvent, RoomContext, TriageDecision } from '../types.js';
export interface ManyfoldA2ACredential {
    rpcUrl: string;
    token: string;
    label?: string;
}
export declare class A2AError extends Error {
    readonly retryable: boolean;
    readonly refreshCredential: boolean;
    constructor(message: string, retryable: boolean, refreshCredential?: boolean);
}
export interface PromptEnvelopeInput {
    event: InboundEvent;
    context: RoomContext;
    decision: TriageDecision;
    memories?: RecallTurnResult;
    spec?: AgentSpec;
    maxHistoryTurns?: number;
    extraFields?: Record<string, string>;
}
/**
 * Builds a prompt-injection-hardened Manyfold A2A turn envelope containing:
 * - Pre-injected room members & peer `@agent-*` roster
 * - `in_reply_to_other` (or `in_reply_to_self`) parent snippet
 * - Recent human-only history (excludes noisy peer agent chatter)
 * - `detected_lang` strict language lock
 * - Recalled safe memories (with DM-to-group privacy isolation already applied)
 */
export declare function buildPromptEnvelope(input: PromptEnvelopeInput): string;
export declare const TERMINAL_STATES: Set<string>;
export interface StreamSnapshot {
    taskId: string | null;
    contextId: string | null;
    state: string;
    text: string;
    progressText: string;
    terminal: boolean;
}
interface StreamAccumulator {
    taskId: string | null;
    contextId: string | null;
    state: string;
    artifacts: Map<string, string>;
    order: string[];
    directText: string;
    statusText: string;
}
export declare function applyA2AResult(acc: StreamAccumulator, raw: unknown): void;
export declare function snapshotFromAccumulator(acc: StreamAccumulator): StreamSnapshot;
export interface RunA2AOptions {
    credential: ManyfoldA2ACredential;
    envelope: string;
    eventId: string;
    contextId?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}
/**
 * Executes one zero-extra-key Manyfold A2A streaming (`message/stream`) turn over JSON-RPC 2.0.
 */
export declare function runManyfoldA2ATurn(options: RunA2AOptions): Promise<string>;
export interface FastPathOrA2AOptions {
    event: InboundEvent;
    context: RoomContext;
    decision: TriageDecision;
    credential: ManyfoldA2ACredential;
    memories?: RecallTurnResult;
    spec?: AgentSpec;
    fastPathModel?: FastPathModel;
    extraFields?: Record<string, string>;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}
export interface FastPathOrA2AResult {
    text: string;
    silent: boolean;
    source: 'fast_path' | 'a2a';
    envelope: string;
    strippedNotes: string;
}
/**
 * Runs an optional `FastPathModel` (e.g. Workers AI or lightweight local model) first,
 * falling back seamlessly to Manyfold A2A (`message/stream`) with zero extra API keys required.
 * Post-processes output with `stripLeakedNotes`, `isSilence`, and `sanitizeMobileLinks`.
 */
export declare function runFastPathOrA2A(options: FastPathOrA2AOptions): Promise<FastPathOrA2AResult>;
export {};
//# sourceMappingURL=manyfold-a2a.d.ts.map