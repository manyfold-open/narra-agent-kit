import { A2AError, BRAIN_CONTRACT, buildPromptEnvelope, normalizeA2AOutput, runManyfoldA2ATurnWithMeta, } from './adapters/manyfold-a2a.js';
import { D1BroadcastStore, DEFAULT_ROOM_POSTING_RULES, InMemoryBroadcastStore, roomPostingBlock, ProactiveBroadcastScheduler, } from './broadcast.js';
import { runSchemaStatements } from './d1.js';
import { BurstCoalescer } from './debounce.js';
import { isNarraAgent, isSilence, isSummaryOrRecapRequest, parseMatrixEvent, sanitizeMobileLinks, stripLeakedNotes, } from './guard.js';
import { detectExplicitLangSwitch, detectLang, isZhOrEn, stripAgentMentions } from './lang.js';
import { MemoryStore, handleStandardMemoryCommand, } from './memory.js';
import { editContent, messageContent, plainMentions } from './mentions.js';
import { shouldQuote } from './quote.js';
import { AGENT_CHAIN_CAP, AGENT_CHAIN_RETRY_MS, AgentChainTracker, DEFAULT_SESSION_WINDOW_MS, DEFAULT_WORKERS_AI_TRIAGE_MODEL, createAskTriageModel, createWorkersAiTriageModel, executePoliteYield, hashFraction, hasPeerAnsweredTimeline, peerSessionWithSender, hasPeerRepliedAfter, inspectRoomPeers, isChainExhaustedError, isContextualRewrite, isSelfMentioned, routeEvent, } from './router.js';
import { fetchEventContext, fetchMatrixCredential, fetchNarraChatMessagesBackstop, fetchRoomMessagesBackstop, matrixSyncRequest, redactSecrets, SyncError, syncOnce, fetchWithDeadline, } from './sync.js';
import { chatBehaviourNote, parseBrainOutput } from './v2/actions.js';
import { DEFAULT_DAILY_RELEVANCE_LIMIT, NARRA_USAGE_SCHEMA, parseLimit, UsageBudget } from './v2/budget.js';
import { claimPriority, decideWake } from './v2/gate.js';
import { CLAIM_EVENT_TYPE, CLAIM_REACTION, CLAIM_RETRY_REASON, applyClaimReaction, applyClaimRedaction, buildLedgerSummary, emptyRoomState, peerAnswered, peerHandoff, peerClaimHolder, pruneClaims, } from './v2/ledger.js';
import { pipelineForRoom } from './v2/pipeline.js';
import { continuousStreamText, newStreamContinuity, shouldFlushStream, streamableText } from './v2/stream.js';
import { languageName, matchScript, replyLanguageFor } from './v2/language.js';
import { scoreRelevance } from './v2/relevance.js';
const DEFAULT_NARRA_API_ENDPOINT = 'https://api.netmind.chat';
const DEFAULT_MATRIX_HOMESERVER = 'https://matrix.netmind.chat';
const ROOM_META_REFRESH_MS = 5 * 60_000;
const TYPING_REFRESH_MS = 20_000;
const MAX_TURN_AGE_MS = 30 * 60_000;
const MAX_POST_ATTEMPTS = 3;
const MAX_QUEUE_SIZE = 200;
const MAX_HANDLED_IDS = 300;
const MAX_REDACTED_IDS = 300;
const MAX_RECENT_HISTORY = 50;
const MAX_OWN_MESSAGES = 30;
const MAX_MESSAGE_CACHE = 50;
const MAX_LOG_LINES = 40;
const STALE_ROOM_STATUS_LIMIT = 20;
const DEFAULT_THINKING_DELAY_MS = 2_000;
export const NARRA_GATEWAY_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS narra_gateway_state (
  agent_id TEXT PRIMARY KEY,
  last_broadcast_iso TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
/** A real question nobody claimed: the first elected agent answers after this long... */
const GROUP_FALLBACK_BASE_MS = 15_000;
/** ...and the next one this much later if that agent stayed silent (e.g. it runs an older kit). */
const GROUP_FALLBACK_STEP_MS = 8_000;
/** Only this many agents per message take part in the fallback election. */
const GROUP_FALLBACK_MAX_RANK = 3;
/** v2: gap between agents' turns to answer an unaddressed crisis message, in room-agent order. */
const V2_CRISIS_STEP_MS = 2_500;
/** v2: how often a turn waiting on another agent's 👀 checks whether it answered or let go. */
const V2_CLAIM_RECHECK_MS = 2_000;
const GROUP_FALLBACK_NOTE = 'No other AI agent in this group answered this question. Answer it yourself, briefly and helpfully, ' +
    'even if it is outside your speciality. If another agent in this group clearly fits better, say so and name them. ' +
    'Reply in the language of the question.';
export function isAskGroupTriage(env) {
    return (env?.NARRA_GROUP_TRIAGE ?? '').trim() === 'ask';
}
/**
 * The triage model an agent gets unless it supplies its own: ask-aware when NARRA_GROUP_TRIAGE is
 * `ask`, otherwise the keyword-gated Workers AI triage. Agents that wrap triage with their own fast
 * paths should call this for everything they do not handle themselves.
 */
export function createDefaultTriageModel(env) {
    if (!env.AI || (env.NARRA_AI_TRIAGE ?? '').trim() === 'off')
        return undefined;
    return isAskGroupTriage(env)
        ? createAskTriageModel(env.AI, { model: env.AI_TRIAGE_MODEL })
        : createWorkersAiTriageModel(env.AI, { model: env.AI_TRIAGE_MODEL });
}
/**
 * Deterministic election among the AI agents in the room, the same on every agent without them
 * talking to each other: rank by hash of (event, agent). Returns this agent's rank.
 */
export function groupFallbackRank(eventId, selfMatrixId, members) {
    const agents = new Set([selfMatrixId]);
    for (const m of members)
        if (m.isAgent || isNarraAgent(m.matrixId))
            agents.add(m.matrixId);
    const ordered = [...agents].sort((a, b) => hashFraction(`${eventId}:${a}`) - hashFraction(`${eventId}:${b}`));
    return ordered.indexOf(selfMatrixId);
}
function defaultThinkingMessage(lang, isSummary) {
    if (isSummary) {
        if (lang === 'zh-Hant')
            return '📝 正在閱讀群組歷史訊息並整理重點，稍等一下…';
        if (lang === 'zh-Hans')
            return '📝 正在阅读群组历史消息并整理重点，稍等一下…';
        return '📝 Reading recent chat history and putting together a summary…';
    }
    if (lang === 'zh-Hant')
        return '🔍 正在幫你查資料思考中，稍等一下…';
    if (lang === 'zh-Hans')
        return '🔍 正在帮你查资料思考中，稍等一下…';
    return '🔍 Checking that for you, one moment…';
}
function defaultA2AFailureReply(lang) {
    if (lang === 'zh-Hant')
        return '不好意思，剛才查資料的連線有點忙碌，方便稍後再問我一次嗎？';
    if (lang === 'zh-Hans')
        return '不好意思，刚才查资料的连接有点忙碌，方便稍后再问我一次吗？';
    return 'Sorry, I hit a brief connection hiccup looking that up — could you ask me again in a moment?';
}
function extractWorkersAiText(rawOutput) {
    if (!rawOutput)
        return '';
    if (typeof rawOutput === 'string')
        return rawOutput.trim();
    if (typeof rawOutput !== 'object')
        return '';
    const obj = rawOutput;
    const direct = obj.response ?? obj.result;
    if (typeof direct === 'string')
        return direct.trim();
    if (direct && typeof direct === 'object') {
        const inner = direct.response;
        if (typeof inner === 'string')
            return inner.trim();
    }
    const choices = obj.choices;
    if (typeof choices?.[0]?.message?.content === 'string') {
        return choices[0].message.content.trim();
    }
    return '';
}
async function runWorkersAiResilienceFallback(ai, modelName, spec, envelope, lang, wantsSummary, 
/** BCP-47 code when the message is in a language other than zh/en (decision.replyLang). */
foreignLang) {
    const binding = ai && typeof ai.run === 'function'
        ? ai
        : null;
    if (!binding)
        return null;
    const model = modelName?.trim() || DEFAULT_WORKERS_AI_TRIAGE_MODEL;
    const langLabel = foreignLang
        ? `the language of the user's message (${foreignLang}), not Chinese or English`
        : lang === 'zh-Hant'
            ? 'Traditional Chinese (繁體中文)'
            : lang === 'zh-Hans'
                ? 'Simplified Chinese (简体中文)'
                : 'English';
    const systemPrompt = [
        `You are "${spec.name}" replying in a Narra Messenger chat.`,
        `Your domain: ${spec.domainDescription}`,
        wantsSummary
            ? 'The user asked to summarize/recap recent chat history. Read recent_conversation_timeline carefully and synthesize ALL key topics discussed across the entire group (not just your own domain) using concise "• " bullets grouped by topic/person. Attribute messages to human display names shown in [human HH:MM] SpeakerName:, never mix up two speakers, never invent facts not in the timeline, and NEVER print raw Matrix IDs like @sp-...:matrix.netmind.chat (use natural labels like "你" / "大家" / "someone" if no display name is shown).'
            : 'Answer the user directly and naturally like a helpful human teammate. When the user follows up on last_drawn_tarot_cards, last_drawn_fortune_stick, d1_prefetched_records or recent_self_replies, answer from THOSE exact cards, sticks or records and never claim you cannot see what was just shown; when they ask a new question or for a new draw, give a fresh one. Keep replies concise and mobile-friendly (3-5 short lines or 2-3 "• " bullets). Never invent fake URLs.',
        ...BRAIN_CONTRACT,
        `Reply STRICTLY in ${langLabel}.`,
        'Never mention internal system errors, fallback models, or envelope metadata. Output ONLY the final reply text.',
    ].join('\n');
    let timer;
    try {
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('workers_ai_fallback_timeout')), 12_000);
        });
        const raw = await Promise.race([
            binding.run(model, {
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: envelope.slice(0, 12_000) },
                ],
                max_tokens: wantsSummary ? 420 : 320,
                temperature: 0.4,
            }),
            timeoutPromise,
        ]);
        const text = extractWorkersAiText(raw);
        return text || null;
    }
    catch {
        return null;
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
const schemaInitCache = new WeakMap();
/**
 * Ensures `NARRA_MEMORY_SCHEMA`, `NARRA_BROADCAST_SCHEMA`, and `narra_gateway_state`
 * exist in D1 once per isolate/D1 instance. Call ONLY when `isNarraGatewayEnabled(env)` is true.
 */
async function ensureGatewaySchemas(db) {
    let pending = schemaInitCache.get(db);
    if (!pending) {
        pending = (async () => {
            const mem = new MemoryStore(db, '__init__');
            await mem.ensureSchema();
            const bcast = new D1BroadcastStore(db);
            await bcast.ensureSchema();
            await runSchemaStatements(db, NARRA_GATEWAY_STATE_SCHEMA + NARRA_USAGE_SCHEMA);
        })().catch((err) => {
            schemaInitCache.delete(db);
            throw err;
        });
        schemaInitCache.set(db, pending);
    }
    await pending;
}
/** True when this room is outside NARRA_PIPELINE_ROOMS and NARRA_PIPELINE_ONLY_LISTED=on. */
export function isUnlistedRoomIgnored(env, roomId) {
    if ((env?.NARRA_PIPELINE_ONLY_LISTED ?? '').trim().toLowerCase() !== 'on')
        return false;
    const rooms = (env?.NARRA_PIPELINE_ROOMS ?? '').split(',').map((r) => r.trim()).filter(Boolean);
    return !rooms.includes(roomId);
}
/** Room posting manners for scheduled posts: on for shadow/v2 rooms, or everywhere with NARRA_ROOM_POSTING_RULES=on. */
export function roomPostingRulesFor(env, roomId) {
    const forced = (env?.NARRA_ROOM_POSTING_RULES ?? '').trim().toLowerCase() === 'on';
    if (!forced && pipelineForRoom(env, roomId) === 'v1')
        return undefined;
    return {
        ...DEFAULT_ROOM_POSTING_RULES,
        dailyCap: parseLimit(env?.NARRA_ROOM_DAILY_POSTS, DEFAULT_ROOM_POSTING_RULES.dailyCap),
    };
}
/**
 * Returns `true` ONLY when BOTH `NARRA_GATEWAY_ENABLED` is `'on'` AND `NARRA_AGENT_TOKEN` is non-empty.
 */
export function isNarraGatewayEnabled(env) {
    if (!env)
        return false;
    return ((env.NARRA_GATEWAY_ENABLED ?? '').trim() === 'on' &&
        (env.NARRA_AGENT_TOKEN ?? '').trim().length > 0);
}
export function isNarraSyncEnabled(env) {
    return isNarraGatewayEnabled(env) && (env?.NARRA_SYNC ?? '').trim() === 'on';
}
/**
 * Synapse refuses an HTTP pusher unless its URL path is exactly this (`M_MISSING_PARAM: 'url' must
 * have a path of '/_matrix/push/v1/notify'`), so the Worker must answer it at the origin root.
 */
export const NARRA_PUSH_NOTIFY_PATH = '/_matrix/push/v1/notify';
/** @deprecated Use NARRA_PUSH_NOTIFY_PATH. */
export const NARRA_PUSH_NOTIFY_SUFFIX = NARRA_PUSH_NOTIFY_PATH;
export const NARRA_PUSHER_APP_ID = 'nexus.narra.agent-kit';
/** User-defined override push rule that makes every room event notify, so every event wakes the agent. */
export const NARRA_WAKE_PUSH_RULE_ID = 'nexus.narra.agent-kit.wake';
/** In push mode, the sync DO still runs one non-blocking `/sync` this often in case a push is lost. */
export const NARRA_PUSH_BACKSTOP_MS = 60_000;
/** Pusher + push rule are re-asserted on the homeserver this often (and whenever the URL changes). */
const NARRA_PUSH_SETUP_REFRESH_MS = 6 * 60 * 60_000;
function pushSecret(env) {
    return (env?.NARRA_PUSH_SECRET ?? '').trim();
}
/**
 * Pusher URL: the origin of NARRA_PUSH_URL plus the fixed notify path (any path in NARRA_PUSH_URL is
 * ignored). Use a hostname this Worker owns at its root, e.g. its workers.dev URL. Returns null
 * without a usable https URL and a push secret of at least 16 characters.
 */
export function narraPushNotifyUrl(env) {
    const base = (env?.NARRA_PUSH_URL ?? '').trim();
    if (!base || pushSecret(env).length < 16)
        return null;
    let parsed;
    try {
        parsed = new URL(base);
    }
    catch {
        return null;
    }
    if (parsed.protocol !== 'https:')
        return null;
    return `${parsed.origin}${NARRA_PUSH_NOTIFY_PATH}`;
}
/**
 * The pushkey this agent registers, derived from NARRA_PUSH_SECRET. Synapse echoes it in every
 * notification (`devices[].pushkey`), which is how the Worker tells real pushes from anyone else
 * posting to the public notify path. Never log it.
 */
export async function narraPushKey(env) {
    const secret = pushSecret(env);
    if (secret.length < 16)
        return null;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`narra-agent-kit:pushkey:${secret}`)));
    return `nak:${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
/** True when sync is on, NARRA_SYNC_MODE is `push`, and a valid push URL + secret are configured. */
export function isNarraPushModeEnabled(env) {
    return (isNarraSyncEnabled(env) &&
        (env?.NARRA_SYNC_MODE ?? '').trim() === 'push' &&
        narraPushNotifyUrl(env) !== null);
}
async function errorSnippet(res) {
    const text = await res.text().catch(() => '');
    return text.replace(/\s+/g, ' ').slice(0, 160);
}
/**
 * Incremental `/sync` reports an invite only once, so invites that arrived while an older kit (that
 * ignored them) was running never show up again. A full, timeline-free `/sync` lists every pending
 * invite; the sync DO runs one this often.
 */
const INVITE_SWEEP_INTERVAL_MS = 30 * 60_000;
const INVITE_SWEEP_FILTER = JSON.stringify({
    presence: { types: [] },
    account_data: { types: [] },
    room: {
        timeline: { limit: 0 },
        state: { types: [] },
        ephemeral: { types: [] },
        account_data: { types: [] },
    },
});
/** Failed invite joins are retried no sooner than this, doubling per failure. */
const INVITE_RETRY_BASE_MS = 60_000;
const INVITE_RETRY_MAX_MS = 6 * 60 * 60_000;
function timingSafeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
function pushkeysFromNotification(body) {
    const devices = body?.notification?.devices;
    if (!Array.isArray(devices))
        return [];
    return devices
        .map((d) => d?.pushkey)
        .filter((k) => typeof k === 'string');
}
/**
 * Handles Synapse's HTTP pusher call (`POST <origin of NARRA_PUSH_URL>/_matrix/push/v1/notify`).
 * Returns `null` when the request is not a push call, so Workers can chain it before their own router:
 * ```ts
 * const pushed = await handleNarraPushRequest(request, env);
 * if (pushed) return pushed;
 * ```
 * A valid call only wakes the sync DO; events are still read through `/sync`, so dedupe, room meta
 * and backstops behave exactly as in long-poll mode. A pushkey that does not match NARRA_PUSH_SECRET,
 * or push mode being off, is answered with the pushkeys `rejected`, which makes Synapse drop the
 * stale pusher.
 */
export async function handleNarraPushRequest(request, env) {
    if (new URL(request.url).pathname !== NARRA_PUSH_NOTIFY_PATH)
        return null;
    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
    }
    const body = await request.json().catch(() => null);
    const pushkeys = pushkeysFromNotification(body);
    const expected = await narraPushKey(env);
    const authentic = expected !== null && pushkeys.some((key) => timingSafeEqual(key, expected));
    if (!isNarraPushModeEnabled(env) || !env.NARRA_SYNC_DO || !authentic) {
        return Response.json({ rejected: pushkeys });
    }
    const stub = env.NARRA_SYNC_DO.get(env.NARRA_SYNC_DO.idFromName('narra'));
    await stub.fetch('https://narra-sync/push', { method: 'POST' });
    return Response.json({ rejected: [] });
}
function scrubSecrets(value, env, extraSecrets = []) {
    let text = redactSecrets(value);
    const candidates = [
        env?.NARRA_AGENT_TOKEN,
        env?.MATRIX_ACCESS_TOKEN,
        env?.MANYFOLD_A2A_TOKEN,
        env?.NARRA_PUSH_SECRET,
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
function narraEndpoint(env) {
    return (env.NARRA_API_ENDPOINT ?? DEFAULT_NARRA_API_ENDPOINT).replace(/\/+$/, '');
}
function doKeyValueStore(storage) {
    return {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        delete: (key) => storage.delete(key),
        list: (options) => storage.list(options),
    };
}
async function appendDoLog(storage, line, nowMs, env) {
    const existing = (await storage.get('log')) ?? [];
    const entry = `${new Date(nowMs).toISOString()} ${scrubSecrets(line, env)}`;
    console.log(`[narra-gateway] ${entry}`);
    await storage.put('log', [...existing, entry].slice(-MAX_LOG_LINES));
}
async function deterministicTxnId(seed) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`narra-gw:${seed}`))).slice(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function isAllowedHomeserverOrigin(rawUrl, extraAllowed = []) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        throw new SyncError('Invalid Matrix homeserver URL.');
    }
    if (url.protocol !== 'https:') {
        throw new SyncError('Matrix homeserver URL must use https.');
    }
    const host = url.hostname.toLowerCase();
    const allowed = host === 'netmind.chat' ||
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
function makeSendFailure(message, status, opts = {}) {
    const err = new Error(redactSecrets(message));
    err.name = 'NarraSendError';
    err.status = status;
    err.errcode = opts.errcode;
    err.narraCode = opts.narraCode;
    err.retryable =
        opts.retryable ??
            (status === 401 || status === 403 || status === 429 || status >= 500 || status === 0);
    return err;
}
function hasExplicitLangSignal(text, extraMentionNames) {
    const trimmed = (text ?? '').trim();
    if (!trimmed)
        return false;
    const options = extraMentionNames?.length ? { extraMentionNames: [...extraMentionNames] } : undefined;
    const a = detectLang(trimmed, 'zh-Hant', 'zh-Hant', options);
    const b = detectLang(trimmed, 'zh-Hans', 'zh-Hans', options);
    const c = detectLang(trimmed, 'en', 'en', options);
    return a === b && b === c;
}
function detectUpdatedUserLang(ev, effectiveSpec, mentionNames) {
    const stripped = stripAgentMentions(ev.text, mentionNames).trim();
    const explicitSwitch = detectExplicitLangSwitch(stripped);
    if (explicitSwitch) {
        if (ev.chatType === 'dm' || isSelfMentioned(ev, effectiveSpec)) {
            return { lang: explicitSwitch, isSwitch: true };
        }
        return null;
    }
    if (hasExplicitLangSignal(ev.text, mentionNames)) {
        const explicit = detectLang(ev.text, undefined, undefined, {
            extraMentionNames: [...mentionNames],
        });
        return { lang: explicit, isSwitch: false };
    }
    return null;
}
function isNormalizedInboundEvent(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return false;
    const obj = raw;
    return (typeof obj.eventId === 'string' &&
        typeof obj.senderId === 'string' &&
        typeof obj.roomId === 'string' &&
        typeof obj.kind === 'string' &&
        typeof obj.text === 'string' &&
        Array.isArray(obj.mentions));
}
async function defaultResolveA2ACredential(env, spec) {
    const url = (env.MANYFOLD_A2A_URL ?? '').trim();
    const token = (env.MANYFOLD_A2A_TOKEN ?? '').trim();
    if (url && token) {
        return { url, token, label: spec.name };
    }
    return null;
}
async function postViaNarraChatApi(env, input) {
    const token = (env.NARRA_AGENT_TOKEN ?? '').trim();
    if (!token) {
        throw makeSendFailure('NARRA_AGENT_TOKEN is not set.', 0, { retryable: false });
    }
    const doFetch = input.fetchImpl ?? fetch;
    const base = narraEndpoint(env);
    let response;
    try {
        response = await fetchWithDeadline(doFetch, `${base}/api/agent-runtime/chat/send`, {
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
        }, 15_000);
    }
    catch (error) {
        throw makeSendFailure(`Narra chat/send unreachable: ${scrubSecrets(error instanceof Error ? error.message : error, env)}`, 599, { retryable: true });
    }
    const parsed = (await response.json().catch(() => null));
    const data = (parsed && typeof parsed.data === 'object' && parsed.data ? parsed.data : parsed);
    if (!response.ok || (parsed && typeof parsed.status === 'string' && parsed.status !== 'ok')) {
        const issues = Array.isArray(parsed?.issues)
            ? parsed.issues
            : [];
        const issueCode = issues.find((i) => typeof i?.code === 'string')?.code;
        const narraCode = typeof parsed?.narra_error_code === 'string' ? parsed.narra_error_code : issueCode;
        const errcode = typeof parsed?.errcode === 'string' ? parsed.errcode : undefined;
        throw makeSendFailure(`Narra chat/send failed: HTTP ${response.status}${narraCode ? ` (${narraCode})` : ''}`, response.status, {
            errcode,
            narraCode,
            retryable: response.status === 429 ||
                response.status >= 500 ||
                response.status === 403 ||
                narraCode === 'agent_chain_exhausted' ||
                narraCode === 'matrix-membership-unverified',
        });
    }
    return {
        eventId: typeof data?.event_id === 'string' ? data.event_id : '',
    };
}
function emptyMemories() {
    return { userMemories: [], roomMemories: [], promptSafeLines: [] };
}
function findSubsequentHistory(recentHistory, event) {
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
    return recentHistory.filter((h) => !coalescedSet.has(h.eventId) && h.eventId !== event.eventId && h.timestampMs > event.timestampMs);
}
/**
 * Base Durable Object for Matrix `/sync` + `/messages` backstop + in-memory credential handling.
 * Consumer Workers subclass this locally (e.g. `export class NarraMatrixSync extends BaseNarraMatrixSync {}`)
 * so `@cloudflare/vite-plugin` and `wrangler` detect Durable Objects statically.
 */
export class BaseNarraMatrixSync {
    ctx;
    env;
    explicitConfig;
    /** Strictly in-memory Matrix login cache; NEVER persisted to DO storage or logged. */
    cache = {};
    constructor(ctx, env, config) {
        this.ctx = ctx;
        this.env = env;
        this.explicitConfig = config;
    }
    getConfig() {
        if (this.explicitConfig)
            return this.explicitConfig;
        throw new Error('BaseNarraMatrixSync requires config via super(ctx, env, config), createNarraWorkerGateway(config), or getConfig() override.');
    }
    nowMs() {
        return this.getConfigSafe()?.now?.() ?? Date.now();
    }
    getConfigSafe() {
        try {
            return this.getConfig();
        }
        catch {
            return undefined;
        }
    }
    isSyncActive() {
        return isNarraSyncEnabled(this.env);
    }
    async resolveLogin(forceRefresh = false) {
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
            const origin = isAllowedHomeserverOrigin((this.env.MATRIX_HOMESERVER_URL ?? DEFAULT_MATRIX_HOMESERVER).trim(), cfg.allowedHomeserverHosts);
            const login = {
                homeserverUrl: origin,
                userId: fallbackUserId,
                accessToken: directAccessToken,
            };
            this.cache.login = login;
            await this.ctx.storage.put('matrixUserId', login.userId);
            return { login, wasCached: false };
        }
        const login = await fetchMatrixCredential({
            narraApiEndpoint: narraEndpoint(this.env),
            narraAgentToken: this.env.NARRA_AGENT_TOKEN,
            allowedHomeserverHosts: cfg.allowedHomeserverHosts,
            fetchImpl: cfg.fetchImpl,
        }, this.cache);
        await this.ctx.storage.put('matrixUserId', login.userId);
        return { login, wasCached: false };
    }
    async callHomeserver(login, op, fetchImpl) {
        const enc = encodeURIComponent;
        if (op.op === 'fetchEvent') {
            const event = await fetchEventContext(login, op.roomId, op.eventId, fetchImpl);
            if (!event)
                return { ok: false, status: 404, errcode: 'M_NOT_FOUND' };
            return { ok: true, event };
        }
        if (op.op === 'recentMessages') {
            try {
                const res = await fetchRoomMessagesBackstop(login, op.roomId, { dir: 'b', limit: op.limit ?? 8 }, fetchImpl);
                return { ok: true, events: res.events };
            }
            catch {
                return { ok: false, status: 500, errcode: 'MESSAGES_FETCH_FAILED' };
            }
        }
        const roomBase = `${login.homeserverUrl}/_matrix/client/v3/rooms/${enc(op.roomId)}`;
        let method = 'PUT';
        let url;
        let body;
        if (op.op === 'react') {
            const txnId = op.txnId || crypto.randomUUID();
            url = `${roomBase}/send/m.reaction/${enc(txnId)}`;
            body = { ...(op.extra ?? {}), 'm.relates_to': { rel_type: 'm.annotation', event_id: op.eventId, key: op.key } };
        }
        else if (op.op === 'claim') {
            const txnId = op.txnId || crypto.randomUUID();
            url = `${roomBase}/send/${CLAIM_EVENT_TYPE}/${enc(txnId)}`;
            body = { target: op.eventId, priority_milli: op.priorityMilli, reason: op.reason };
        }
        else if (op.op === 'redact') {
            const txnId = op.txnId || crypto.randomUUID();
            url = `${roomBase}/redact/${enc(op.eventId)}/${enc(txnId)}`;
            body = op.reason ? { reason: op.reason } : {};
        }
        else if (op.op === 'send') {
            const txnId = op.txnId || crypto.randomUUID();
            url = `${roomBase}/send/m.room.message/${enc(txnId)}`;
            body = op.content;
        }
        else if (op.op === 'edit') {
            const txnId = op.txnId || crypto.randomUUID();
            url = `${roomBase}/send/m.room.message/${enc(txnId)}`;
            if (op.content) {
                body = op.content;
            }
            else if (op.eventId && typeof op.text === 'string') {
                body = editContent(op.eventId, op.text, {
                    selfMatrixId: op.selfMatrixId ?? login.userId,
                });
            }
            else {
                return { ok: false, status: 400, errcode: 'BAD_EDIT_OP' };
            }
        }
        else if (op.op === 'typing') {
            url = `${roomBase}/typing/${enc(login.userId)}`;
            body = op.typing ? { typing: true, timeout: op.timeoutMs ?? 30_000 } : { typing: false };
        }
        else {
            method = 'POST';
            url = `${roomBase}/receipt/m.read/${enc(op.eventId)}`;
            body = {};
        }
        let response;
        try {
            response = await fetchWithDeadline(fetchImpl, url, {
                method,
                headers: {
                    authorization: `Bearer ${login.accessToken}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify(body),
            }, 15_000);
        }
        catch (error) {
            return {
                ok: false,
                status: 599,
                errcode: scrubSecrets(error instanceof Error ? error.message : error, this.env).slice(0, 120),
            };
        }
        const parsed = (await response.json().catch(() => ({})));
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
    async executeMatrixOp(op) {
        if (!this.isSyncActive()) {
            return { ok: false, status: 0, errcode: isNarraGatewayEnabled(this.env) ? 'SYNC_OFF' : 'GATEWAY_DISABLED' };
        }
        const cfg = this.getConfig();
        const doFetch = cfg.fetchImpl ?? fetch;
        let resolved;
        try {
            resolved = await this.resolveLogin(false);
        }
        catch (error) {
            await appendDoLog(this.ctx.storage, `matrix login failed: ${scrubSecrets(error instanceof Error ? error.message : error, this.env)}`, this.nowMs(), this.env);
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
                }
                catch {
                    return { ok: false, status: 401, errcode: 'M_UNKNOWN_TOKEN' };
                }
            }
        }
        return result;
    }
    async updateRoomMetaFromSync(response, nowMs) {
        const joinedRooms = response.rooms?.join ?? {};
        if (Object.keys(joinedRooms).length === 0)
            return;
        const knownRoomIds = new Set((await this.ctx.storage.get('roomIds')) ?? []);
        for (const [roomId, joined] of Object.entries(joinedRooms)) {
            knownRoomIds.add(roomId);
            const existing = await this.ctx.storage.get(`roomMeta:${roomId}`);
            const memberMap = new Map();
            for (const m of existing?.members ?? []) {
                memberMap.set(m.matrixId, m);
            }
            let roomName = existing?.roomName;
            for (const st of joined.state?.events ?? []) {
                if (st.type === 'm.room.name') {
                    const content = (st.content ?? {});
                    if (typeof content.name === 'string' && content.name.trim()) {
                        roomName = content.name.trim();
                    }
                }
                else if (st.type === 'm.room.member' && typeof st.state_key === 'string') {
                    const content = (st.content ?? {});
                    if (content.membership === 'join') {
                        memberMap.set(st.state_key, {
                            matrixId: st.state_key,
                            displayName: typeof content.displayname === 'string' ? content.displayname : undefined,
                            isAgent: isNarraAgent(st.state_key),
                        });
                    }
                    else if (content.membership === 'leave' || content.membership === 'ban') {
                        memberMap.delete(st.state_key);
                    }
                }
            }
            const members = [...memberMap.values()];
            const inferredChatType = existing?.chatType ?? (members.length === 2 && !roomName ? 'dm' : 'group');
            const isProvisional = existing ? Boolean(existing.provisional) : true;
            await this.ctx.storage.put(`roomMeta:${roomId}`, {
                roomId,
                ...(roomName ? { roomName } : {}),
                chatType: inferredChatType,
                members,
                updatedAtMs: nowMs,
                ...(isProvisional ? { provisional: true } : {}),
            });
        }
        await this.ctx.storage.put('roomIds', [...knownRoomIds].slice(-100));
    }
    async refreshNarraRoomsMeta(nowMs, force = false) {
        const lastRefreshed = (await this.ctx.storage.get('roomsMetaRefreshedAt')) ?? 0;
        if (!force && nowMs - lastRefreshed < ROOM_META_REFRESH_MS)
            return false;
        const token = (this.env.NARRA_AGENT_TOKEN ?? '').trim();
        if (!token)
            return false;
        const cfg = this.getConfig();
        const doFetch = cfg.fetchImpl ?? fetch;
        try {
            const url = new URL(`${narraEndpoint(this.env)}/api/agent-runtime/chat/rooms`);
            url.searchParams.set('conversation_type', 'all');
            url.searchParams.set('include_members', 'true');
            const res = await fetchWithDeadline(doFetch, url.toString(), {
                headers: { authorization: `Bearer ${token}` },
            }, 10_000);
            if (!res.ok)
                return false;
            const body = (await res.json().catch(() => null));
            const data = (body && typeof body.data === 'object' && body.data ? body.data : body);
            if (!data)
                return false;
            const agent = (data.agent ?? {});
            if (typeof agent.matrix_user_id === 'string' && agent.matrix_user_id.startsWith('@')) {
                await this.ctx.storage.put('matrixUserId', agent.matrix_user_id);
            }
            const rooms = Array.isArray(data.rooms) ? data.rooms : [];
            const roomIds = new Set((await this.ctx.storage.get('roomIds')) ?? []);
            for (const r of rooms) {
                const roomId = typeof r.room_id === 'string' ? r.room_id : '';
                if (!roomId)
                    continue;
                roomIds.add(roomId);
                const rawMembers = Array.isArray(r.members) ? r.members : [];
                const members = rawMembers
                    .filter((m) => typeof m.matrix_user_id === 'string')
                    .map((m) => ({
                    matrixId: String(m.matrix_user_id),
                    displayName: typeof m.display_name === 'string' ? m.display_name : undefined,
                    isAgent: isNarraAgent(String(m.matrix_user_id)),
                }));
                const rawType = String(r.conversation_type ?? r.chat_type ?? r.type ?? '').toLowerCase();
                const chatType = ['dm', 'direct', 'private', 'one_on_one'].includes(rawType)
                    ? 'dm'
                    : 'group';
                const roomName = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : undefined;
                await this.ctx.storage.put(`roomMeta:${roomId}`, {
                    roomId,
                    ...(roomName ? { roomName } : {}),
                    chatType,
                    members,
                    updatedAtMs: nowMs,
                });
            }
            await this.ctx.storage.put('roomIds', [...roomIds].slice(-100));
            await this.ctx.storage.put('roomsMetaRefreshedAt', nowMs);
            return true;
        }
        catch {
            // Non-fatal: sync falls back cleanly to /sync m.room.member state events.
            return false;
        }
    }
    async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === 'POST' && path.endsWith('/matrix')) {
            const body = (await request.json().catch(() => null));
            if (!body || typeof body.op !== 'string' || typeof body.roomId !== 'string') {
                return Response.json({ ok: false, status: 400, errcode: 'BAD_MATRIX_OP' }, { status: 400 });
            }
            const result = await this.executeMatrixOp(body);
            return Response.json(result);
        }
        if (request.method === 'GET' && path.endsWith('/status')) {
            const syncState = (await this.ctx.storage.get('sync')) ?? null;
            const roomIds = (await this.ctx.storage.get('roomIds')) ?? [];
            const logs = (await this.ctx.storage.get('log')) ?? [];
            return Response.json({
                enabled: this.isSyncActive(),
                gatewayEnabled: isNarraGatewayEnabled(this.env),
                syncFlag: (this.env.NARRA_SYNC ?? '').trim() === 'on',
                alarm: await this.ctx.storage.getAlarm(),
                syncMode: isNarraPushModeEnabled(this.env) ? 'push' : 'longpoll',
                pushRegisteredAtMs: (await this.ctx.storage.get('pushSetup'))?.atMs ?? null,
                lastPushWakeAtMs: (await this.ctx.storage.get('pushWakeAt')) ?? null,
                started: Boolean(syncState?.since),
                failures: syncState?.failures ?? 0,
                lastOk: (await this.ctx.storage.get('lastOk')) ?? null,
                hasInMemoryLogin: Boolean(this.cache.login),
                matrixUserId: (await this.ctx.storage.get('matrixUserId')) ?? null,
                roomCount: roomIds.length,
                roomIds,
                log: logs.map((line) => scrubSecrets(line, this.env)),
            });
        }
        if (request.method === 'POST' && path.endsWith('/push')) {
            if (!isNarraPushModeEnabled(this.env)) {
                return Response.json({ ok: true, woke: false });
            }
            const now = this.nowMs();
            await this.ctx.storage.put('pushWakeAt', now);
            await this.ctx.storage.put('pushSeq', ((await this.ctx.storage.get('pushSeq')) ?? 0) + 1);
            const current = await this.ctx.storage.getAlarm();
            if (current === null || current > now) {
                await this.ctx.storage.setAlarm(now);
            }
            return Response.json({ ok: true, woke: true });
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
    async homeserverRequest(login, method, path, body) {
        const doFetch = this.getConfig().fetchImpl ?? fetch;
        return fetchWithDeadline(doFetch, `${login.homeserverUrl}/_matrix/client/v3${path}`, {
            method,
            headers: {
                authorization: `Bearer ${login.accessToken}`,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }, 10_000);
    }
    /**
     * Narra creates a new DM (or adds the agent to a group) with the agent only *invited*; nothing
     * joined on the agent's behalf, so those rooms never reached `/sync` `rooms.join` and new users
     * got no reply. Narra already decides who may start a chat with an agent (agent_request /
     * connection approval), so the agent accepts every invite it is sent.
     * Returns how many rooms were joined in this call.
     */
    async acceptInvites(login, response, nowMs) {
        const invited = Object.keys(response.rooms?.invite ?? {});
        if (invited.length === 0)
            return 0;
        const storage = this.ctx.storage;
        const attempts = (await storage.get('inviteAttempts')) ?? {};
        let joined = 0;
        for (const roomId of invited) {
            const prior = attempts[roomId];
            if (prior && prior.nextAtMs > nowMs)
                continue;
            let res;
            try {
                res = await this.homeserverRequest(login, 'POST', `/rooms/${encodeURIComponent(roomId)}/join`, {});
            }
            catch (error) {
                res = new Response(String(error instanceof Error ? error.message : error), { status: 599 });
            }
            if (res.ok) {
                delete attempts[roomId];
                joined++;
                void appendDoLog(storage, `accepted invite to ${roomId}`, nowMs, this.env);
                continue;
            }
            if (res.status === 401)
                this.cache.login = undefined;
            const failures = (prior?.failures ?? 0) + 1;
            attempts[roomId] = {
                failures,
                nextAtMs: nowMs + Math.min(INVITE_RETRY_MAX_MS, INVITE_RETRY_BASE_MS * 2 ** (failures - 1)),
            };
            void appendDoLog(storage, `invite join failed for ${roomId} (${failures}): HTTP ${res.status} ${await errorSnippet(res)}`, nowMs, this.env);
        }
        for (const roomId of Object.keys(attempts)) {
            if (!invited.includes(roomId))
                delete attempts[roomId];
        }
        await storage.put('inviteAttempts', attempts);
        return joined;
    }
    /**
     * Makes sure the homeserver pushes every new event of this agent to our Worker: one HTTP pusher
     * (event_id_only payload, no message content leaves Synapse) and one override rule that marks
     * every event as notifying (edits, redactions and reactions are silent by default).
     * Returns false (caller falls back to long-poll) when either call fails.
     */
    /** Joins invites that incremental `/sync` will never report again (see INVITE_SWEEP_INTERVAL_MS). */
    async sweepPendingInvites(nowMs) {
        const storage = this.ctx.storage;
        const last = (await storage.get('inviteSweepAt')) ?? 0;
        if (nowMs - last < INVITE_SWEEP_INTERVAL_MS)
            return 0;
        if (!(await storage.get('sync'))?.since) {
            // No sync token yet: the initial /sync lists every pending invite and acceptInvites sees it.
            await storage.put('inviteSweepAt', nowMs);
            return 0;
        }
        try {
            const { login } = await this.resolveLogin(false);
            const res = await this.homeserverRequest(login, 'GET', `/sync?timeout=0&set_presence=offline&filter=${encodeURIComponent(INVITE_SWEEP_FILTER)}`);
            if (res.status === 401)
                this.cache.login = undefined;
            if (!res.ok)
                throw new Error(`invite sweep HTTP ${res.status} ${await errorSnippet(res)}`);
            const body = (await res.json());
            await storage.put('inviteSweepAt', nowMs);
            const pending = Object.keys(body.rooms?.invite ?? {}).length;
            if (pending > 0) {
                void appendDoLog(storage, `invite sweep found ${pending} pending invite(s)`, nowMs, this.env);
            }
            return await this.acceptInvites(login, body, nowMs);
        }
        catch (error) {
            void appendDoLog(storage, `invite sweep failed: ${error instanceof Error ? error.message : String(error)}`, nowMs, this.env);
            return 0;
        }
    }
    async ensurePushSetup(nowMs) {
        const url = narraPushNotifyUrl(this.env);
        const pushkey = await narraPushKey(this.env);
        if (!url || !pushkey)
            return false;
        const storage = this.ctx.storage;
        const stored = await storage.get('pushSetup');
        if (stored &&
            stored.url === url &&
            stored.pushkey === pushkey &&
            nowMs - stored.atMs < NARRA_PUSH_SETUP_REFRESH_MS) {
            return true;
        }
        try {
            const { login } = await this.resolveLogin(false);
            const ruleRes = await this.homeserverRequest(login, 'PUT', `/pushrules/global/override/${encodeURIComponent(NARRA_WAKE_PUSH_RULE_ID)}`, { conditions: [], actions: ['notify'] });
            if (ruleRes.status === 401)
                this.cache.login = undefined;
            if (!ruleRes.ok)
                throw new Error(`push rule HTTP ${ruleRes.status} ${await errorSnippet(ruleRes)}`);
            const pusherRes = await this.homeserverRequest(login, 'POST', '/pushers/set', {
                kind: 'http',
                app_id: NARRA_PUSHER_APP_ID,
                pushkey,
                app_display_name: 'Narra Agent Kit',
                device_display_name: this.getConfig().spec.name ?? 'agent',
                lang: 'en',
                append: false,
                data: { url, format: 'event_id_only' },
            });
            if (pusherRes.status === 401)
                this.cache.login = undefined;
            if (!pusherRes.ok)
                throw new Error(`pusher HTTP ${pusherRes.status} ${await errorSnippet(pusherRes)}`);
            await storage.put('pushSetup', { url, pushkey, atMs: nowMs });
            void appendDoLog(storage, 'push mode: pusher + wake rule registered', nowMs, this.env);
            return true;
        }
        catch (error) {
            void appendDoLog(storage, `push setup failed, using long-poll: ${error instanceof Error ? error.message : String(error)}`, nowMs, this.env);
            return false;
        }
    }
    /** Removes the pusher + wake rule after switching back to long-poll (best effort). */
    async teardownPushSetup() {
        const storage = this.ctx.storage;
        const stored = await storage.get('pushSetup');
        if (!stored)
            return;
        try {
            const { login } = await this.resolveLogin(false);
            await this.homeserverRequest(login, 'POST', '/pushers/set', {
                kind: null,
                app_id: NARRA_PUSHER_APP_ID,
                pushkey: stored.pushkey,
            });
            await this.homeserverRequest(login, 'DELETE', `/pushrules/global/override/${encodeURIComponent(NARRA_WAKE_PUSH_RULE_ID)}`);
        }
        catch {
            // Best effort: a stale pusher gets `rejected` by handleNarraPushRequest and Synapse drops it.
        }
        await storage.delete('pushSetup');
    }
    async alarm() {
        if (!this.isSyncActive()) {
            await this.ctx.storage.deleteAlarm();
            this.cache.login = undefined;
            return;
        }
        const cfg = this.getConfig();
        const doFetch = cfg.fetchImpl ?? fetch;
        const nowMs = this.nowMs();
        const storage = this.ctx.storage;
        // Wall-clock per step, logged when a push-mode run is slow (the DO is billed for all of it).
        const clock = Date.now;
        const timing = {};
        let mark = clock();
        const lap = (name) => {
            const t = clock();
            timing[name] = (timing[name] ?? 0) + (t - mark);
            mark = t;
        };
        // Push mode: Synapse wakes us per event, so /sync never waits. If the pusher cannot be
        // registered this round, fall back to a normal long-poll so no message is delayed.
        const pushReady = isNarraPushModeEnabled(this.env)
            ? await this.ensurePushSetup(nowMs)
            : (await this.teardownPushSetup(), false);
        lap('pushSetup');
        const pushSeqAtStart = (await storage.get('pushSeq')) ?? 0;
        let joinedInvites = await this.sweepPendingInvites(nowMs);
        lap('inviteSweep');
        await this.refreshNarraRoomsMeta(nowMs);
        lap('roomsMeta');
        let syncHost = '';
        const delay = await syncOnce(doKeyValueStore(storage), {
            login: async () => {
                lap('beforeLogin');
                const login = (await this.resolveLogin(false)).login;
                lap('login');
                return login;
            },
            sync: async (login, since, timeoutMs) => {
                lap('beforeSync');
                syncHost = new URL(login.homeserverUrl).host;
                const response = await matrixSyncRequest(login, since, timeoutMs, doFetch);
                lap(`sync(timeout=${timeoutMs})`);
                await this.updateRoomMetaFromSync(response, nowMs);
                joinedInvites += await this.acceptInvites(login, response, nowMs);
                lap('afterSync');
                return response;
            },
            backstop: async (login, roomId, prevBatch) => {
                const res = await fetchRoomMessagesBackstop(login, roomId, { ...(prevBatch ? { from: prevBatch } : {}), dir: 'b', limit: 50 }, doFetch);
                return res.events;
            },
            onBatch: async (rooms) => {
                const selfMatrixId = this.cache.login?.userId ??
                    (await storage.get('matrixUserId')) ??
                    cfg.spec.matrixId;
                if (this.env.NARRA_ROOM_DO) {
                    let forcedRefresh = false;
                    let forcedRefreshOk = false;
                    for (const room of rooms) {
                        if (room.events.length === 0)
                            continue;
                        let meta = await storage.get(`roomMeta:${room.roomId}`);
                        if ((!meta || meta.provisional) && !forcedRefresh) {
                            forcedRefresh = true;
                            forcedRefreshOk = await this.refreshNarraRoomsMeta(this.nowMs(), true);
                            meta = await storage.get(`roomMeta:${room.roomId}`);
                        }
                        if (forcedRefreshOk && meta?.provisional) {
                            const { provisional: _drop, ...settled } = meta;
                            meta = settled;
                            await storage.put(`roomMeta:${room.roomId}`, settled);
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
        }, this.cache, pushReady ? { timeoutMs: 0 } : {});
        lap('batch');
        const total = Object.values(timing).reduce((a, b) => a + b, 0);
        if (pushReady && total > 3_000) {
            const steps = Object.entries(timing)
                .filter(([, ms]) => ms >= 50)
                .map(([name, ms]) => `${name}=${ms}ms`)
                .join(' ');
            void appendDoLog(storage, `slow run ${total}ms (${syncHost}): ${steps}`, nowMs, this.env);
        }
        if (this.isSyncActive()) {
            let next = delay;
            if (delay === 0 && joinedInvites > 0) {
                // Read the newly joined rooms (and the message that came with the invite) right away.
                next = 0;
            }
            else if (pushReady && delay === 0) {
                // A push that landed while this run was in flight must not be swallowed by the backstop delay.
                const pushSeqNow = (await storage.get('pushSeq')) ?? 0;
                next = pushSeqNow !== pushSeqAtStart ? 0 : NARRA_PUSH_BACKSTOP_MS;
            }
            await storage.setAlarm(this.nowMs() + next);
        }
        else {
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
export class BaseNarraRoomCoordinator {
    ctx;
    env;
    explicitConfig;
    constructor(ctx, env, config) {
        this.ctx = ctx;
        this.env = env;
        this.explicitConfig = config;
    }
    getConfig() {
        if (this.explicitConfig)
            return this.explicitConfig;
        throw new Error('BaseNarraRoomCoordinator requires config via super(ctx, env, config), createNarraWorkerGateway(config), or getConfig() override.');
    }
    nowMs() {
        return this.getConfig().now?.() ?? Date.now();
    }
    async runLocked(fn) {
        if (typeof this.ctx.blockConcurrencyWhile === 'function') {
            return this.ctx.blockConcurrencyWhile(fn);
        }
        return fn();
    }
    createCoalescer(nowMs, buffers) {
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
    async getEffectiveSpec() {
        const cfg = this.getConfig();
        const storedMatrixId = await this.ctx.storage.get('selfMatrixId');
        const matrixId = cfg.spec.matrixId ?? storedMatrixId ?? this.env.MATRIX_USER_ID;
        return matrixId ? { ...cfg.spec, matrixId } : cfg.spec;
    }
    async markEventHandled(eventId) {
        if (!eventId)
            return;
        const handledList = (await this.ctx.storage.get('handledIds')) ?? [];
        if (!handledList.includes(eventId)) {
            handledList.push(eventId);
            await this.ctx.storage.put('handledIds', handledList.slice(-MAX_HANDLED_IDS));
        }
    }
    async getMemoryStore() {
        if (!isNarraGatewayEnabled(this.env) || !this.env.DB)
            return null;
        await ensureGatewaySchemas(this.env.DB);
        return new MemoryStore(this.env.DB, this.getConfig().spec.id);
    }
    async matrixOp(op) {
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
            return (await response.json());
        }
        catch {
            return { ok: false, status: 599, errcode: 'SYNC_DO_UNREACHABLE' };
        }
    }
    async hydrateReplyTarget(roomId, replyToEventId, selfMatrixId) {
        if (!replyToEventId)
            return undefined;
        const ownMessages = (await this.ctx.storage.get('ownMessages')) ?? [];
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
        const cache = (await this.ctx.storage.get('messageCache')) ?? {};
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
        const history = (await this.ctx.storage.get('recentHistory')) ?? [];
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
    async trimAndPutMessageCache(cache) {
        const entries = Object.values(cache)
            .sort((a, b) => a.timestampMs - b.timestampMs)
            .slice(-MAX_MESSAGE_CACHE);
        const next = {};
        for (const item of entries)
            next[item.eventId] = item;
        await this.ctx.storage.put('messageCache', next);
    }
    async scheduleNextAlarm(nowMs) {
        const bursts = (await this.ctx.storage.get('bursts')) ?? [];
        const coalescer = this.createCoalescer(nowMs, bursts);
        const burstAt = coalescer.nextFlushAt();
        const pendingTurns = (await this.ctx.storage.get('pendingTurns')) ?? [];
        let turnAt = null;
        for (const turn of pendingTurns) {
            if (turnAt === null || turn.dueAtMs < turnAt)
                turnAt = turn.dueAtMs;
        }
        let nextAt = null;
        if (burstAt !== null && turnAt !== null)
            nextAt = Math.min(burstAt, turnAt);
        else
            nextAt = burstAt ?? turnAt;
        if (nextAt !== null) {
            await this.ctx.storage.setAlarm(nextAt);
        }
        else {
            await this.ctx.storage.deleteAlarm();
        }
        return nextAt;
    }
    async computeShouldQuote(event, chatType) {
        const recentHistory = (await this.ctx.storage.get('recentHistory')) ?? [];
        const latestEventId = await this.ctx.storage.get('latestEventId');
        const latestHumanEventId = await this.ctx.storage.get('latestHumanEventId');
        const coalescedSet = new Set(event.coalescedEventIds ?? [event.eventId]);
        const subsequentEvents = findSubsequentHistory(recentHistory, event).map((h) => ({
            eventId: h.eventId,
            senderId: h.senderId,
            ...(h.answersEventId ? { answersEventId: h.answersEventId } : {}),
            ...(h.isBroadcast ? { isBroadcast: true } : {}),
        }));
        // If the trigger event's own coalesced ID includes the latestHumanEventId, check whether
        // any non-coalesced human event sits strictly after it.
        const effectiveLatestHumanId = latestHumanEventId && coalescedSet.has(latestHumanEventId) ? event.eventId : latestHumanEventId;
        const effectiveLatestId = latestEventId && coalescedSet.has(latestEventId) ? event.eventId : latestEventId;
        return shouldQuote(event, {
            chatType,
            latestEventId: effectiveLatestId,
            latestHumanEventId: effectiveLatestHumanId,
            subsequentEvents,
        });
    }
    async postReplyToRoom(roomId, text, txnSeed, selfMatrixId, replyToEventId, answersEventId) {
        const txnId = await deterministicTxnId(txnSeed);
        const content = messageContent(text, {
            selfMatrixId,
            replyToEventId,
            ...(answersEventId ? { answersEventId } : {}),
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
                throw makeSendFailure(`Matrix send failed: HTTP ${matrixRes.status}${code ? ` (${code})` : ''}`, matrixRes.status, { errcode: matrixRes.errcode, narraCode: matrixRes.narraCode });
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
    async editReplyInRoom(roomId, targetEventId, text, txnSeed, selfMatrixId, replyToEventId) {
        if (!targetEventId || !isNarraSyncEnabled(this.env) || !this.env.NARRA_SYNC_DO) {
            return false;
        }
        const txnId = await deterministicTxnId(`edit:${txnSeed}`);
        const content = replyToEventId
            ? editContent(targetEventId, text, { selfMatrixId, replyToEventId })
            : undefined;
        const res = await this.matrixOp({
            op: 'edit',
            roomId,
            eventId: targetEventId,
            text,
            txnId,
            selfMatrixId,
            ...(content ? { content } : {}),
        }).catch(() => ({ ok: false, status: 0 }));
        if (res.ok)
            return true;
        if (replyToEventId && res.status >= 400 && res.status < 500) {
            const retryTxnId = await deterministicTxnId(`edit-plain:${txnSeed}`);
            const retryRes = await this.matrixOp({
                op: 'edit',
                roomId,
                eventId: targetEventId,
                text,
                txnId: retryTxnId,
                selfMatrixId,
            }).catch(() => ({ ok: false, status: 0 }));
            return retryRes.ok;
        }
        return false;
    }
    async loadExpandedHistoryForSummary(roomId, baseHistory, selfMatrixId, members, limit = 40) {
        const memberNames = new Map();
        for (const m of members) {
            if (m.matrixId && m.displayName)
                memberNames.set(m.matrixId, m.displayName);
        }
        const fetched = [];
        if (isNarraSyncEnabled(this.env) && this.env.NARRA_SYNC_DO) {
            const mat = await this.matrixOp({
                op: 'recentMessages',
                roomId,
                limit,
            }).catch(() => ({ ok: false, status: 0 }));
            if (mat.ok && Array.isArray(mat.events)) {
                fetched.push(...mat.events);
            }
        }
        if (fetched.length < Math.min(limit, 15) && (this.env.NARRA_AGENT_TOKEN ?? '').trim()) {
            const backstop = await fetchNarraChatMessagesBackstop({
                narraApiEndpoint: narraEndpoint(this.env),
                narraAgentToken: this.env.NARRA_AGENT_TOKEN,
                fetchImpl: this.getConfig().fetchImpl,
            }, roomId, { dir: 'b', limit }).catch(() => ({ events: [] }));
            fetched.push(...backstop.events);
        }
        const byId = new Map();
        for (const h of baseHistory) {
            if (h.eventId && h.text.trim())
                byId.set(h.eventId, h);
        }
        for (const ev of fetched) {
            if (!ev.eventId || !ev.text.trim())
                continue;
            if (ev.kind === 'reaction' || ev.kind === 'edit' || ev.kind === 'redaction')
                continue;
            if (byId.has(ev.eventId))
                continue;
            const isSelf = Boolean(selfMatrixId && ev.senderId === selfMatrixId);
            byId.set(ev.eventId, {
                eventId: ev.eventId,
                senderId: ev.senderId,
                senderName: memberNames.get(ev.senderId) ?? ev.senderName,
                isAgent: isSelf || isNarraAgent(ev.senderId),
                isSelf,
                text: ev.text.slice(0, 600),
                timestampMs: ev.timestampMs,
                ...(ev.replyToEventId ? { replyToEventId: ev.replyToEventId } : {}),
                ...(ev.answersEventId ? { answersEventId: ev.answersEventId } : {}),
                ...(ev.isBroadcast ? { isBroadcast: true } : {}),
            });
        }
        return [...byId.values()]
            .sort((a, b) => a.timestampMs - b.timestampMs)
            .slice(-limit);
    }
    async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path.endsWith('/status')) {
            const meta = (await this.ctx.storage.get('roomMeta')) ?? null;
            const bursts = (await this.ctx.storage.get('bursts')) ?? [];
            const pendingTurns = (await this.ctx.storage.get('pendingTurns')) ?? [];
            const history = (await this.ctx.storage.get('recentHistory')) ?? [];
            const sessions = (await this.ctx.storage.get('sessions')) ?? {};
            const nowMs = this.nowMs();
            const activeSessionCount = Object.values(sessions).filter((s) => s.expiresAtMs >= nowMs).length;
            const logs = (await this.ctx.storage.get('log')) ?? [];
            let roomMuted = false;
            let roomThreshold = null;
            if (isNarraGatewayEnabled(this.env) && this.env.DB && meta?.roomId) {
                try {
                    const mem = await this.getMemoryStore();
                    if (mem) {
                        roomMuted = await mem.isRoomMuted(meta.roomId);
                        roomThreshold = await mem.getRoomThreshold(meta.roomId);
                    }
                }
                catch {
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
                latestEventId: (await this.ctx.storage.get('latestEventId')) ?? null,
                latestHumanEventId: (await this.ctx.storage.get('latestHumanEventId')) ?? null,
                consecutiveAgentMessages: (await this.ctx.storage.get('consecutiveAgentMessages')) ?? 0,
                activeSessionCount,
                roomMuted,
                roomThreshold,
                recentHistoryCount: history.length,
                lastError: (await this.ctx.storage.get('lastError')) ?? null,
                log: logs.map((l) => scrubSecrets(l, this.env)),
            });
        }
        if (request.method === 'GET' && path.endsWith('/history')) {
            if (!isNarraGatewayEnabled(this.env)) {
                return Response.json({ history: [] });
            }
            const history = (await this.ctx.storage.get('recentHistory')) ?? [];
            return Response.json({ history });
        }
        if (request.method === 'POST' && path.endsWith('/agent-sent')) {
            if (!isNarraGatewayEnabled(this.env)) {
                return Response.json({ ok: true, enabled: false });
            }
            const body = (await request.json().catch(() => null));
            if (!body || typeof body.text !== 'string') {
                return Response.json({ ok: false, error: 'bad_payload' }, { status: 400 });
            }
            await this.runLocked(async () => {
                const nowMs = body.timestampMs ?? this.nowMs();
                const spec = await this.getEffectiveSpec();
                const senderId = body.senderId || spec.matrixId || '';
                const eventId = body.eventId || `broadcast:${nowMs}`;
                const history = (await this.ctx.storage.get('recentHistory')) ?? [];
                history.push({
                    eventId,
                    senderId,
                    senderName: spec.name,
                    isAgent: true,
                    isSelf: true,
                    text: body.text.slice(0, 1000),
                    timestampMs: nowMs,
                    ...(body.isBroadcast ? { isBroadcast: true } : {}),
                });
                await this.ctx.storage.put('recentHistory', history.slice(-MAX_RECENT_HISTORY));
                const consec = ((await this.ctx.storage.get('consecutiveAgentMessages')) ?? 0) + 1;
                await this.ctx.storage.put('consecutiveAgentMessages', consec);
                if (eventId)
                    await this.ctx.storage.put('latestEventId', eventId);
                await this.markEventHandled(body.eventId);
            });
            return Response.json({ ok: true });
        }
        if (request.method === 'POST' && path.endsWith('/proactive')) {
            if (!isNarraGatewayEnabled(this.env))
                return Response.json({ ok: true, enabled: false });
            const body = (await request.json().catch(() => null));
            if (!body?.roomId || !body.key || !body.note) {
                return Response.json({ ok: false, error: 'bad_payload' }, { status: 400 });
            }
            await this.runLocked(async () => {
                const nowMs = this.nowMs();
                const meta = await this.ctx.storage.get('roomMeta');
                const pendingTurns = (await this.ctx.storage.get('pendingTurns')) ?? [];
                const eventId = `proactive:${body.key}`;
                if (!pendingTurns.some((t) => t.event.eventId === eventId) && pendingTurns.length < MAX_QUEUE_SIZE) {
                    pendingTurns.push({
                        event: {
                            roomId: body.roomId,
                            chatType: meta?.chatType ?? 'group',
                            ...(meta?.roomName ? { roomName: meta.roomName } : {}),
                            eventId,
                            senderId: '',
                            type: 'm.room.message',
                            kind: 'text',
                            text: body.note.slice(0, 1000),
                            timestampMs: nowMs,
                            timeIso: new Date(nowMs).toISOString(),
                            mentions: [],
                        },
                        attempts: 0,
                        enqueuedAtMs: nowMs,
                        dueAtMs: nowMs,
                        v2Proactive: true,
                    });
                    await this.ctx.storage.put('pendingTurns', pendingTurns);
                }
                await this.scheduleNextAlarm(nowMs);
            });
            return Response.json({ ok: true });
        }
        if (request.method === 'POST' && path.endsWith('/events')) {
            if (!isNarraGatewayEnabled(this.env)) {
                await this.ctx.storage.deleteAlarm();
                return Response.json({ ok: true, enabled: false, ignored: true });
            }
            const payload = (await request.json().catch(() => null));
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
                const existingMeta = await this.ctx.storage.get('roomMeta');
                const roomId = payload.roomId || existingMeta?.roomId || '';
                const chatType = payload.chatType === 'dm' || payload.chatType === 'group'
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
                    });
                }
                const handledList = (await this.ctx.storage.get('handledIds')) ?? [];
                const handledSet = new Set(handledList);
                const redactedList = (await this.ctx.storage.get('redactedIds')) ?? [];
                const redactedSet = new Set(redactedList);
                let history = (await this.ctx.storage.get('recentHistory')) ?? [];
                let ownMessages = (await this.ctx.storage.get('ownMessages')) ?? [];
                const messageCache = (await this.ctx.storage.get('messageCache')) ?? {};
                let latestEventId = await this.ctx.storage.get('latestEventId');
                let latestHumanEventId = await this.ctx.storage.get('latestHumanEventId');
                let consecutiveAgentMessages = (await this.ctx.storage.get('consecutiveAgentMessages')) ?? 0;
                let roomLanguageHint = await this.ctx.storage.get('roomLanguageHint');
                const userLanguageHints = (await this.ctx.storage.get('userLanguageHints')) ?? {};
                const storedBursts = (await this.ctx.storage.get('bursts')) ?? [];
                let pendingTurns = (await this.ctx.storage.get('pendingTurns')) ?? [];
                const coalescer = this.createCoalescer(nowMs, storedBursts);
                const v2State = (await this.ctx.storage.get('v2State')) ?? emptyRoomState();
                let v2Dirty = false;
                let accepted = 0;
                const mentionNames = [
                    effectiveSpec.name,
                    ...(effectiveSpec.aliases ?? []),
                    ...members.flatMap((m) => (m.displayName ? [m.displayName] : [])),
                ].filter((s) => typeof s === 'string' && s.trim().length > 0);
                for (const rawEv of payload.events) {
                    const ev = isNormalizedInboundEvent(rawEv)
                        ? {
                            ...rawEv,
                            roomId: rawEv.roomId || roomId,
                            chatType: payload.chatType === 'dm' || payload.chatType === 'group'
                                ? payload.chatType
                                : (rawEv.chatType ?? chatType),
                            ...(rawEv.roomName || roomName ? { roomName: rawEv.roomName ?? roomName } : {}),
                        }
                        : parseMatrixEvent(rawEv, {
                            roomId,
                            roomName,
                            chatType,
                        });
                    if (!ev)
                        continue;
                    if (handledSet.has(ev.eventId))
                        continue;
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
                        });
                    }
                    if (ev.kind === 'redaction' && ev.redactsEventId) {
                        const targetId = ev.redactsEventId;
                        if (applyClaimRedaction(v2State, targetId, ev.redactionReason))
                            v2Dirty = true;
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
                    if (redactedSet.has(ev.eventId))
                        continue;
                    if (ev.kind === 'edit' && ev.replacesEventId) {
                        const targetId = ev.replacesEventId;
                        const histMatch = history.find((h) => h.eventId === targetId);
                        if (histMatch)
                            histMatch.text = ev.text.slice(0, 1000);
                        const ownMatch = ownMessages.find((o) => o.eventId === targetId);
                        if (ownMatch)
                            ownMatch.text = ev.text.slice(0, 1000);
                        if (messageCache[targetId]) {
                            messageCache[targetId].text = ev.text.slice(0, 1000);
                        }
                        await coalescer.push(ev);
                        for (const turn of pendingTurns) {
                            if (turn.answer !== undefined)
                                continue;
                            const ids = turn.event.coalescedEventIds ?? [turn.event.eventId];
                            if (turn.event.eventId === targetId || ids.includes(targetId)) {
                                turn.event = {
                                    ...turn.event,
                                    text: ev.text,
                                    mentions: ev.mentions.length ? ev.mentions : turn.event.mentions,
                                };
                            }
                        }
                        const editIsAgent = Boolean(selfMatrixId && ev.senderId === selfMatrixId) || isNarraAgent(ev.senderId);
                        if (!editIsAgent) {
                            const langUpdate = detectUpdatedUserLang(ev, effectiveSpec, mentionNames);
                            if (langUpdate) {
                                userLanguageHints[ev.senderId] = langUpdate.lang;
                                if (!langUpdate.isSwitch) {
                                    roomLanguageHint = langUpdate.lang;
                                }
                            }
                        }
                        continue;
                    }
                    if (ev.kind === 'reaction' && applyClaimReaction(v2State, ev, selfMatrixId))
                        v2Dirty = true;
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
                                ...(ev.replyToEventId ? { replyToEventId: ev.replyToEventId } : {}),
                                ...(ev.answersEventId ? { answersEventId: ev.answersEventId } : {}),
                                ...(ev.isBroadcast ? { isBroadcast: true } : {}),
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
                                ...(ev.replyToEventId ? { replyToEventId: ev.replyToEventId } : {}),
                                ...(ev.answersEventId ? { answersEventId: ev.answersEventId } : {}),
                                ...(ev.isBroadcast ? { isBroadcast: true } : {}),
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
                            ...(ev.replyToEventId ? { replyToEventId: ev.replyToEventId } : {}),
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
                        const langUpdate = detectUpdatedUserLang(ev, effectiveSpec, mentionNames);
                        if (langUpdate) {
                            userLanguageHints[ev.senderId] = langUpdate.lang;
                            if (!langUpdate.isSwitch) {
                                roomLanguageHint = langUpdate.lang;
                            }
                        }
                    }
                    const pushed = await coalescer.push(ev);
                    const readyTarget = pushed.status === 'flushed' || pushed.status === 'bypass'
                        ? pushed.event
                        : pushed.status === 'buffered'
                            ? pushed.flushedPrior
                            : undefined;
                    if (readyTarget) {
                        const alreadyQueued = pendingTurns.some((t) => t.event.eventId === readyTarget.eventId);
                        if (!alreadyQueued && pendingTurns.length < MAX_QUEUE_SIZE) {
                            pendingTurns.push({
                                event: readyTarget,
                                attempts: 0,
                                enqueuedAtMs: nowMs,
                                dueAtMs: nowMs,
                            });
                        }
                    }
                }
                if (v2Dirty) {
                    pruneClaims(v2State, nowMs);
                    await this.ctx.storage.put('v2State', v2State);
                }
                await this.ctx.storage.put('handledIds', handledList.slice(-MAX_HANDLED_IDS));
                await this.ctx.storage.put('redactedIds', redactedList.slice(-MAX_REDACTED_IDS));
                await this.ctx.storage.put('recentHistory', history.slice(-MAX_RECENT_HISTORY));
                await this.ctx.storage.put('ownMessages', ownMessages.slice(-MAX_OWN_MESSAGES));
                await this.trimAndPutMessageCache(messageCache);
                if (latestEventId !== undefined)
                    await this.ctx.storage.put('latestEventId', latestEventId);
                else
                    await this.ctx.storage.delete('latestEventId');
                if (latestHumanEventId !== undefined) {
                    await this.ctx.storage.put('latestHumanEventId', latestHumanEventId);
                }
                else {
                    await this.ctx.storage.delete('latestHumanEventId');
                }
                await this.ctx.storage.put('consecutiveAgentMessages', consecutiveAgentMessages);
                if (roomLanguageHint)
                    await this.ctx.storage.put('roomLanguageHint', roomLanguageHint);
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
    async isTurnRedacted(turn) {
        const redactedSet = new Set((await this.ctx.storage.get('redactedIds')) ?? []);
        const ids = turn.event.coalescedEventIds ?? [turn.event.eventId];
        return redactedSet.has(turn.event.eventId) || ids.every((id) => redactedSet.has(id));
    }
    async removePendingTurn(eventId) {
        await this.runLocked(async () => {
            const current = (await this.ctx.storage.get('pendingTurns')) ?? [];
            const filtered = current.filter((t) => t.event.eventId !== eventId);
            await this.ctx.storage.put('pendingTurns', filtered);
        });
    }
    async updatePendingTurn(updated) {
        await this.runLocked(async () => {
            const current = (await this.ctx.storage.get('pendingTurns')) ?? [];
            const idx = current.findIndex((t) => t.event.eventId === updated.event.eventId);
            if (idx >= 0) {
                current[idx] = updated;
                await this.ctx.storage.put('pendingTurns', current);
            }
        });
    }
    async clearUserSession(senderId) {
        if (!senderId)
            return;
        await this.runLocked(async () => {
            const sessions = (await this.ctx.storage.get('sessions')) ?? {};
            if (Object.prototype.hasOwnProperty.call(sessions, senderId)) {
                delete sessions[senderId];
                await this.ctx.storage.put('sessions', sessions);
            }
        });
    }
    /**
     * Due fallback turn: answer only if no agent has replied since the question and nothing makes it
     * moot (stale, muted room, aimed at someone, chain cap).
     */
    async resolveGroupFallback(turn, context, spec, nowMs) {
        const routed = await routeEvent(turn.event, context, spec, { nowMs, chainCap: AGENT_CHAIN_CAP });
        const moot = new Set([
            'sender_is_self',
            'sender_is_agent',
            'redaction',
            'stale_group_message',
            'aimed_elsewhere',
            'room_muted',
            'peer_already_replied',
            'chain_cap_exhausted',
        ]);
        if (moot.has(routed.reason))
            return { ...routed, shouldReply: false, reason: `fallback_moot:${routed.reason}` };
        const storedHistory = (await this.ctx.storage.get('recentHistory')) ?? [];
        const seen = new Set(storedHistory.map((t) => t.eventId));
        const timeline = [...storedHistory, ...context.recentHistory.filter((t) => !seen.has(t.eventId))];
        if (peerSessionWithSender(turn.event, timeline, spec.matrixId)) {
            return { ...routed, shouldReply: false, reason: 'fallback_moot:peer_session' };
        }
        if (await this.hasLivePeerRepliedAfter(turn.event, context, spec.matrixId)) {
            return { ...routed, shouldReply: false, reason: 'fallback_not_needed' };
        }
        return {
            shouldReply: true,
            tier: 1,
            reason: 'group_fallback',
            confidence: 0.5,
            detectedLang: routed.detectedLang,
            shouldQuote: true,
            isAsk: true,
        };
    }
    async tryFastRespond(cfg, event, decision, memories, context) {
        if (!cfg.fastRespond)
            return null;
        try {
            const fast = await cfg.fastRespond(this.env, event, decision, memories, context);
            return fast && !isSilence(fast) ? fast : null;
        }
        catch {
            return null;
        }
    }
    async hasLivePeerRepliedAfter(event, baseContext, selfMatrixId) {
        const localHistory = (await this.ctx.storage.get('recentHistory')) ?? [];
        if (hasPeerRepliedAfter(event, { ...baseContext, recentHistory: localHistory }, selfMatrixId)) {
            return true;
        }
        if (!isNarraSyncEnabled(this.env)) {
            return false;
        }
        const filterTimeline = (events) => events.filter((ev) => ev.kind !== 'reaction' && ev.kind !== 'edit' && ev.kind !== 'redaction');
        if (this.env.NARRA_SYNC_DO) {
            try {
                const mat = await this.matrixOp({
                    op: 'recentMessages',
                    roomId: event.roomId,
                    limit: 8,
                });
                if (mat.ok &&
                    Array.isArray(mat.events) &&
                    hasPeerAnsweredTimeline(event, filterTimeline(mat.events), selfMatrixId)) {
                    return true;
                }
            }
            catch {
                // Fall through cleanly to Narra chat/messages backstop.
            }
        }
        if ((this.env.NARRA_AGENT_TOKEN ?? '').trim()) {
            try {
                const backstop = await fetchNarraChatMessagesBackstop({
                    narraApiEndpoint: narraEndpoint(this.env),
                    narraAgentToken: this.env.NARRA_AGENT_TOKEN,
                    fetchImpl: this.getConfig().fetchImpl,
                }, event.roomId, { dir: 'b', limit: 8 });
                if (hasPeerAnsweredTimeline(event, filterTimeline(backstop.events), selfMatrixId)) {
                    return true;
                }
            }
            catch {
                // Non-fatal: ignore transient 404/network errors on backstop check.
            }
        }
        return false;
    }
    // ---------------------------------------------------------------------------------------------
    // Chat-native (v2) pipeline. The Worker is the agent's ears and hands: it decides cheaply whether
    // the Manyfold brain should look at a message, claims it with 👀 so other agents step back, hands
    // the brain a compact picture of the room, and carries out what the brain decides (reply, react,
    // stay silent, change how often it speaks). The brain decides what is said.
    // ---------------------------------------------------------------------------------------------
    v2Mode(state, context) {
        if (state.mode)
            return state.mode;
        if (context.roomMuted)
            return 'quiet';
        const raw = (this.env.NARRA_V2_DEFAULT_MODE ?? '').trim().toLowerCase();
        return raw === 'mention' || raw === 'quiet' ? raw : 'ambient';
    }
    v2Budget(spec) {
        return new UsageBudget(this.env.DB, spec.id);
    }
    async v2Gate(event, context, spec, mode, nowMs) {
        const cfg = this.getConfig();
        const budget = this.v2Budget(spec);
        const limit = parseLimit(this.env.NARRA_DAILY_RELEVANCE_LIMIT, DEFAULT_DAILY_RELEVANCE_LIMIT);
        const budgetExhausted = await budget.relevanceExhausted(nowMs, limit);
        let relevance;
        const threshold = Number(this.env.NARRA_WAKE_THRESHOLD);
        const decision = await decideWake({
            event,
            context,
            spec,
            mode,
            nowMs,
            budgetExhausted,
            options: {
                ...(cfg.v2?.gate ?? {}),
                ...(cfg.v2?.reactionsToSelf?.length ? { reactionsToSelf: cfg.v2.reactionsToSelf } : {}),
                ...(Number.isFinite(threshold) && (this.env.NARRA_WAKE_THRESHOLD ?? '').trim() !== '' ? { threshold } : {}),
            },
            score: async () => {
                const mentionNames = [spec.name, ...(spec.aliases ?? []), ...context.members.flatMap((m) => (m.displayName ? [m.displayName] : []))];
                relevance = await scoreRelevance(stripAgentMentions(event.text ?? '', mentionNames), spec, cfg.v2?.wakeExamples ?? [], {
                    ai: this.env.AI,
                    ...(this.env.NARRA_EMBEDDING_MODEL ? { model: this.env.NARRA_EMBEDDING_MODEL } : {}),
                    ...(cfg.v2?.profile ? { profile: cfg.v2.profile } : {}),
                    ...(cfg.v2?.notExamples?.length ? { notExamples: cfg.v2.notExamples } : {}),
                    cache: {
                        get: (key) => this.ctx.storage.get(key),
                        put: (key, value) => this.ctx.storage.put(key, value),
                    },
                }, { event, context });
                if (relevance.source === 'embedding')
                    await budget.add('relevance', nowMs);
                return {
                    score: relevance.score,
                    ...(relevance.rawScore !== undefined ? { rawScore: relevance.rawScore } : {}),
                    ...(relevance.margin !== undefined ? { margin: relevance.margin } : {}),
                    notMine: relevance.notCosine !== undefined && relevance.cosine !== undefined && relevance.notCosine > relevance.cosine,
                    mine: relevance.notCosine !== undefined && relevance.cosine !== undefined && relevance.cosine > relevance.notCosine,
                };
            },
        });
        return { decision, ...(relevance ? { relevance } : {}) };
    }
    /** Ask check: true/false from the ask model, undefined when it is unavailable (fail open). */
    async v2AskCheck(event, context, spec) {
        if (this.getConfig().v2?.standbyAskCheck === false)
            return undefined;
        try {
            const model = createAskTriageModel(this.env.AI, { ...(this.env.AI_TRIAGE_MODEL ? { model: this.env.AI_TRIAGE_MODEL } : {}) });
            const res = await model.score({ event, context, spec, detectedLang: detectLang(event.text ?? "", context.userLanguageHint, context.roomLanguageHint) });
            return res.ask;
        }
        catch {
            return undefined;
        }
    }
    /** In a group, only an addressed agent or the conversation's owner reacts with an emoji. */
    mayReactInGroup(context, decision) {
        if (context.chatType !== 'group' || decision.direct)
            return true;
        return decision.reason === 'your_conversation' || decision.reason === 'answers_your_question' || decision.reason === 'reaction_to_you';
    }
    describeGate(decision, relevance) {
        const parts = [`wake=${decision.wake}`, decision.reason];
        if (decision.score !== undefined)
            parts.push(`score=${decision.score.toFixed(2)}`);
        if (relevance?.cosine !== undefined)
            parts.push(`cos=${relevance.cosine}`);
        if (relevance?.notCosine !== undefined)
            parts.push(`not=${relevance.notCosine}`);
        if (relevance)
            parts.push(`via=${relevance.source}`);
        if (decision.delayMs)
            parts.push(`delay=${decision.delayMs}`);
        return parts.join(' ');
    }
    /** Shadow mode: log what v2 would do with this turn, next to v1's decision. No brain call. */
    async logShadowV2(turn, context, spec, v1Decision) {
        const state = (await this.ctx.storage.get('v2State')) ?? emptyRoomState();
        const nowMs = this.nowMs();
        const { decision, relevance } = await this.v2Gate(turn.event, context, spec, this.v2Mode(state, context), nowMs);
        await appendDoLog(this.ctx.storage, `v2-shadow ${turn.event.eventId}: ${this.describeGate(decision, relevance)} | v1 reply=${v1Decision.shouldReply} ${v1Decision.reason}`, nowMs, this.env);
    }
    /** Another agent answered one of these messages, judged from the latest stored history. */
    async peerAnsweredNow(eventIds, selfId, pointsHere) {
        const history = (await this.ctx.storage.get('recentHistory')) ?? [];
        return peerAnswered(history, eventIds, selfId, pointsHere);
    }
    /**
     * After a text answer the 👀 stays on the message, so people can see who took it. Only a turn
     * that ends without an answer (silent, failed, yielded) removes it, so the next agent can go on.
     */
    /**
     * The visible 👀 for an unaddressed group answer, posted only once this agent is actually answering
     * (people read it as "this agent took it"). It carries a top priority so peers treat it as a claim.
     */
    async showAnsweringEyes(turn, decision, context) {
        if (decision.direct || context.chatType !== 'group' || turn.v2EyesEventId)
            return;
        const res = await this.matrixOp({
            op: 'react',
            roomId: turn.event.roomId,
            eventId: turn.event.eventId,
            key: CLAIM_REACTION,
            txnId: await deterministicTxnId(`eyes:${turn.event.eventId}`),
            extra: { 'ai.narra.claim': { priority_milli: 5000, reason: 'answering' } },
        }).catch(() => null);
        if (res?.ok && res.eventId)
            turn.v2EyesEventId = res.eventId;
    }
    keepV2Claim(turn) {
        turn.v2ClaimEventId = undefined;
    }
    async releaseV2Claim(turn, reason) {
        if (!turn.v2ClaimEventId)
            return;
        const claimId = turn.v2ClaimEventId;
        turn.v2ClaimEventId = undefined;
        turn.v2ClaimAtMs = undefined;
        await this.matrixOp({
            op: 'redact',
            roomId: turn.event.roomId,
            eventId: claimId,
            txnId: await deterministicTxnId(`unclaim:${claimId}`),
            ...(reason ? { reason } : {}),
        }).catch(() => undefined);
    }
    /** A peer holding a stronger live claim on this message than this agent's own claim, if any. */
    async outrankedNow(turn, decision, eventIds, selfId) {
        if (decision.direct || !decision.claim || !turn.v2ClaimEventId)
            return undefined;
        const state = (await this.ctx.storage.get('v2State')) ?? emptyRoomState();
        return peerClaimHolder(state, eventIds, selfId, this.nowMs(), claimPriority(decision), turn.v2ClaimAtMs ?? this.nowMs());
    }
    async recordOwnReply(turn, spec, text, eventId, replyToEventId, isBroadcast = false) {
        const at = this.nowMs();
        await this.runLocked(async () => {
            const postedId = eventId || `sent:${turn.event.eventId}`;
            const ownMessages = (await this.ctx.storage.get('ownMessages')) ?? [];
            ownMessages.push({ eventId: postedId, text: text.slice(0, 1000), timestampMs: at });
            await this.ctx.storage.put('ownMessages', ownMessages.slice(-MAX_OWN_MESSAGES));
            const history = (await this.ctx.storage.get('recentHistory')) ?? [];
            history.push({
                eventId: postedId,
                senderId: spec.matrixId ?? '',
                senderName: spec.name,
                isAgent: true,
                isSelf: true,
                text: text.slice(0, 1000),
                timestampMs: at,
                ...(isBroadcast ? { isBroadcast: true } : { answersEventId: turn.event.eventId }),
                ...(replyToEventId ? { replyToEventId } : {}),
            });
            await this.ctx.storage.put('recentHistory', history.slice(-MAX_RECENT_HISTORY));
            const consec = ((await this.ctx.storage.get('consecutiveAgentMessages')) ?? 0) + 1;
            await this.ctx.storage.put('consecutiveAgentMessages', consec);
            if (eventId) {
                await this.ctx.storage.put('latestEventId', eventId);
                await this.markEventHandled(eventId);
            }
        });
    }
    async runTurnV2(turn, spec, memoryStore) {
        const cfg = this.getConfig();
        const roomId = turn.event.roomId;
        const eventIds = turn.event.coalescedEventIds ?? [turn.event.eventId];
        let nowMs = this.nowMs();
        const context = await this.buildRoomContextForTurn(turn, spec, memoryStore, nowMs);
        const state = (await this.ctx.storage.get('v2State')) ?? emptyRoomState();
        const mode = this.v2Mode(state, context);
        let decision = turn.v2Decision;
        if (turn.v2Proactive && !decision) {
            decision = { wake: true, reason: 'proactive', delayMs: 0, claim: false, direct: false };
            turn.v2Decision = decision;
        }
        const mentionNamesForLang = [spec.name, ...(spec.aliases ?? []), ...context.members.flatMap((m) => (m.displayName ? [m.displayName] : []))];
        const replyLangForHooks = replyLanguageFor(turn.event.text ?? '', {
            mentionNames: mentionNamesForLang,
            ...(context.userLanguageHint ? { userHint: context.userLanguageHint } : {}),
            ...(context.roomLanguageHint ? { roomHint: context.roomLanguageHint } : {}),
        });
        // Crisis first: before relevance, so it is never skipped because the message looked unrelated.
        const fromHuman = !turn.v2Proactive &&
            turn.event.senderId !== spec.matrixId &&
            !isNarraAgent(turn.event.senderId) &&
            (turn.event.kind === 'text' || turn.event.kind === 'voice' || turn.event.kind === 'compound');
        if (!decision && fromHuman && cfg.v2?.crisisReply && turn.v2CrisisText !== '') {
            const addressed = context.chatType === 'dm' || isSelfMentioned(turn.event, spec) || Boolean(context.replyToTarget?.isSelf);
            let crisis = turn.v2CrisisText;
            if (crisis === undefined) {
                crisis =
                    (await Promise.resolve(cfg.v2.crisisReply(this.env, turn.event, context, { replyLang: replyLangForHooks })).catch(() => null)) ?? '';
                if (crisis && !addressed) {
                    // Several agents may know crisis resources: wait a different short time, first one answers.
                    // Every agent computes the same order of the room's agents for this message, so the
                    // first crisis-capable agent in that order answers and the others see it and yield.
                    const rank = spec.matrixId ? groupFallbackRank(turn.event.eventId, spec.matrixId, context.members) : -1;
                    const wait = rank >= 0
                        ? 300 + rank * V2_CRISIS_STEP_MS
                        : 300 + Math.round(hashFraction(`crisis:${turn.event.eventId}:${spec.id}`) * 3_000);
                    await this.updatePendingTurn({ ...turn, v2CrisisText: crisis, dueAtMs: nowMs + wait });
                    return;
                }
            }
            if (crisis) {
                const peer = addressed ? undefined : peerAnswered(context.recentHistory, eventIds, spec.matrixId);
                if (peer) {
                    await appendDoLog(this.ctx.storage, `v2 crisis yield ${turn.event.eventId}: answered by ${peer}`, nowMs, this.env);
                    await this.removePendingTurn(turn.event.eventId);
                    return;
                }
                const quote = context.chatType === 'group' ? await this.computeShouldQuote(turn.event, context.chatType) : false;
                const replyTo = quote ? turn.event.eventId : undefined;
                const posted = await this.postReplyToRoom(roomId, crisis, `crisis:${turn.event.eventId}`, spec.matrixId, replyTo, turn.event.eventId);
                await this.recordOwnReply(turn, spec, crisis, posted.eventId, replyTo);
                await appendDoLog(this.ctx.storage, `v2 crisis reply ${turn.event.eventId}`, this.nowMs(), this.env);
                await this.removePendingTurn(turn.event.eventId);
                return;
            }
            turn.v2CrisisText = '';
        }
        if (!decision && fromHuman && cfg.v2?.wakeHint) {
            const hint = await Promise.resolve(cfg.v2.wakeHint(this.env, turn.event, context)).catch(() => null);
            if (hint === 'skip') {
                await appendDoLog(this.ctx.storage, `v2 gate ${turn.event.eventId}: wake=false agent_hint`, nowMs, this.env);
                await this.removePendingTurn(turn.event.eventId);
                return;
            }
            if (hint === 'wake') {
                // A hint is the agent's own guess ("might be an answer to my question"), not a claim on the
                // message: it looks without a 👀, so agents that fit better are never blocked by it.
                decision = { wake: true, reason: 'agent_hint', delayMs: 0, claim: false, direct: false };
                turn.v2Decision = decision;
                await appendDoLog(this.ctx.storage, `v2 gate ${turn.event.eventId}: wake=true agent_hint`, nowMs, this.env);
            }
        }
        if (!decision) {
            const gated = await this.v2Gate(turn.event, context, spec, mode, nowMs);
            decision = gated.decision;
            await appendDoLog(this.ctx.storage, `v2 gate ${turn.event.eventId}: ${this.describeGate(decision, gated.relevance)}`, nowMs, this.env);
            if (!decision.wake) {
                await this.removePendingTurn(turn.event.eventId);
                return;
            }
            if (decision.delayMs > 0) {
                // Let better-fitting agents claim first; come back without blocking the room's queue.
                await this.updatePendingTurn({ ...turn, v2Decision: decision, dueAtMs: nowMs + decision.delayMs });
                return;
            }
            turn.v2Decision = decision;
        }
        if (!decision.direct && !turn.v2ClaimEventId) {
            const pointsHere = (text) => isSelfMentioned({ ...turn.event, text, mentions: [] }, spec);
            const handedBy = decision.reason === 'handoff' ? undefined : peerHandoff(context.recentHistory, eventIds, spec.matrixId, pointsHere);
            if (handedBy) {
                // The agent that answered pointed here ("@X knows this better"): that is not an answer.
                decision = { wake: true, reason: 'handoff', delayMs: 0, claim: true, direct: false, ...(decision.score !== undefined ? { score: decision.score } : {}) };
                turn.v2Decision = decision;
                await appendDoLog(this.ctx.storage, `v2 handoff ${turn.event.eventId}: ${handedBy} pointed here`, nowMs, this.env);
            }
            const answeredBy = peerAnswered(context.recentHistory, eventIds, spec.matrixId, pointsHere);
            if (answeredBy) {
                await appendDoLog(this.ctx.storage, `v2 yield ${turn.event.eventId}: answered by ${answeredBy}`, nowMs, this.env);
                await this.removePendingTurn(turn.event.eventId);
                return;
            }
            // Only a claim at least as strong holds this agent back: a weak fit that reacted first (events
            // reach Workers seconds apart) must not make the best fit wait for it.
            const holder = peerClaimHolder(state, eventIds, spec.matrixId, nowMs, claimPriority(decision));
            if (holder) {
                // A 👀 is an intent, not an answer: the holder may still stay silent, fail or time out.
                // Wait for the outcome; give up only once a peer actually answered (checked above).
                if (turn.v2WaitingOn !== holder) {
                    await appendDoLog(this.ctx.storage, `v2 wait ${turn.event.eventId}: claimed by ${holder}`, nowMs, this.env);
                }
                await this.updatePendingTurn({ ...turn, v2Decision: decision, v2WaitingOn: holder, dueAtMs: nowMs + V2_CLAIM_RECHECK_MS });
                return;
            }
            if (turn.v2WaitingOn) {
                await appendDoLog(this.ctx.storage, `v2 resume ${turn.event.eventId}: ${turn.v2WaitingOn} released it`, nowMs, this.env);
                turn.v2WaitingOn = undefined;
            }
        }
        if (decision.askCheck && context.chatType === 'group' && !turn.v2ClaimEventId && turn.v2AskVerdict === undefined) {
            // Chatter sits equally close to every agent: without this, each would claim and call its brain
            // just to stay silent. A real ask that fits two agents passes and the better claim answers.
            const ask = await this.v2AskCheck(turn.event, context, spec);
            await appendDoLog(this.ctx.storage, `v2 ask check ${turn.event.eventId}: ${ask === undefined ? 'unknown' : ask}`, nowMs, this.env);
            if (ask === false) {
                await appendDoLog(this.ctx.storage, `v2 skipped ${turn.event.eventId}: not an ask`, nowMs, this.env);
                await this.removePendingTurn(turn.event.eventId);
                return;
            }
            turn.v2AskVerdict = ask ?? true;
            await this.updatePendingTurn({ ...turn, v2Decision: decision });
        }
        try {
            if (decision.claim && context.chatType === 'group' && !turn.v2ClaimEventId) {
                const count = turn.v2ClaimCount ?? 0;
                const txnId = await deterministicTxnId(count ? `claim:${turn.event.eventId}:${count}` : `claim:${turn.event.eventId}`);
                // Integers only: Synapse refuses an event with a float anywhere in it (canonical JSON).
                const priorityMilli = Math.round(claimPriority(decision) * 1000);
                // Addressed: a visible 👀 at once (it always answers). Otherwise the claim is a hidden room event
                // until this agent actually answers, so people never see a 👀 that is taken back.
                const claim = decision.direct
                    ? await this.matrixOp({
                        op: 'react',
                        roomId,
                        eventId: turn.event.eventId,
                        key: CLAIM_REACTION,
                        txnId,
                        extra: { 'ai.narra.claim': { priority_milli: priorityMilli, reason: decision.reason } },
                    })
                    : await this.matrixOp({ op: 'claim', roomId, eventId: turn.event.eventId, priorityMilli, reason: decision.reason, txnId });
                if (claim.ok && claim.eventId) {
                    turn.v2ClaimEventId = claim.eventId;
                    turn.v2ClaimAtMs = this.nowMs();
                    turn.v2ClaimCount = count + 1;
                    await this.updatePendingTurn(turn);
                }
            }
            const safety = cfg.v2?.safetyReply
                ? await Promise.resolve(cfg.v2.safetyReply(this.env, turn.event, context, { replyLang: replyLangForHooks })).catch(() => null)
                : null;
            if (safety) {
                const posted = await this.postReplyToRoom(roomId, safety, turn.event.eventId, spec.matrixId, undefined, turn.event.eventId);
                await this.recordOwnReply(turn, spec, safety, posted.eventId);
                this.keepV2Claim(turn);
                await appendDoLog(this.ctx.storage, `v2 safety reply ${turn.event.eventId}`, this.nowMs(), this.env);
                await this.removePendingTurn(turn.event.eventId);
                return;
            }
            void this.matrixOp({ op: 'typing', roomId, typing: true }).catch(() => undefined);
            const typingTimer = setInterval(() => {
                void this.matrixOp({ op: 'typing', roomId, typing: true }).catch(() => undefined);
            }, TYPING_REFRESH_MS);
            let raw = '';
            // Reply in the asker's language: zh-Hant, zh-Hans or English; anything else in English.
            const replyLang = replyLanguageFor(turn.event.text ?? '', {
                mentionNames: [spec.name, ...(spec.aliases ?? []), ...context.members.flatMap((m) => (m.displayName ? [m.displayName] : []))],
                ...(context.userLanguageHint ? { userHint: context.userLanguageHint } : {}),
                ...(context.roomLanguageHint ? { roomHint: context.roomLanguageHint } : {}),
            });
            const streamLang = replyLang;
            const stream = {
                suppressed: Boolean(turn.v2Proactive),
                shown: '',
                lastAt: 0,
                edits: 0,
                replyToEventId: undefined,
                chain: Promise.resolve(),
            };
            const continuity = newStreamContinuity();
            const onText = (partial) => {
                if (!continuousStreamText(continuity, partial, Boolean(stream.shown)))
                    return;
                const candidate = streamableText(partial);
                if (!candidate)
                    return;
                const display = matchScript(normalizeA2AOutput(candidate, streamLang).text, streamLang);
                if (!display)
                    return;
                const at = this.nowMs();
                if (!shouldFlushStream({ shown: stream.shown, next: display, msSinceLastFlush: at - stream.lastAt }))
                    return;
                stream.shown = display;
                stream.lastAt = at;
                stream.chain = stream.chain
                    .then(async () => {
                    if (stream.suppressed)
                        return;
                    if (!turn.v2StreamEventId) {
                        if (!decision.direct && (await this.peerAnsweredNow(eventIds, spec.matrixId))) {
                            stream.suppressed = true;
                            return;
                        }
                        if (await this.outrankedNow(turn, decision, eventIds, spec.matrixId)) {
                            stream.suppressed = true;
                            return;
                        }
                        const quote = await this.computeShouldQuote(turn.event, context.chatType);
                        stream.replyToEventId = quote ? turn.event.eventId : undefined;
                        await this.showAnsweringEyes(turn, decision, context);
                        const posted = await this.postReplyToRoom(roomId, display, turn.event.eventId, spec.matrixId, stream.replyToEventId, turn.event.eventId);
                        if (posted.eventId) {
                            turn.v2StreamEventId = posted.eventId;
                            await this.updatePendingTurn(turn);
                        }
                    }
                    else {
                        stream.edits++;
                        await this.editReplyInRoom(roomId, turn.v2StreamEventId, display, `stream:${turn.event.eventId}:${stream.edits}`, spec.matrixId);
                    }
                })
                    .catch(() => undefined);
            };
            try {
                const memories = memoryStore
                    ? await memoryStore.recallForTurn({ roomId, userId: turn.event.senderId, chatType: context.chatType })
                    : emptyMemories();
                const lang = replyLang;
                const triageLike = {
                    shouldReply: true,
                    tier: decision.direct ? 0 : 1,
                    reason: decision.direct
                        ? decision.reason === 'reply_to_you'
                            ? 'reply_to_self'
                            : decision.reason === 'dm'
                                ? 'dm'
                                : 'explicit_mention'
                        : `v2_${decision.reason}`,
                    confidence: decision.score ?? 1,
                    detectedLang: lang,
                    shouldQuote: false,
                };
                const [cred, extraFields, storedContextId] = await Promise.all([
                    Promise.resolve(cfg.resolveA2ACredential?.(this.env) ?? defaultResolveA2ACredential(this.env, spec)),
                    cfg.buildExtraEnvelopeFields
                        ? cfg.buildExtraEnvelopeFields(this.env, turn.event, triageLike, memories, context, { pipeline: 'v2' }).catch(() => undefined)
                        : Promise.resolve(undefined),
                    cfg.v2?.freshContext ? Promise.resolve(undefined) : this.ctx.storage.get('a2aContextId').catch(() => undefined),
                ]);
                if (!cred || !cred.url || !cred.token)
                    throw new A2AError('No A2A credential available for Narra gateway.', false);
                const envelope = buildPromptEnvelope({
                    event: turn.event,
                    context,
                    decision: triageLike,
                    memories,
                    spec,
                    extraFields: {
                        ...(extraFields ?? {}),
                        ...buildLedgerSummary({
                            history: context.recentHistory,
                            members: context.members,
                            selfId: spec.matrixId,
                            event: turn.event,
                            nowMs: this.nowMs(),
                            mode,
                            wakeReason: decision.reason,
                        }),
                        ...(turn.event.kind !== 'text' ? { message_type: turn.event.kind } : {}),
                        ...(turn.event.mediaUrl ? { media_url: turn.event.mediaUrl } : {}),
                        ...(decision.reason === 'reaction_to_you' && context.replyToTarget
                            ? { reacted_to_you: `${turn.event.reactionKey ?? turn.event.text} on your message: "${context.replyToTarget.text.replace(/\s+/g, ' ').slice(0, 300)}" (untrusted)` }
                            : {}),
                        chat_behaviour: chatBehaviourNote({
                            chatType: context.chatType,
                            direct: decision.direct,
                            handoff: decision.reason === 'handoff',
                            proactive: Boolean(turn.v2Proactive),
                            replyLanguage: languageName(replyLang),
                        }),
                    },
                });
                const res = await runManyfoldA2ATurnWithMeta({
                    credential: { rpcUrl: cred.url, token: cred.token, label: cred.label ?? spec.name },
                    envelope,
                    eventId: turn.event.eventId,
                    ...(storedContextId ? { contextId: storedContextId } : {}),
                    timeoutMs: cfg.v2?.brainTimeoutMs ?? 25_000,
                    fetchImpl: cfg.fetchImpl,
                    onText,
                });
                await stream.chain;
                await this.v2Budget(spec).add('brain', this.nowMs());
                raw = res.text;
                if (!cfg.v2?.freshContext && res.contextId && res.contextId !== storedContextId) {
                    await this.ctx.storage.put('a2aContextId', res.contextId).catch(() => undefined);
                }
            }
            finally {
                clearInterval(typingTimer);
                await this.matrixOp({ op: 'typing', roomId, typing: false }).catch(() => undefined);
            }
            let action = parseBrainOutput(raw);
            nowMs = this.nowMs();
            if (action.kind === 'reply' &&
                !action.mode &&
                context.chatType === 'group' &&
                !decision.direct &&
                decision.reason === 'your_conversation') {
                // Thanks, "ok" or a laugh to the agent the person was just talking with: an emoji, never text.
                // Some brains' own instructions insist on a polite line, so the room rule is enforced here.
                const ask = await this.v2AskCheck(turn.event, context, spec);
                if (ask === false) {
                    action = { kind: 'react', emoji: '👍' };
                    await appendDoLog(this.ctx.storage, `v2 acknowledgement ${turn.event.eventId}: text turned into an emoji`, this.nowMs(), this.env);
                }
            }
            if (action.kind !== 'reply' && turn.v2StreamEventId) {
                // Text was already showing but the brain ended up choosing not to reply: take it back.
                await this.matrixOp({
                    op: 'redact',
                    roomId,
                    eventId: turn.v2StreamEventId,
                    txnId: await deterministicTxnId(`unstream:${turn.v2StreamEventId}`),
                }).catch(() => undefined);
                turn.v2StreamEventId = undefined;
                if (turn.v2EyesEventId) {
                    await this.matrixOp({
                        op: 'redact',
                        roomId,
                        eventId: turn.v2EyesEventId,
                        txnId: await deterministicTxnId(`uneyes:${turn.v2EyesEventId}`),
                    }).catch(() => undefined);
                    turn.v2EyesEventId = undefined;
                }
            }
            if (action.kind === 'silent') {
                await this.releaseV2Claim(turn);
                await appendDoLog(this.ctx.storage, `v2 silent ${turn.event.eventId} (${decision.reason})`, nowMs, this.env);
                await this.removePendingTurn(turn.event.eventId);
                return;
            }
            if (action.kind === 'react' && !this.mayReactInGroup(context, decision)) {
                // An emoji on chatter or thanks belongs to the agent the person was talking with (or one they
                // addressed). From any other agent it reads as a stranger butting in.
                await this.releaseV2Claim(turn);
                await appendDoLog(this.ctx.storage, `v2 silent ${turn.event.eventId} (${decision.reason}, reaction not ours)`, nowMs, this.env);
                await this.removePendingTurn(turn.event.eventId);
                return;
            }
            if (action.kind === 'react') {
                await this.matrixOp({
                    op: 'react',
                    roomId,
                    eventId: turn.event.eventId,
                    key: action.emoji,
                    txnId: await deterministicTxnId(`react:${turn.event.eventId}:${action.emoji}`),
                });
                await this.releaseV2Claim(turn);
                await appendDoLog(this.ctx.storage, `v2 reacted ${turn.event.eventId} ${action.emoji}`, nowMs, this.env);
                await this.removePendingTurn(turn.event.eventId);
                return;
            }
            if (action.mode) {
                await this.runLocked(async () => {
                    const latest = (await this.ctx.storage.get('v2State')) ?? emptyRoomState();
                    latest.mode = action.mode;
                    await this.ctx.storage.put('v2State', latest);
                });
            }
            const text = matchScript(normalizeA2AOutput(action.text, replyLang).text, replyLang);
            if (!text) {
                await this.releaseV2Claim(turn);
                await this.removePendingTurn(turn.event.eventId);
                return;
            }
            // While the brain was writing, another agent may have answered (e.g. a crisis reply). Unless
            // this agent was addressed directly, a second answer to the same message is noise.
            if (!decision.direct && !turn.v2StreamEventId) {
                const peer = await this.peerAnsweredNow(eventIds, spec.matrixId, (t) => isSelfMentioned({ ...turn.event, text: t, mentions: [] }, spec));
                if (peer) {
                    await this.releaseV2Claim(turn);
                    await appendDoLog(this.ctx.storage, `v2 yield_after_brain ${turn.event.eventId}: answered by ${peer}`, this.nowMs(), this.env);
                    await this.removePendingTurn(turn.event.eventId);
                    return;
                }
                // A better-fitting agent claimed while this brain was working: it answers, this one steps back.
                const stronger = await this.outrankedNow(turn, decision, eventIds, spec.matrixId);
                if (stronger) {
                    // Stepping back for a better fit is not "chose not to answer".
                    await this.releaseV2Claim(turn, CLAIM_RETRY_REASON);
                    await appendDoLog(this.ctx.storage, `v2 outranked ${turn.event.eventId}: ${stronger} fits better`, this.nowMs(), this.env);
                    await this.removePendingTurn(turn.event.eventId);
                    return;
                }
            }
            if (turn.v2Proactive) {
                const sent = await this.matrixOp({
                    op: 'send',
                    roomId,
                    txnId: await deterministicTxnId(`proactive:${spec.id}:${turn.event.eventId}`),
                    content: messageContent(text, { selfMatrixId: spec.matrixId, broadcast: true }),
                });
                if (!sent.ok)
                    throw makeSendFailure(`Proactive send failed: HTTP ${sent.status}`, sent.status, { errcode: sent.errcode, narraCode: sent.narraCode });
                await this.recordOwnReply(turn, spec, text, sent.eventId ?? '', undefined, true);
                await appendDoLog(this.ctx.storage, `v2 proactive posted ${turn.event.eventId}`, this.nowMs(), this.env);
                await this.removePendingTurn(turn.event.eventId);
                return;
            }
            let posted;
            let replyToEventId;
            if (turn.v2StreamEventId) {
                // The reply is already on screen: bring it to its final text.
                replyToEventId = stream.replyToEventId;
                if (text !== stream.shown) {
                    await this.editReplyInRoom(roomId, turn.v2StreamEventId, text, `stream:${turn.event.eventId}:final`, spec.matrixId);
                }
                posted = { eventId: turn.v2StreamEventId };
            }
            else {
                const quote = await this.computeShouldQuote(turn.event, context.chatType);
                replyToEventId = quote ? turn.event.eventId : undefined;
                await this.showAnsweringEyes(turn, decision, context);
                posted = await this.postReplyToRoom(roomId, text, turn.event.eventId, spec.matrixId, replyToEventId, turn.event.eventId);
            }
            await this.recordOwnReply(turn, spec, text, posted.eventId, replyToEventId);
            this.keepV2Claim(turn);
            await appendDoLog(this.ctx.storage, `v2 answered ${turn.event.eventId} (${decision.reason}${action.mode ? `, mode=${action.mode}` : ''}${stream.shown ? `, streamed edits=${stream.edits}` : ''}) in ${this.nowMs() - turn.event.timestampMs}ms`, this.nowMs(), this.env);
            await this.removePendingTurn(turn.event.eventId);
        }
        catch (error) {
            const attempts = turn.attempts + 1;
            const failNow = this.nowMs();
            const errMsg = scrubSecrets(error instanceof Error ? error.message : error, this.env);
            await this.ctx.storage.put('lastError', errMsg);
            const retryable = isChainExhaustedError(error)
                ? false
                : error instanceof A2AError
                    ? error.retryable
                    : typeof error?.retryable === 'boolean'
                        ? error.retryable
                        : true;
            if (retryable && attempts < MAX_POST_ATTEMPTS) {
                // Step back while retrying: a slow or failing brain must not hold the room. Another agent may
                // take the message meanwhile; the retry then waits, or yields once that agent answered.
                if (turn.v2ClaimEventId && !turn.v2StreamEventId)
                    await this.releaseV2Claim(turn, CLAIM_RETRY_REASON);
                await this.updatePendingTurn({ ...turn, attempts, dueAtMs: failNow + 4_000 * 2 ** (attempts - 1), lastError: errMsg });
                await appendDoLog(this.ctx.storage, `v2 retry ${turn.event.eventId} attempt=${attempts}: ${errMsg}`, failNow, this.env);
                return;
            }
            await this.releaseV2Claim(turn);
            // Only someone who spoke to this agent directly gets told it failed; never a fake error elsewhere.
            if (decision.direct && cfg.enableA2AFailureReply === true && !isChainExhaustedError(error)) {
                const lang = detectLang(turn.event.text ?? '');
                const failText = cfg.a2aFailureReply?.(lang, turn.event) ?? defaultA2AFailureReply(lang);
                await this.postReplyToRoom(roomId, failText, `fail:${turn.event.eventId}`, spec.matrixId, undefined, turn.event.eventId).catch(() => undefined);
            }
            await appendDoLog(this.ctx.storage, `v2 gave up ${turn.event.eventId} after ${attempts}: ${errMsg}`, failNow, this.env);
            await this.removePendingTurn(turn.event.eventId);
        }
    }
    async buildRoomContextForTurn(turn, effectiveSpec, memoryStore, nowMs) {
        const meta = (await this.ctx.storage.get('roomMeta')) ?? {
            roomId: turn.event.roomId,
            chatType: turn.event.chatType,
            members: [],
            updatedAtMs: nowMs,
        };
        const recentHistory = (await this.ctx.storage.get('recentHistory')) ?? [];
        const consecutiveAgentMessages = (await this.ctx.storage.get('consecutiveAgentMessages')) ?? 0;
        const roomLanguageHint = await this.ctx.storage.get('roomLanguageHint');
        const userLanguageHints = (await this.ctx.storage.get('userLanguageHints')) ?? {};
        const sessions = (await this.ctx.storage.get('sessions')) ?? {};
        const latestEventId = await this.ctx.storage.get('latestEventId');
        const latestHumanEventId = await this.ctx.storage.get('latestHumanEventId');
        const lastUnmentionedReplyAtMs = await this.ctx.storage.get('lastUnmentionedReplyAtMs');
        const replyToTarget = await this.hydrateReplyTarget(turn.event.roomId, turn.event.replyToEventId, effectiveSpec.matrixId);
        const session = sessions[turn.event.senderId];
        const activeSession = session && session.expiresAtMs >= nowMs
            ? { active: true, ...session }
            : { active: false };
        let roomMuted = false;
        let roomThreshold;
        const contextChatType = meta.chatType ?? turn.event.chatType;
        let storedUserLang = turn.event.senderId ? userLanguageHints[turn.event.senderId] : undefined;
        if (memoryStore) {
            roomMuted = await memoryStore.isRoomMuted(turn.event.roomId);
            roomThreshold = await memoryStore.getRoomThreshold(turn.event.roomId);
            if (!storedUserLang && turn.event.senderId) {
                storedUserLang = await memoryStore
                    .getPreferredLang(turn.event.senderId, contextChatType)
                    .catch(() => undefined);
            }
        }
        const coalescedSet = new Set(turn.event.coalescedEventIds ?? [turn.event.eventId]);
        const subsequentEvents = findSubsequentHistory(recentHistory, turn.event).map((h) => ({
            eventId: h.eventId,
            senderId: h.senderId,
            ...(h.answersEventId ? { answersEventId: h.answersEventId } : {}),
            ...(h.isBroadcast ? { isBroadcast: true } : {}),
        }));
        const effectiveLatestHumanId = latestHumanEventId && coalescedSet.has(latestHumanEventId)
            ? turn.event.eventId
            : latestHumanEventId;
        const effectiveLatestId = latestEventId && coalescedSet.has(latestEventId) ? turn.event.eventId : latestEventId;
        const members = meta.members;
        const peers = inspectRoomPeers(members, effectiveSpec.matrixId);
        return {
            roomId: turn.event.roomId,
            roomName: turn.event.roomName ?? meta.roomName,
            chatType: contextChatType,
            members,
            peers,
            recentHistory,
            ...(replyToTarget ? { replyToTarget } : {}),
            consecutiveAgentMessages,
            ...(roomLanguageHint ? { roomLanguageHint } : {}),
            ...(storedUserLang ? { userLanguageHint: storedUserLang } : {}),
            roomMuted,
            ...(roomThreshold !== undefined ? { roomThreshold } : {}),
            activeSession,
            ...(lastUnmentionedReplyAtMs !== undefined ? { lastUnmentionedReplyAtMs } : {}),
            subsequentEvents,
            ...(effectiveLatestId ? { latestEventId: effectiveLatestId } : {}),
            ...(effectiveLatestHumanId ? { latestHumanEventId: effectiveLatestHumanId } : {}),
        };
    }
    async alarm() {
        if (!isNarraGatewayEnabled(this.env)) {
            await this.ctx.storage.deleteAlarm();
            return;
        }
        const cfg = this.getConfig();
        const nowMs = this.nowMs();
        const chainTracker = new AgentChainTracker(AGENT_CHAIN_CAP, AGENT_CHAIN_RETRY_MS);
        // 1. Flush any due BurstCoalescer buffers into pendingTurns atomically.
        await this.runLocked(async () => {
            const storedBursts = (await this.ctx.storage.get('bursts')) ?? [];
            const coalescer = this.createCoalescer(nowMs, storedBursts);
            const flushed = await coalescer.flushDue(nowMs);
            const pendingTurns = (await this.ctx.storage.get('pendingTurns')) ?? [];
            const redactedSet = new Set((await this.ctx.storage.get('redactedIds')) ?? []);
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
            const pendingTurns = (await this.ctx.storage.get('pendingTurns')) ?? [];
            const nextTurn = pendingTurns.find((t) => t.dueAtMs <= this.nowMs());
            if (!nextTurn)
                break;
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
            const pipeline = pipelineForRoom(this.env, nextTurn.event.roomId);
            if (isUnlistedRoomIgnored(this.env, nextTurn.event.roomId)) {
                await this.removePendingTurn(nextTurn.event.eventId);
                continue;
            }
            if (pipeline === 'v2') {
                await this.runTurnV2(nextTurn, effectiveSpec, memoryStore);
                continue;
            }
            let lastDecision = nextTurn.decision;
            try {
                let answer = nextTurn.answer;
                let decision = nextTurn.decision;
                if (answer === undefined) {
                    const context = await this.buildRoomContextForTurn(nextTurn, effectiveSpec, memoryStore, currentNowMs);
                    const triageModel = cfg.triageModel?.(this.env) ?? createDefaultTriageModel(this.env);
                    decision =
                        nextTurn.fallbackRank !== undefined
                            ? await this.resolveGroupFallback(nextTurn, context, effectiveSpec, currentNowMs)
                            : await routeEvent(nextTurn.event, context, effectiveSpec, {
                                nowMs: currentNowMs,
                                triageModel,
                                chainCap: AGENT_CHAIN_CAP,
                            });
                    lastDecision = decision;
                    if (pipeline === 'shadow' && nextTurn.fallbackRank === undefined) {
                        await this.logShadowV2(nextTurn, context, effectiveSpec, decision).catch(() => undefined);
                    }
                    if (!decision.shouldReply) {
                        // A real question nobody may claim: join the fallback election instead of dropping it.
                        if (nextTurn.fallbackRank === undefined &&
                            decision.isAsk === true &&
                            context.chatType === 'group' &&
                            isAskGroupTriage(this.env) &&
                            effectiveSpec.matrixId) {
                            const rank = groupFallbackRank(nextTurn.event.eventId, effectiveSpec.matrixId, context.members);
                            if (rank >= 0 && rank < GROUP_FALLBACK_MAX_RANK) {
                                await this.updatePendingTurn({
                                    ...nextTurn,
                                    decision: undefined,
                                    fallbackRank: rank,
                                    dueAtMs: currentNowMs + GROUP_FALLBACK_BASE_MS + rank * GROUP_FALLBACK_STEP_MS,
                                });
                                await appendDoLog(this.ctx.storage, `not mine ${nextTurn.event.eventId} (${decision.reason}); fallback rank ${rank}`, currentNowMs, this.env);
                                continue;
                            }
                        }
                        if (decision.reason === 'active_session_off_topic' ||
                            decision.reason === 'active_session_chatter' ||
                            decision.reason === 'aimed_elsewhere' ||
                            decision.reason === 'peer_already_replied') {
                            await this.clearUserSession(nextTurn.event.senderId);
                        }
                        await appendDoLog(this.ctx.storage, `dropped ${nextTurn.event.eventId}: ${decision.reason}`, currentNowMs, this.env);
                        await this.removePendingTurn(nextTurn.event.eventId);
                        continue;
                    }
                    // Polite yield for unmentioned turns so peers don't pile on.
                    // Explicit co-mentions (`multi_mention_domain_match`) must NOT yield to another co-mentioned
                    // specialist when the user deliberately called both specialists for their respective domains.
                    if (decision.yieldDelayMs &&
                        decision.yieldDelayMs > 0 &&
                        decision.reason !== 'multi_mention_domain_match') {
                        const yieldOutcome = await executePoliteYield({
                            delayMs: decision.yieldDelayMs,
                            sleep: cfg.sleep,
                            checkPeerAnswered: () => decision.reason === 'multi_mention_domain_match'
                                ? (async () => {
                                    const latestHistory = (await this.ctx.storage.get('recentHistory')) ?? [];
                                    return hasPeerRepliedAfter(nextTurn.event, { ...context, recentHistory: latestHistory }, effectiveSpec.matrixId);
                                })()
                                : this.hasLivePeerRepliedAfter(nextTurn.event, context, effectiveSpec.matrixId),
                        });
                        if (yieldOutcome.yield) {
                            if (decision.reason === 'active_session') {
                                await this.clearUserSession(nextTurn.event.senderId);
                            }
                            await appendDoLog(this.ctx.storage, `yielded ${nextTurn.event.eventId}: ${yieldOutcome.reason}`, this.nowMs(), this.env);
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
                        const auth = await authorizeEvent({
                            narraApiEndpoint: narraEndpoint(this.env),
                            narraAgentToken: this.env.NARRA_AGENT_TOKEN,
                            fetchImpl: cfg.fetchImpl,
                        }, {
                            roomId: nextTurn.event.roomId,
                            senderMatrixUserId: nextTurn.event.senderId,
                            memberMatrixUserIds: context.members.map((m) => m.matrixId),
                            mentioned: Boolean(effectiveSpec.matrixId && nextTurn.event.mentions.includes(effectiveSpec.matrixId)),
                        });
                        if (!auth.allow) {
                            await appendDoLog(this.ctx.storage, `unauthorized ${nextTurn.event.eventId}: ${auth.reason ?? 'denied'}`, this.nowMs(), this.env);
                            await this.removePendingTurn(nextTurn.event.eventId);
                            continue;
                        }
                    }
                    // Kick off read receipt + typing indicator concurrently so they never add serial HTTP latency
                    // ahead of D1 memory recall, local fastRespond, or Manyfold A2A.
                    let turnActive = true;
                    let typingActive = false;
                    let typingTimer;
                    const receiptPromise = nextTurn.event.eventId
                        ? this.matrixOp({
                            op: 'receipt',
                            roomId: nextTurn.event.roomId,
                            eventId: nextTurn.event.eventId,
                        }).catch(() => undefined)
                        : Promise.resolve(undefined);
                    const typingPromise = this.matrixOp({
                        op: 'typing',
                        roomId: nextTurn.event.roomId,
                        typing: true,
                    })
                        .then((typingRes) => {
                        if (typingRes.ok && turnActive) {
                            typingActive = true;
                            typingTimer = setInterval(() => {
                                void this.matrixOp({
                                    op: 'typing',
                                    roomId: nextTurn.event.roomId,
                                    typing: true,
                                }).catch(() => undefined);
                            }, TYPING_REFRESH_MS);
                        }
                        return typingRes;
                    })
                        .catch(() => ({ ok: false, status: 0 }));
                    const memories = memoryStore
                        ? await memoryStore.recallForTurn({
                            roomId: nextTurn.event.roomId,
                            userId: nextTurn.event.senderId,
                            chatType: context.chatType,
                        })
                        : emptyMemories();
                    const isDirectTurn = context.chatType === 'dm' ||
                        decision.reason === 'dm' ||
                        decision.reason === 'explicit_mention' ||
                        decision.reason === 'reply_to_self';
                    // fastRespond templates speak zh/en only: a message in another language goes to A2A,
                    // which gets the same prefetched records and can answer in the asker's language.
                    const foreignReplyLang = decision.replyLang && !isZhOrEn(decision.replyLang) ? decision.replyLang : undefined;
                    // Committed turns post a status bubble while A2A works (so the room, and other agents'
                    // group fallback, can see the question is being handled) and get the Workers AI backup
                    // when A2A fails, instead of silence.
                    const isCommittedTurn = isDirectTurn ||
                        decision.reason === 'multi_mention_domain_match' ||
                        decision.reason === 'active_session' ||
                        decision.reason === 'group_fallback' ||
                        decision.isAsk === true ||
                        Boolean(foreignReplyLang);
                    const mentionNamesForCheck = [
                        effectiveSpec.name,
                        ...(effectiveSpec.aliases ?? []),
                        ...context.members.flatMap((m) => (m.displayName ? [m.displayName] : [])),
                    ];
                    const strippedForSummary = stripAgentMentions(nextTurn.event.text ?? '', mentionNamesForCheck).trim();
                    const wantsSummary = isDirectTurn && isSummaryOrRecapRequest(strippedForSummary);
                    let rawAnswer = '';
                    let usedA2A = false;
                    let thinkingTimer;
                    let thinkingPostPromise;
                    try {
                        let handledFast = false;
                        if (memoryStore) {
                            try {
                                const memReply = await handleStandardMemoryCommand({
                                    store: memoryStore,
                                    event: nextTurn.event,
                                    context,
                                    decision,
                                    memories,
                                    spec: effectiveSpec,
                                });
                                if (memReply !== null) {
                                    rawAnswer = memReply;
                                    handledFast = true;
                                    const switched = detectExplicitLangSwitch(strippedForSummary);
                                    if (switched && nextTurn.event.senderId) {
                                        await this.runLocked(async () => {
                                            const hints = (await this.ctx.storage.get('userLanguageHints')) ??
                                                {};
                                            hints[nextTurn.event.senderId] = switched;
                                            await this.ctx.storage.put('userLanguageHints', hints);
                                            if (context.chatType === 'dm') {
                                                await this.ctx.storage.put('roomLanguageHint', switched);
                                            }
                                        });
                                    }
                                }
                            }
                            catch {
                                // Fall back cleanly if memory command fails unexpectedly.
                            }
                        }
                        // Summaries and restatements require conversational context rather than a fresh lookup.
                        let preResolvedCred;
                        const rewriteTimestamp = nextTurn.event.timestampMs;
                        const wantsRewrite = isContextualRewrite(nextTurn.event.text) &&
                            (context.replyToTarget?.isSelf || context.recentHistory.some((turn) => turn.isSelf &&
                                turn.timestampMs <= rewriteTimestamp));
                        let skipFast = false;
                        if (!handledFast && (wantsSummary || wantsRewrite)) {
                            preResolvedCred = await (cfg.resolveA2ACredential?.(this.env) ??
                                defaultResolveA2ACredential(this.env, effectiveSpec));
                            if (preResolvedCred?.url && preResolvedCred?.token) {
                                skipFast = true;
                            }
                        }
                        if (!handledFast &&
                            !skipFast &&
                            cfg.fastRespond &&
                            decision.reason !== 'group_fallback' &&
                            !foreignReplyLang) {
                            try {
                                const fast = await cfg.fastRespond(this.env, nextTurn.event, decision, memories, context);
                                if (fast !== null && fast !== undefined) {
                                    rawAnswer = fast;
                                    handledFast = true;
                                }
                            }
                            catch {
                                // Fall back seamlessly to Manyfold A2A.
                            }
                        }
                        if (!handledFast) {
                            usedA2A = true;
                            // An unmentioned group question this agent claimed shows its status right away: the
                            // other agents' polite yield sees it and stands down instead of answering too.
                            // An elected fallback is an agent outside its own topic: no themed status bubble for it,
                            // so if it ends up with nothing to say, nothing shows (the typing indicator still does).
                            const isFallbackTurn = decision.reason === 'group_fallback';
                            const claimedGroupAsk = decision.isAsk === true && context.chatType === 'group' && !isDirectTurn && !isFallbackTurn;
                            const thinkingDelayMs = claimedGroupAsk ? 0 : (cfg.thinkingDelayMs ?? DEFAULT_THINKING_DELAY_MS);
                            if (isCommittedTurn &&
                                !isFallbackTurn &&
                                (thinkingDelayMs > 0 || claimedGroupAsk) &&
                                !nextTurn.thinkingEventId) {
                                const statusText = wantsSummary
                                    ? defaultThinkingMessage(decision.detectedLang, true)
                                    : (cfg.thinkingMessage?.(decision.detectedLang, nextTurn.event, decision) ??
                                        defaultThinkingMessage(decision.detectedLang, false));
                                const roomChatType = context.chatType;
                                thinkingTimer = setTimeout(() => {
                                    thinkingPostPromise = (async () => {
                                        try {
                                            const qNow = await this.computeShouldQuote(nextTurn.event, roomChatType);
                                            const postedStatus = await this.postReplyToRoom(nextTurn.event.roomId, statusText, `thinking:${nextTurn.event.eventId}`, effectiveSpec.matrixId, qNow ? nextTurn.event.eventId : undefined, nextTurn.event.eventId);
                                            if (postedStatus.eventId) {
                                                nextTurn.thinkingEventId = postedStatus.eventId;
                                                await this.updatePendingTurn(nextTurn);
                                            }
                                        }
                                        catch {
                                            // Non-fatal: final answer will still be posted normally.
                                        }
                                    })();
                                }, thinkingDelayMs);
                            }
                            const [cred, extraFields, expandedHistory, storedContextId] = await Promise.all([
                                preResolvedCred !== undefined
                                    ? Promise.resolve(preResolvedCred)
                                    : Promise.resolve(cfg.resolveA2ACredential?.(this.env) ??
                                        defaultResolveA2ACredential(this.env, effectiveSpec)),
                                cfg.buildExtraEnvelopeFields
                                    ? cfg
                                        .buildExtraEnvelopeFields(this.env, nextTurn.event, decision, memories, context, { pipeline: 'v1' })
                                        .catch(() => undefined)
                                    : Promise.resolve(undefined),
                                wantsSummary
                                    ? this.loadExpandedHistoryForSummary(nextTurn.event.roomId, context.recentHistory, effectiveSpec.matrixId, context.members, 40).catch(() => context.recentHistory)
                                    : Promise.resolve(context.recentHistory),
                                this.ctx.storage.get('a2aContextId').catch(() => undefined),
                            ]);
                            if (!cred || !cred.url || !cred.token) {
                                throw new A2AError('No A2A credential available for Narra gateway.', false);
                            }
                            const envelopeFields = {
                                ...(extraFields ?? {}),
                                ...(decision.reason === 'group_fallback' ? { routing_note: GROUP_FALLBACK_NOTE } : {}),
                                ...(foreignReplyLang
                                    ? {
                                        reply_language: foreignReplyLang,
                                        reply_language_note: `The message is in "${foreignReplyLang}". Reply entirely in that language, keeping names, links and addresses as they are.`,
                                    }
                                    : {}),
                            };
                            const envelope = buildPromptEnvelope({
                                event: nextTurn.event,
                                context: wantsSummary ? { ...context, recentHistory: expandedHistory } : context,
                                decision,
                                memories,
                                spec: effectiveSpec,
                                summaryMode: wantsSummary,
                                ...(Object.keys(envelopeFields).length > 0 ? { extraFields: envelopeFields } : {}),
                            });
                            try {
                                const a2aRes = await runManyfoldA2ATurnWithMeta({
                                    credential: {
                                        rpcUrl: cred.url,
                                        token: cred.token,
                                        label: cred.label ?? effectiveSpec.name,
                                    },
                                    envelope,
                                    eventId: nextTurn.event.eventId,
                                    ...(storedContextId ? { contextId: storedContextId } : {}),
                                    timeoutMs: 15_000,
                                    fetchImpl: cfg.fetchImpl,
                                });
                                rawAnswer = a2aRes.text;
                                if (a2aRes.contextId && a2aRes.contextId !== storedContextId) {
                                    await this.ctx.storage.put('a2aContextId', a2aRes.contextId).catch(() => undefined);
                                }
                            }
                            catch (a2aErr) {
                                if (storedContextId &&
                                    a2aErr instanceof A2AError &&
                                    !a2aErr.retryable &&
                                    /(?:HTTP 40[04]|context)/i.test(a2aErr.message)) {
                                    await this.ctx.storage.delete('a2aContextId').catch(() => undefined);
                                }
                                // Resilience circuit-breaker: Manyfold A2A stays 100% primary; ONLY if Manyfold A2A
                                // fails on a directly addressed turn when Workers AI is bound + enableA2AFailureReply is on,
                                // seamlessly fall back to Workers AI using the exact same pre-fetched envelope so the user
                                // never hangs staring at a stuck progress bubble during an upstream Manyfold outage.
                                if (isCommittedTurn && cfg.enableA2AFailureReply === true && this.env.AI) {
                                    const backup = await runWorkersAiResilienceFallback(this.env.AI, this.env.AI_TRIAGE_MODEL, effectiveSpec, envelope, decision.detectedLang, wantsSummary, foreignReplyLang);
                                    if (backup) {
                                        rawAnswer = backup;
                                    }
                                    else {
                                        const local = foreignReplyLang ? await this.tryFastRespond(cfg, nextTurn.event, decision, memories, context) : null;
                                        if (local === null)
                                            throw a2aErr;
                                        // Better a zh/en answer from the agent's own data than an apology.
                                        rawAnswer = local;
                                        usedA2A = false;
                                    }
                                }
                                else {
                                    throw a2aErr;
                                }
                            }
                        }
                    }
                    finally {
                        turnActive = false;
                        if (thinkingTimer !== undefined)
                            clearTimeout(thinkingTimer);
                        if (thinkingPostPromise) {
                            await thinkingPostPromise.catch(() => undefined);
                        }
                        await Promise.allSettled([receiptPromise, typingPromise]);
                        if (typingTimer !== undefined)
                            clearInterval(typingTimer);
                        if (typingActive) {
                            await this.matrixOp({
                                op: 'typing',
                                roomId: nextTurn.event.roomId,
                                typing: false,
                            }).catch(() => undefined);
                        }
                    }
                    let cleaned = '';
                    if (usedA2A) {
                        // No zh-Hant/zh-Hans conversion for other languages: it would rewrite Japanese kanji.
                        cleaned = normalizeA2AOutput(rawAnswer, foreignReplyLang ? 'en' : decision.detectedLang).text;
                    }
                    else {
                        const { text: withoutNotes } = stripLeakedNotes(rawAnswer);
                        cleaned = withoutNotes ? sanitizeMobileLinks(withoutNotes) : '';
                    }
                    if (!cleaned || isSilence(cleaned)) {
                        if (nextTurn.thinkingEventId) {
                            const fallback = cfg.a2aFailureReply?.(decision.detectedLang, nextTurn.event) ??
                                defaultA2AFailureReply(decision.detectedLang);
                            await this.editReplyInRoom(nextTurn.event.roomId, nextTurn.thinkingEventId, fallback, `silent-fallback:${nextTurn.event.eventId}`, effectiveSpec.matrixId);
                        }
                        if (decision.reason === 'active_session') {
                            await this.clearUserSession(nextTurn.event.senderId);
                        }
                        await appendDoLog(this.ctx.storage, `silent ${nextTurn.event.eventId} (${decision.reason})`, this.nowMs(), this.env);
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
                const meta = await this.ctx.storage.get('roomMeta');
                const chatType = meta?.chatType ?? nextTurn.event.chatType;
                if (chatType === 'group' &&
                    decision?.tier === 1 &&
                    !decision.directRoute &&
                    !decision.independentGroupReply &&
                    decision.reason !== 'multi_mention_domain_match') {
                    const latestPeers = inspectRoomPeers(meta?.members ?? [], effectiveSpec.matrixId);
                    if (latestPeers.length > 0 &&
                        (await this.hasLivePeerRepliedAfter(nextTurn.event, {
                            roomId: nextTurn.event.roomId,
                            chatType,
                            members: meta?.members ?? [],
                            peers: latestPeers,
                            recentHistory: [],
                        }, effectiveSpec.matrixId))) {
                        await this.clearUserSession(nextTurn.event.senderId);
                        await appendDoLog(this.ctx.storage, `yielded_post_gen ${nextTurn.event.eventId}: peer_already_replied`, this.nowMs(), this.env);
                        await this.removePendingTurn(nextTurn.event.eventId);
                        continue;
                    }
                }
                const quoteNow = await this.computeShouldQuote(nextTurn.event, chatType);
                const replyToEventId = quoteNow ? nextTurn.event.eventId : undefined;
                let posted;
                if (nextTurn.thinkingEventId &&
                    (await this.editReplyInRoom(nextTurn.event.roomId, nextTurn.thinkingEventId, answer, nextTurn.event.eventId, effectiveSpec.matrixId, replyToEventId))) {
                    posted = { eventId: nextTurn.thinkingEventId };
                }
                else {
                    posted = await this.postReplyToRoom(nextTurn.event.roomId, answer, nextTurn.event.eventId, effectiveSpec.matrixId, replyToEventId, nextTurn.event.eventId);
                }
                const repliedAtMs = this.nowMs();
                await this.runLocked(async () => {
                    const ownMessages = (await this.ctx.storage.get('ownMessages')) ?? [];
                    const postedEventId = posted.eventId || `sent:${nextTurn.event.eventId}`;
                    ownMessages.push({
                        eventId: postedEventId,
                        text: answer.slice(0, 1000),
                        timestampMs: repliedAtMs,
                    });
                    await this.ctx.storage.put('ownMessages', ownMessages.slice(-MAX_OWN_MESSAGES));
                    const history = (await this.ctx.storage.get('recentHistory')) ?? [];
                    history.push({
                        eventId: postedEventId,
                        senderId: effectiveSpec.matrixId ?? '',
                        senderName: effectiveSpec.name,
                        isAgent: true,
                        isSelf: true,
                        text: answer.slice(0, 1000),
                        timestampMs: repliedAtMs,
                        ...(replyToEventId ? { replyToEventId } : {}),
                    });
                    await this.ctx.storage.put('recentHistory', history.slice(-MAX_RECENT_HISTORY));
                    const consec = ((await this.ctx.storage.get('consecutiveAgentMessages')) ?? 0) + 1;
                    await this.ctx.storage.put('consecutiveAgentMessages', consec);
                    if (posted.eventId) {
                        await this.ctx.storage.put('latestEventId', posted.eventId);
                        await this.markEventHandled(posted.eventId);
                    }
                    if (chatType === 'group' && decision?.tier === 1 && !decision.directRoute) {
                        await this.ctx.storage.put('lastUnmentionedReplyAtMs', repliedAtMs);
                    }
                    if (nextTurn.event.senderId) {
                        const sessions = (await this.ctx.storage.get('sessions')) ?? {};
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
                await appendDoLog(this.ctx.storage, `answered ${nextTurn.event.eventId} (quote=${quoteNow}${(nextTurn.decision ?? decision)?.reason ? `, ${(nextTurn.decision ?? decision).reason}` : ''})`, repliedAtMs, this.env);
                await this.removePendingTurn(nextTurn.event.eventId);
            }
            catch (error) {
                const attempts = nextTurn.attempts + 1;
                const failNow = this.nowMs();
                const errMsg = scrubSecrets(error instanceof Error ? error.message : error, this.env);
                await this.ctx.storage.put('lastError', errMsg);
                let delayMs = null;
                if (isChainExhaustedError(error)) {
                    delayMs = chainTracker.nextRetryDelayMs(attempts);
                }
                else if (error instanceof A2AError) {
                    delayMs = error.retryable && attempts < MAX_POST_ATTEMPTS ? 5_000 * 2 ** (attempts - 1) : null;
                }
                else if (typeof error?.retryable === 'boolean') {
                    const sf = error;
                    delayMs = sf.retryable && attempts < MAX_POST_ATTEMPTS ? 5_000 * 2 ** (attempts - 1) : null;
                }
                else {
                    delayMs = attempts < MAX_POST_ATTEMPTS ? 5_000 * 2 ** (attempts - 1) : null;
                }
                if (delayMs === null) {
                    const isDirectGiveUp = nextTurn.event.chatType === 'dm' ||
                        lastDecision?.reason === 'dm' ||
                        lastDecision?.reason === 'explicit_mention' ||
                        lastDecision?.reason === 'reply_to_self' ||
                        lastDecision?.reason === 'multi_mention_domain_match' ||
                        lastDecision?.reason === 'active_session';
                    const shouldSendFailureNotice = nextTurn.answer === undefined &&
                        (Boolean(nextTurn.thinkingEventId) || (isDirectGiveUp && cfg.enableA2AFailureReply === true));
                    if (shouldSendFailureNotice) {
                        const failLang = lastDecision?.detectedLang ?? detectLang(nextTurn.event.text ?? '');
                        const failText = cfg.a2aFailureReply?.(failLang, nextTurn.event) ?? defaultA2AFailureReply(failLang);
                        try {
                            const edited = nextTurn.thinkingEventId
                                ? await this.editReplyInRoom(nextTurn.event.roomId, nextTurn.thinkingEventId, failText, `fail-edit:${nextTurn.event.eventId}`, effectiveSpec.matrixId)
                                : false;
                            if (!edited) {
                                const meta = await this.ctx.storage.get('roomMeta');
                                const qNow = await this.computeShouldQuote(nextTurn.event, meta?.chatType ?? nextTurn.event.chatType);
                                await this.postReplyToRoom(nextTurn.event.roomId, failText, `fail:${nextTurn.event.eventId}`, effectiveSpec.matrixId, qNow ? nextTurn.event.eventId : undefined, nextTurn.event.eventId);
                            }
                        }
                        catch {
                            // Never fail cleanup if fallback notice itself fails to send.
                        }
                    }
                    await appendDoLog(this.ctx.storage, `gave up on ${nextTurn.event.eventId} after ${attempts} attempt(s): ${errMsg}`, failNow, this.env);
                    await this.removePendingTurn(nextTurn.event.eventId);
                    continue;
                }
                nextTurn.attempts = attempts;
                nextTurn.dueAtMs = failNow + delayMs;
                nextTurn.lastError = errMsg;
                await this.updatePendingTurn(nextTurn);
                await appendDoLog(this.ctx.storage, `retry ${nextTurn.event.eventId} attempt=${attempts} in ${delayMs}ms: ${errMsg}`, failNow, this.env);
                // Do not head-of-line block later ready turns (e.g. local fastRespond or memory commands)
                // when an un-answered turn fails upstream A2A and enters retry backoff.
                if (error instanceof A2AError && !isChainExhaustedError(error) && nextTurn.answer === undefined) {
                    continue;
                }
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
export async function kickNarraGateway(env, config) {
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
                const body = (await response.json().catch(() => null));
                syncRunning = body?.running === true;
            }
        }
        catch {
            syncKicked = false;
        }
    }
    let broadcast = null;
    if (config?.fetchUpdates) {
        const nowMs = config.now?.() ?? Date.now();
        const nowIso = new Date(nowMs).toISOString();
        let sinceIso = new Date(nowMs - 24 * 60 * 60_000).toISOString();
        let memoryStore;
        const dedupeStore = env.DB
            ? await (async () => {
                await ensureGatewaySchemas(env.DB);
                memoryStore = new MemoryStore(env.DB, config.spec.id);
                const row = await env.DB
                    .prepare('SELECT last_broadcast_iso FROM narra_gateway_state WHERE agent_id = ?')
                    .bind(config.spec.id)
                    .first();
                if (row?.last_broadcast_iso) {
                    sinceIso = row.last_broadcast_iso;
                }
                return new D1BroadcastStore(env.DB);
            })()
            : new InMemoryBroadcastStore();
        const updates = (await config.fetchUpdates(env, sinceIso)).filter((u) => !isUnlistedRoomIgnored(env, u.roomId));
        const enforceStaggerWindow = config.enforceBroadcastStagger ?? (env.NARRA_BROADCAST_STAGGER ?? '').trim() !== 'off';
        const scheduler = new ProactiveBroadcastScheduler({
            agentId: config.spec.id,
            dedupeStore,
            memoryStore,
            enforceStaggerWindow,
            roomRules: (roomId) => roomPostingRulesFor(env, roomId),
            nowMs: () => nowMs,
            ...(config.isRoomOptedOut
                ? { isRoomOptedOut: (roomId) => config.isRoomOptedOut(env, roomId) }
                : {}),
            getRecentHistory: async (roomId) => {
                if (!env.NARRA_ROOM_DO)
                    return [];
                try {
                    const stub = env.NARRA_ROOM_DO.get(env.NARRA_ROOM_DO.idFromName(roomId));
                    const res = await stub.fetch('https://narra-room/history');
                    if (!res.ok)
                        return [];
                    const body = (await res.json().catch(() => null));
                    return Array.isArray(body?.history) ? body.history : [];
                }
                catch {
                    return [];
                }
            },
            send: async (item, cleanText) => {
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
                            content: messageContent(cleanText, { selfMatrixId: config.spec.matrixId, broadcast: true }),
                        }),
                    });
                    const matBody = (await matRes.json().catch(() => null));
                    if (matBody?.ok) {
                        postedEventId = matBody.eventId ?? '';
                    }
                    else if (matBody && matBody.status !== 0) {
                        throw makeSendFailure(`Broadcast Matrix send failed: HTTP ${matBody.status}`, matBody.status, { errcode: matBody.errcode, narraCode: matBody.narraCode });
                    }
                    else {
                        const fallback = await postViaNarraChatApi(env, {
                            roomId: item.roomId,
                            text: plainMentions(cleanText, config.spec.matrixId ?? ''),
                            txnId,
                            fetchImpl: config.fetchImpl,
                        });
                        postedEventId = fallback.eventId;
                    }
                }
                else {
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
                                isBroadcast: true,
                            }),
                        });
                    }
                    catch {
                        // Non-fatal: message already delivered.
                    }
                }
            },
        });
        broadcast = await scheduler.run(updates);
        if (env.DB) {
            await env.DB
                .prepare(`INSERT INTO narra_gateway_state (agent_id, last_broadcast_iso, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT (agent_id) DO UPDATE SET
             last_broadcast_iso = excluded.last_broadcast_iso,
             updated_at = excluded.updated_at`)
                .bind(config.spec.id, nowIso, nowIso)
                .run();
        }
    }
    let proactiveQueued = 0;
    if (config?.v2?.proactive && env.NARRA_ROOM_DO) {
        const nowMs = config.now?.() ?? Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const store = env.DB
            ? await (async () => {
                await ensureGatewaySchemas(env.DB);
                return new D1BroadcastStore(env.DB);
            })()
            : new InMemoryBroadcastStore();
        let items = [];
        try {
            items = await config.v2.proactive(env, nowMs);
        }
        catch {
            items = [];
        }
        for (const item of items) {
            if (!item?.roomId || !item.key || !item.note)
                continue;
            if (isUnlistedRoomIgnored(env, item.roomId) || pipelineForRoom(env, item.roomId) !== 'v2')
                continue;
            const key = `proactive:${item.key}`;
            if (await store.hasSentKey(config.spec.id, item.roomId, key))
                continue;
            const stub = env.NARRA_ROOM_DO.get(env.NARRA_ROOM_DO.idFromName(item.roomId));
            if (!item.ignoreRoomRules) {
                let history = [];
                try {
                    const res = await stub.fetch('https://narra-room/history');
                    const body = (await res.json().catch(() => null));
                    history = Array.isArray(body?.history) ? body.history : [];
                }
                catch {
                    history = [];
                }
                const rules = {
                    ...DEFAULT_ROOM_POSTING_RULES,
                    dailyCap: parseLimit(env.NARRA_ROOM_DAILY_POSTS, DEFAULT_ROOM_POSTING_RULES.dailyCap),
                    ...(item.rules ?? {}),
                };
                if (roomPostingBlock(history, nowMs, rules))
                    continue;
            }
            if (!(await store.claimUpdateKey(config.spec.id, item.roomId, key, nowIso)))
                continue;
            try {
                await stub.fetch('https://narra-room/proactive', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ roomId: item.roomId, key: item.key, note: item.note }),
                });
                proactiveQueued++;
            }
            catch {
                // Already claimed: not retried, like a scheduled post that failed to send.
            }
        }
    }
    return {
        enabled: true,
        syncKicked,
        syncRunning,
        broadcast,
        ...(proactiveQueued ? { proactiveQueued } : {}),
    };
}
/**
 * Returns redacted gateway status JSON. NEVER exposes tokens, secrets, or raw user message bodies.
 */
export async function getNarraGatewayStatus(env, config) {
    const enabled = isNarraGatewayEnabled(env);
    const syncEnabled = isNarraSyncEnabled(env);
    let syncStatus = null;
    const rooms = {};
    if (env.NARRA_SYNC_DO) {
        try {
            const stub = env.NARRA_SYNC_DO.get(env.NARRA_SYNC_DO.idFromName('narra'));
            const res = await stub.fetch('https://narra-sync/status');
            if (res.ok) {
                syncStatus = (await res.json());
                const roomIds = Array.isArray(syncStatus.roomIds)
                    ? syncStatus.roomIds.slice(0, STALE_ROOM_STATUS_LIMIT)
                    : [];
                if (env.NARRA_ROOM_DO) {
                    for (const roomId of roomIds) {
                        try {
                            const roomStub = env.NARRA_ROOM_DO.get(env.NARRA_ROOM_DO.idFromName(roomId));
                            const roomRes = await roomStub.fetch('https://narra-room/status');
                            if (roomRes.ok) {
                                rooms[roomId] = (await roomRes.json());
                            }
                        }
                        catch {
                            // Skip unreachable room DO in status report.
                        }
                    }
                }
            }
        }
        catch (error) {
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
        matrixId: config?.spec.matrixId ??
            (typeof syncStatus?.matrixUserId === 'string' ? syncStatus.matrixUserId : null),
        config: {
            NARRA_GATEWAY_ENABLED: (env.NARRA_GATEWAY_ENABLED ?? '').trim() || 'off',
            NARRA_SYNC: (env.NARRA_SYNC ?? '').trim() || 'off',
            NARRA_SYNC_MODE: (env.NARRA_SYNC_MODE ?? '').trim() || 'longpoll',
            hasPushUrl: Boolean((env.NARRA_PUSH_URL ?? '').trim()),
            hasPushSecret: pushSecret(env).length >= 16,
            pushModeActive: isNarraPushModeEnabled(env),
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
/**
 * Factory binding `NarraGatewayConfig` to pre-configured Durable Object base classes
 * and gateway helpers. Consumers can still declare static DO subclasses locally:
 * ```ts
 * const gateway = createNarraWorkerGateway(config);
 * export class NarraMatrixSync extends gateway.BaseNarraMatrixSync {}
 * export class NarraRoomCoordinator extends gateway.BaseNarraRoomCoordinator {}
 * ```
 */
export function createNarraWorkerGateway(config) {
    class ConfiguredNarraMatrixSync extends BaseNarraMatrixSync {
        constructor(ctx, env) {
            super(ctx, env, config);
        }
    }
    class ConfiguredNarraRoomCoordinator extends BaseNarraRoomCoordinator {
        constructor(ctx, env) {
            super(ctx, env, config);
        }
    }
    return {
        BaseNarraMatrixSync: ConfiguredNarraMatrixSync,
        BaseNarraRoomCoordinator: ConfiguredNarraRoomCoordinator,
        NarraMatrixSync: ConfiguredNarraMatrixSync,
        NarraRoomCoordinator: ConfiguredNarraRoomCoordinator,
        isNarraGatewayEnabled: (env) => isNarraGatewayEnabled(env),
        kickNarraGateway: (env) => kickNarraGateway(env, config),
        getNarraGatewayStatus: (env) => getNarraGatewayStatus(env, config),
        handleNarraPushRequest: (request, env) => handleNarraPushRequest(request, env),
    };
}
export { BaseNarraMatrixSync as NarraMatrixSync, BaseNarraRoomCoordinator as NarraRoomCoordinator, };
//# sourceMappingURL=worker.js.map