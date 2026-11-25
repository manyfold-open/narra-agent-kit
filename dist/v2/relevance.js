/**
 * Cheap relevance scoring for the v2 wake gate: one small multilingual embedding call per message,
 * compared with the agent's profile (its domain description plus example requests). This replaces
 * keyword lists, and costs far less than a chat-model triage call.
 */
import { heuristicDomainScore } from '../router.js';
export const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-m3';
/** Cosine similarity at or below this maps to relevance 0; at or above `high`, to 1. */
export const DEFAULT_COSINE_LOW = 0.35;
export const DEFAULT_COSINE_HIGH = 0.65;
export function profileTexts(spec, examples = []) {
    return [spec.domainDescription, ...examples].map((t) => t.trim()).filter(Boolean).slice(0, 24);
}
export function cosine(a, b) {
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
function vectorsFrom(raw) {
    const data = raw?.data;
    if (!Array.isArray(data) || data.length === 0)
        return null;
    if (!data.every((v) => Array.isArray(v) && v.every((x) => typeof x === 'number')))
        return null;
    return data;
}
function hashKey(parts) {
    let h = 2166136261;
    const joined = parts.join('\u0001');
    for (let i = 0; i < joined.length; i++) {
        h ^= joined.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}
async function withTimeout(p, ms) {
    let timer;
    try {
        return await Promise.race([
            p,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('relevance_timeout')), ms);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
export function scaleCosine(value, low = DEFAULT_COSINE_LOW, high = DEFAULT_COSINE_HIGH) {
    if (high <= low)
        return value >= high ? 1 : 0;
    return Math.min(1, Math.max(0, (value - low) / (high - low)));
}
/**
 * Scores how close `text` is to the agent's profile. Falls back to the keyword heuristic when
 * Workers AI is not bound or fails, so the gate still works (more coarsely) without it.
 */
export async function scoreRelevance(text, spec, examples, options, fallback) {
    const heuristic = () => ({
        score: heuristicDomainScore(fallback.event, spec, fallback.context),
        source: 'heuristic',
    });
    const binding = options.ai && typeof options.ai.run === 'function'
        ? options.ai
        : null;
    const clean = text.trim().slice(0, 500);
    if (!binding || !clean)
        return heuristic();
    const model = options.model ?? DEFAULT_EMBEDDING_MODEL;
    const profile = profileTexts(spec, examples);
    if (profile.length === 0)
        return heuristic();
    const timeoutMs = options.timeoutMs ?? 4_000;
    try {
        const cacheKey = `v2:profile:${model}:${hashKey(profile)}`;
        let profileVectors = await options.cache?.get(cacheKey);
        let messageVector;
        if (!profileVectors || profileVectors.length !== profile.length) {
            const all = vectorsFrom(await withTimeout(binding.run(model, { text: [...profile, clean] }), timeoutMs));
            if (!all || all.length !== profile.length + 1)
                return heuristic();
            profileVectors = all.slice(0, profile.length);
            messageVector = all[profile.length];
            await options.cache?.put(cacheKey, profileVectors).catch(() => undefined);
        }
        else {
            const one = vectorsFrom(await withTimeout(binding.run(model, { text: [clean] }), timeoutMs));
            if (!one || one.length !== 1)
                return heuristic();
            messageVector = one[0];
        }
        let best = -1;
        for (const v of profileVectors)
            best = Math.max(best, cosine(v, messageVector));
        return {
            score: scaleCosine(best, options.cosineLow, options.cosineHigh),
            cosine: Math.round(best * 1000) / 1000,
            source: 'embedding',
        };
    }
    catch {
        return heuristic();
    }
}
//# sourceMappingURL=relevance.js.map