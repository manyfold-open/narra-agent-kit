/**
 * Cheap relevance scoring for the v2 wake gate: one small multilingual embedding call per message,
 * compared with the agent's profile (its domain description plus example requests). This replaces
 * keyword lists, and costs far less than a chat-model triage call.
 */
import { heuristicDomainScore } from '../router.js';
import type { AgentSpec, InboundEvent, RoomContext } from '../types.js';

export const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-m3';

/** Cosine similarity at or below this maps to relevance 0; at or above `high`, to 1. */
export const DEFAULT_COSINE_LOW = 0.35;
export const DEFAULT_COSINE_HIGH = 0.65;

interface EmbeddingBinding {
  run(model: string, input: { text: string[] }): Promise<unknown>;
}

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

export function profileTexts(spec: AgentSpec, examples: readonly string[] = [], profile?: string): string[] {
  return [profile?.trim() || spec.domainDescription, ...examples].map((t) => t.trim()).filter(Boolean).slice(0, 24);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

function vectorsFrom(raw: unknown): number[][] | null {
  const data = (raw as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  if (!data.every((v) => Array.isArray(v) && v.every((x) => typeof x === 'number'))) return null;
  return data as number[][];
}

function hashKey(parts: string[]): string {
  let h = 2166136261;
  const joined = parts.join('\u0001');
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('relevance_timeout')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function scaleCosine(value: number, low = DEFAULT_COSINE_LOW, high = DEFAULT_COSINE_HIGH): number {
  if (high <= low) return value >= high ? 1 : 0;
  return Math.min(1, Math.max(0, (value - low) / (high - low)));
}

/**
 * Scores how close `text` is to the agent's profile. Falls back to the keyword heuristic when
 * Workers AI is not bound or fails, so the gate still works (more coarsely) without it.
 */
export async function scoreRelevance(
  text: string,
  spec: AgentSpec,
  examples: readonly string[],
  options: RelevanceScorerOptions,
  fallback: { event: InboundEvent; context: RoomContext },
): Promise<RelevanceResult> {
  const heuristic = (): RelevanceResult => ({
    score: heuristicDomainScore(fallback.event, spec, fallback.context),
    source: 'heuristic',
  });
  const binding =
    options.ai && typeof (options.ai as Partial<EmbeddingBinding>).run === 'function'
      ? (options.ai as EmbeddingBinding)
      : null;
  const clean = text.trim().slice(0, 500);
  if (!binding || !clean) return heuristic();

  const model = options.model ?? DEFAULT_EMBEDDING_MODEL;
  const positives = profileTexts(spec, examples, options.profile);
  if (positives.length === 0) return heuristic();
  const negatives = (options.notExamples ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 16);
  const profile = [...positives, ...negatives];
  const timeoutMs = options.timeoutMs ?? 4_000;

  try {
    const cacheKey = `v2:profile:${model}:${hashKey(profile)}`;
    let profileVectors = await options.cache?.get(cacheKey);
    let messageVector: number[] | undefined;
    if (!profileVectors || profileVectors.length !== profile.length) {
      const all = vectorsFrom(await withTimeout(binding.run(model, { text: [...profile, clean] }), timeoutMs));
      if (!all || all.length !== profile.length + 1) return heuristic();
      profileVectors = all.slice(0, profile.length);
      messageVector = all[profile.length];
      await options.cache?.put(cacheKey, profileVectors).catch(() => undefined);
    } else {
      const one = vectorsFrom(await withTimeout(binding.run(model, { text: [clean] }), timeoutMs));
      if (!one || one.length !== 1) return heuristic();
      messageVector = one[0];
    }
    let best = -1;
    for (const v of profileVectors.slice(0, positives.length)) best = Math.max(best, cosine(v, messageVector!));
    let notBest = -1;
    for (const v of profileVectors.slice(positives.length)) notBest = Math.max(notBest, cosine(v, messageVector!));
    const notMine = negatives.length > 0 && notBest > best;
    return {
      score: notMine ? 0 : scaleCosine(best, options.cosineLow, options.cosineHigh),
      rawScore: scaleCosine(best, options.cosineLow, options.cosineHigh),
      ...(negatives.length > 0 ? { margin: Math.round((best - notBest) * 1000) / 1000 } : {}),
      cosine: Math.round(best * 1000) / 1000,
      ...(negatives.length > 0 ? { notCosine: Math.round(notBest * 1000) / 1000 } : {}),
      source: 'embedding',
    };
  } catch {
    return heuristic();
  }
}
