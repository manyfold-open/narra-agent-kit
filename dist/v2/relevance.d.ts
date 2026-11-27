import type { AgentSpec, InboundEvent, RoomContext } from '../types.js';
export declare const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-m3";
/** Cosine similarity at or below this maps to relevance 0; at or above `high`, to 1. */
export declare const DEFAULT_COSINE_LOW = 0.35;
export declare const DEFAULT_COSINE_HIGH = 0.65;
export interface VectorCache {
    get(key: string): Promise<number[][] | undefined>;
    put(key: string, value: number[][]): Promise<void>;
}
export interface RelevanceScorerOptions {
    ai: unknown;
    model?: string;
    cosineLow?: number;
    cosineHigh?: number;
    /** Stores the profile vectors so they are embedded once, not on every message. */
    cache?: VectorCache;
    /** v2-only profile text used instead of `spec.domainDescription`. */
    profile?: string;
    /**
     * Requests that are NOT this agent's (e.g. a news agent's topics for a datasets agent). When a
     * message is closer to one of these than to the agent's own profile, its relevance is 0.
     */
    notExamples?: readonly string[];
    timeoutMs?: number;
}
export interface RelevanceResult {
    score: number;
    /**
     * The fit to this agent's profile alone (scaled best cosine), even when another agent's asks are
     * closer (`score` is then 0). Logged for calibration; never enough to wake.
     */
    rawScore?: number;
    /** `cosine - notCosine`: how clearly this agent beats the other agents' asks (negative = loses). */
    margin?: number;
    /** Raw best cosine, logged so thresholds can be calibrated from real traffic. */
    cosine?: number;
    /** Best cosine against `notExamples`, when given. */
    notCosine?: number;
    source: 'embedding' | 'heuristic';
}
export declare function profileTexts(spec: AgentSpec, examples?: readonly string[], profile?: string): string[];
export declare function cosine(a: number[], b: number[]): number;
export declare function scaleCosine(value: number, low?: number, high?: number): number;
/**
 * Scores how close `text` is to the agent's profile. Falls back to the keyword heuristic when
 * Workers AI is not bound or fails, so the gate still works (more coarsely) without it.
 */
export declare function scoreRelevance(text: string, spec: AgentSpec, examples: readonly string[], options: RelevanceScorerOptions, fallback: {
    event: InboundEvent;
    context: RoomContext;
}): Promise<RelevanceResult>;
//# sourceMappingURL=relevance.d.ts.map