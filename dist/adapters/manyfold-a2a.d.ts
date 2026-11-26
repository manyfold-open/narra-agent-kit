import type { RecallTurnResult } from '../memory.js';
import type { AgentSpec, FastPathModel, InboundEvent, LangCode, RoomContext, TriageDecision } from '../types.js';
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
    /** When true, includes a full multi-speaker timeline (up to 40 turns) and structured recap instructions. */
    summaryMode?: boolean;
    /** Includes the agent's own recent replies (defaults to true) so A2A follow-ups remember local fast-path answers. */
    includeSelfReplies?: boolean;
}
/**
 * The rules every agent's brain answers by, whatever its profile says. One copy, used by the
 * Manyfold envelope and the Workers AI fallback alike, so the two paths cannot drift apart.
 *
 * - Trust: the sender's request sets the task. Only text that pretends to be the platform or the
 *   system is ignored. (Calling the whole message body "not instructions" made brains treat the
 *   user's own constraints, like "just one card", as weaker than their default format.)
 * - Earlier results: used for follow-ups on them, never as a reason to refuse a new request.
 * - Evidence: time-sensitive facts are stated as facts only when this turn's data backs them.
 */
export declare const BRAIN_CONTRACT: readonly string[];
/**
 * Builds a prompt-injection-hardened Manyfold A2A turn envelope containing:
 * - Pre-injected room members & peer `@agent-*` roster
 * - `in_reply_to_other` (or `in_reply_to_self`) parent snippet
 * - Recent human history + agent's own recent replies (or full chronological timeline in summaryMode)
 * - `detected_lang` strict language lock & mobile group-chat style guidance
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
    /** Optional callback fired when SSE streams intermediate progress text. */
    onProgress?: (progressText: string) => void;
    /** Optional callback with the answer text received so far, each time it grows (streaming replies). */
    onText?: (textSoFar: string) => void;
}
export interface RunA2ATurnResult {
    text: string;
    contextId: string | null;
    taskId: string | null;
}
/**
 * Post-processes raw Manyfold A2A output: strips leaked notes, sanitizes mobile URLs,
 * converts numbered markdown lists to `• ` bullets, and enforces pure `zh-Hant` when requested.
 */
export declare function normalizeA2AOutput(raw: string, lang?: LangCode): {
    text: string;
    cut: string;
};
/**
 * Executes one zero-extra-key Manyfold A2A streaming (`message/stream`) turn over JSON-RPC 2.0,
 * returning both the final answer text and session metadata (`contextId`, `taskId`).
 */
export declare function runManyfoldA2ATurnWithMeta(options: RunA2AOptions): Promise<RunA2ATurnResult>;
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