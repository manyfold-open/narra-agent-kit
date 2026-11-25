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
    timeoutMs?: number;
}
export interface RelevanceResult {
    score: number;
    /** Raw best cosine, logged so thresholds can be calibrated from real traffic. */
    cosine?: number;
    source: 'embedding' | 'heuristic';
}
export declare function profileTexts(spec: AgentSpec, examples?: readonly string[]): string[];
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