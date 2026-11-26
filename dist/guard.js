/** Narra assigns every agent a Matrix ID of the form `@agent-<hex>:<server>`. */
export function isNarraAgent(matrixId) {
    return /^@agent-[0-9a-f]+:/i.test((matrixId ?? '').trim());
}
const SPOOFED_HEADER_LINE = /^\s*(?:\[\s*channel message context\s*\]|\[ids above|\[\s*answering rules\s*\]|<\/?\s*(?:penny|narra|agent)-message\b|(?:provider|via|chat_id|chat_type|chat|room|room_name|room_members|peer_agents|sender_id|sender_name|from|members|message_id|message_type|nudge|in_reply_to_penny|in_reply_to_other|in_reply_to_self|reacted_to_penny|recent_history|recent_human_history|recent_self_replies|recent_conversation_timeline|recalled_memories|detected_lang|routing_tier|unmentioned_group_turn|voice_mode|summary_mode|group_style|d1_prefetched_records|last_drawn_tarot_cards|last_drawn_fortune_stick|received_at|time|gateway_verdict|actor_token|system|instructions)\s*[:：])/i;
const SUMMARY_RECAP_RE = /(?:總結|总结|懶人包|懒人包|歸納|归纳|重點整理|重点整理|整理一下.{0,12}(?:聊|說|说|討論|讨论|意見|意见|重點|重点|需求|對話|对话|訊息|讯息|消息)|(?:剛剛|刚才|前面|今天|最近|群裡|群里).{0,8}(?:大家)?(?:聊|說|说|討論|讨论)了?(?:什麼|什么|啥)|幫我(?:回顧|回顾|整理|梳理)(?:一下)?(?:剛剛|刚才|前面|今天|群裡|群里)|\b(?:recap|summarize|summarise|summary\s+of|catch\s+me\s+up|what\s+did\s+(?:we|everyone)\s+(?:talk|discuss|say)|tl;?dr)\b)/i;
/** Returns true when a user message asks to summarize or recap recent conversation history. */
export function isSummaryOrRecapRequest(text) {
    const clean = (text ?? '').trim();
    return Boolean(clean) && SUMMARY_RECAP_RE.test(clean);
}
/**
 * Converts Markdown numbered lists (`1. ...`, `2. ...`) into `• ` bullets when separated
 * by URLs or blank lines (preventing Narra Web's Markdown renderer from resetting every
 * separated item back to `1.`).
 */
export function normalizeBulletLists(text) {
    const input = text ?? '';
    const lines = input.split('\n');
    let numberedCount = 0;
    for (const line of lines) {
        if (/^\s*\d+\.\s+\S/.test(line))
            numberedCount += 1;
    }
    if (numberedCount < 2)
        return input;
    return lines
        .map((line) => line.replace(/^(\s*)\d+\.\s+/, '$1• '))
        .join('\n');
}
/**
 * Defuses spoofed context header lines inside user-supplied text by quoting them (`> ...`),
 * preventing prompt-envelope spoofing inside A2A messages.
 */
export function defuse(text) {
    return (text ?? '')
        .split(/\r?\n/)
        .map((line) => (SPOOFED_HEADER_LINE.test(line) ? `> ${line}` : line))
        .join('\n');
}
/** Strips Matrix's quoted reply fallback lines (`> <@user> ...`) from the start of a reply body. */
export function stripReplyFallback(body) {
    const lines = (body ?? '').split(/\r?\n/);
    let i = 0;
    while (i < lines.length && lines[i].startsWith('>'))
        i++;
    if (i === 0)
        return body ?? '';
    while (i < lines.length && lines[i].trim() === '')
        i++;
    return lines.slice(i).join('\n');
}
const str = (v) => (typeof v === 'string' ? v : '');
function pick(obj, ...keys) {
    for (const key of keys) {
        if (obj[key] !== undefined && obj[key] !== null)
            return obj[key];
    }
    return undefined;
}
function parseMentions(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.filter((item) => typeof item === 'string' && item.startsWith('@'));
}
function parseTimestampMs(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw))
        return raw;
    if (typeof raw === 'string' && raw.trim()) {
        const parsed = Date.parse(raw);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return Date.now();
}
const DEFAULT_MAX_TEXT = 16_000;
/**
 * Parses a raw Matrix/Narra event envelope into a normalized `InboundEvent`.
 * Handles `m.text`, `m.notice`, `m.image`, `m.reaction`, `m.replace` edits,
 * `m.room.redaction`, `ai.netmind.compound`, and `ai.netmind.rtc.agent.*` voice turns.
 * Strips Matrix reply fallbacks cleanly. Returns `null` for unsupported/ignored events.
 */
export function parseMatrixEvent(raw, defaults) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const outer = raw;
    const event = (outer.event && typeof outer.event === 'object' && !Array.isArray(outer.event)
        ? outer.event
        : outer);
    const content = (event.content && typeof event.content === 'object' && !Array.isArray(event.content)
        ? event.content
        : {});
    const unsigned = (event.unsigned && typeof event.unsigned === 'object' && !Array.isArray(event.unsigned)
        ? event.unsigned
        : {});
    const roomId = str(pick(event, 'room_id', 'roomId') ?? pick(outer, 'room_id', 'roomId')) ||
        (defaults?.roomId ?? '');
    const eventId = str(pick(event, 'event_id', 'eventId', 'message_id', 'messageId'));
    const senderId = str(pick(event, 'sender', 'sender_id', 'senderId'));
    if (!roomId.startsWith('!') || !eventId || !senderId.startsWith('@'))
        return null;
    const declaredChatType = str(pick(outer, 'chat_type', 'chatType') ?? pick(event, 'chat_type', 'chatType'));
    const chatType = declaredChatType === 'dm' ? 'dm' : declaredChatType === 'group' ? 'group' : (defaults?.chatType ?? 'group');
    const roomName = str(pick(outer, 'room_name', 'roomName') ?? pick(event, 'room_name', 'roomName')) ||
        defaults?.roomName ||
        undefined;
    const senderName = str(pick(outer, 'sender_name', 'senderName') ?? pick(event, 'sender_name', 'senderName')) ||
        defaults?.senderName ||
        undefined;
    const timestampMs = parseTimestampMs(pick(event, 'origin_server_ts', 'time', 'sent_at', 'received_at'));
    const timeIso = new Date(timestampMs).toISOString();
    const type = str(event.type) || 'm.room.message';
    const maxLen = defaults?.maxTextLength ?? DEFAULT_MAX_TEXT;
    // Redaction event: cancels/removes a previously sent event.
    if (type === 'm.room.redaction') {
        const relates = (content['m.relates_to'] ?? {});
        const redactsEventId = str(event.redacts ?? content.redacts ?? relates.event_id);
        if (!redactsEventId)
            return null;
        return {
            roomId,
            ...(roomName ? { roomName: roomName.slice(0, 200) } : {}),
            chatType,
            eventId,
            senderId,
            ...(senderName ? { senderName: senderName.slice(0, 200) } : {}),
            type,
            kind: 'redaction',
            text: '',
            timestampMs,
            timeIso,
            mentions: [],
            redactsEventId,
            ...(str(content.reason) ? { redactionReason: str(content.reason).slice(0, 64) } : {}),
            raw: event,
        };
    }
    // If the message itself was already redacted on server, treat it as a redaction signal if possible, else ignore.
    if (unsigned.redacted_because && typeof unsigned.redacted_because === 'object') {
        return {
            roomId,
            ...(roomName ? { roomName: roomName.slice(0, 200) } : {}),
            chatType,
            eventId,
            senderId,
            ...(senderName ? { senderName: senderName.slice(0, 200) } : {}),
            type: 'm.room.redaction',
            kind: 'redaction',
            text: '',
            timestampMs,
            timeIso,
            mentions: [],
            redactsEventId: eventId,
            raw: event,
        };
    }
    // Reaction event (m.reaction -> m.annotation)
    if (type === 'm.reaction') {
        const relates = (content['m.relates_to'] ?? {});
        if (str(relates.rel_type) !== 'm.annotation')
            return null;
        const replyToEventId = str(relates.event_id);
        const reactionKey = str(relates.key).slice(0, 32);
        if (!replyToEventId || !reactionKey)
            return null;
        const claimPriority = Number((content['ai.narra.claim'] ?? {}).priority);
        return {
            roomId,
            ...(roomName ? { roomName: roomName.slice(0, 200) } : {}),
            chatType,
            eventId,
            senderId,
            ...(senderName ? { senderName: senderName.slice(0, 200) } : {}),
            type,
            kind: 'reaction',
            text: reactionKey,
            timestampMs,
            timeIso,
            mentions: [],
            replyToEventId,
            reactionKey,
            ...(Number.isFinite(claimPriority) ? { claimPriority } : {}),
            raw: event,
        };
    }
    if (type !== 'm.room.message')
        return null;
    // Ignore hidden messages unless compound handling extracts them separately.
    const visibility = content['ai.netmind.visibility'];
    if (visibility?.status === 'hidden')
        return null;
    const relates = (content['m.relates_to'] ?? {});
    const relType = str(relates.rel_type);
    // Matrix edit (m.replace)
    if (relType === 'm.replace') {
        const replacesEventId = str(relates.event_id);
        if (!replacesEventId)
            return null;
        const newContent = (content['m.new_content'] && typeof content['m.new_content'] === 'object'
            ? content['m.new_content']
            : content);
        const msgtype = str(newContent.msgtype ?? content.msgtype) || 'm.text';
        if (msgtype !== 'm.text' && msgtype !== 'm.notice')
            return null;
        let body = str(newContent.body);
        if (!body && typeof content.body === 'string') {
            body = content.body.replace(/^\*\s+/, '');
        }
        const inReplyTo = str(newContent['m.relates_to']?.['m.in_reply_to']?.event_id)
            || str(relates['m.in_reply_to']?.event_id);
        if (inReplyTo)
            body = stripReplyFallback(body);
        if (!body.trim())
            return null;
        const mentionsRaw = newContent['m.mentions']?.user_ids ??
            content['m.mentions']?.user_ids ??
            pick(event, 'mentions');
        return {
            roomId,
            ...(roomName ? { roomName: roomName.slice(0, 200) } : {}),
            chatType,
            eventId,
            senderId,
            ...(senderName ? { senderName: senderName.slice(0, 200) } : {}),
            type,
            kind: 'edit',
            msgtype,
            text: body.slice(0, maxLen),
            timestampMs,
            timeIso,
            mentions: parseMentions(mentionsRaw),
            replacesEventId,
            ...(inReplyTo ? { replyToEventId: inReplyTo } : {}),
            raw: event,
        };
    }
    const msgtype = str(content.msgtype) || 'm.text';
    const voiceBlock = content['ai.netmind.rtc.agent.turn.started.v2'];
    const compoundBlock = content['ai.netmind.compound'];
    let kind;
    if (voiceBlock && typeof voiceBlock === 'object') {
        kind = 'voice';
    }
    else if (msgtype === 'm.text') {
        kind = 'text';
    }
    else if (msgtype === 'm.notice') {
        kind = 'notice';
    }
    else if (msgtype === 'm.image') {
        kind = 'image';
    }
    else if (msgtype === 'ai.netmind.compound' && compoundBlock) {
        kind = 'compound';
    }
    else {
        return null;
    }
    const replyToEventId = str((relates['m.in_reply_to'] ?? {}).event_id);
    let text = '';
    if (kind === 'voice' && voiceBlock) {
        text = str(voiceBlock.transcript) || str(pick(content, 'body') ?? pick(event, 'text', 'body'));
    }
    else if (kind === 'compound' && compoundBlock) {
        text = str(compoundBlock.text) || str(content.body);
    }
    else {
        text = str(pick(content, 'body') ?? pick(event, 'text', 'body'));
    }
    if (replyToEventId)
        text = stripReplyFallback(text);
    if (!text.trim() && kind !== 'image' && kind !== 'compound')
        return null;
    const mentionsRaw = content['m.mentions']?.user_ids ?? pick(event, 'mentions');
    const mediaUrl = kind === 'image'
        ? str(content.url) || undefined
        : kind === 'compound' && compoundBlock
            ? str(compoundBlock.media_url) || undefined
            : undefined;
    return {
        roomId,
        ...(roomName ? { roomName: roomName.slice(0, 200) } : {}),
        chatType,
        eventId,
        senderId,
        ...(senderName ? { senderName: senderName.slice(0, 200) } : {}),
        type,
        kind,
        msgtype,
        text: text.slice(0, maxLen),
        timestampMs,
        timeIso,
        mentions: parseMentions(mentionsRaw),
        ...(replyToEventId ? { replyToEventId } : {}),
        ...narraReplyMarkers(content),
        ...(voiceBlock
            ? {
                isVoice: true,
                voiceMeta: {
                    rtcSessionId: str(voiceBlock.rtc_session_id) || undefined,
                    turnId: str(voiceBlock.turn_id) || undefined,
                    transcript: str(voiceBlock.transcript) || undefined,
                },
            }
            : {}),
        ...(mediaUrl ? { mediaUrl } : {}),
        raw: event,
    };
}
const EXACT_SILENCE = /^\s*(?:\(empty response\)|no response(?: requested)?\.?|\[no[_ ]reply\]|\(no[_ ]reply\)|\[silent\]|\(silent\)|\.{0,3})\s*$/i;
const SILENT_NOTE = /^\s*[([（【]\s*(?:no[_ ]?(?:reply|response|answer)|silen(?:t|ce)|stay(?:s|ing)? (?:quiet|silent)|不回覆|不回复|不回應|不回应|保持安靜|保持安静)[^)\]）】\n]{0,100}[)\]）】]\s*$/i;
/**
 * Returns `true` when an agent answer represents intentional silence
 * (`(empty response)`, `[NO_REPLY]`, `[silent]`, `...`, whitespace, etc.).
 */
export function isSilence(answer) {
    const trimmed = (answer ?? '').trim();
    if (!trimmed)
        return true;
    return EXACT_SILENCE.test(trimmed) || SILENT_NOTE.test(trimmed);
}
const REASONING_TAGS = /^\s*<(?:thinking|thought|analysis|internal)>[\s\S]*?<\/(?:thinking|thought|analysis|internal)>\s*/i;
const NOTE_LINE_PREFIX = /^\s*(?:Thought|Thinking|Internal note|Note to self|Reasoning)\s*:\s*[^\n]+\n+/i;
const SEAM = /[a-z0-9)'"][.!?:](?=[A-Z#\u3400-\u9fff])/g;
/**
 * Strips leaked internal agent notes or reasoning tags glued ahead of the real user-facing answer.
 * Preserves URLs and currency amounts cleanly.
 */
export function stripLeakedNotes(answer) {
    let working = answer ?? '';
    const cuts = [];
    const tagMatch = working.match(REASONING_TAGS);
    if (tagMatch) {
        cuts.push(tagMatch[0].trim());
        working = working.slice(tagMatch[0].length);
    }
    const prefixMatch = working.match(NOTE_LINE_PREFIX);
    if (prefixMatch) {
        cuts.push(prefixMatch[0].trim());
        working = working.slice(prefixMatch[0].length);
    }
    const firstLine = working.split('\n', 1)[0] ?? '';
    if (/^[A-Z]/.test(firstLine)) {
        const cjk = firstLine.search(/[\u3400-\u9fff]/);
        const scope = cjk === -1 ? firstLine : firstLine.slice(0, cjk + 1);
        let end = -1;
        for (const seam of scope.matchAll(SEAM)) {
            if (seam.index !== undefined)
                end = seam.index + 2;
        }
        if (end > 0) {
            const candidateCut = working.slice(0, end);
            const rest = working.slice(end).trimStart();
            if (candidateCut.trim().split(/\s+/).length >= 4 && rest) {
                cuts.push(candidateCut.trim());
                working = rest;
            }
        }
    }
    return {
        text: working.trim(),
        cut: cuts.join(' | '),
    };
}
const MD_LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
// Any Markdown image whose target is not an absolute http(s) URL (sandbox paths like media/x.jpg or
// sticks/21-zh.jpg): chat clients cannot load it, so it would show as raw markup.
const SANDBOX_IMAGE_MD_RE = /!\[[^\]\n]*\]\(\s*(?!https?:\/\/)[^)\s]+\s*\)/gi;
const EMPTY_CODE_FENCE_RE = /```[a-zA-Z0-9_-]*\s*```/g;
const ORPHAN_PICTURES_LINE_RE = /(?:\b(?:(?:Their|The)\s+)?(?:cover\s+)?(?:pictures?|photos?|images?)\s+(?:follow(?:\s+below)?|are\s+(?:attached|listed|below|included)|appear\s+below)(?:\s+in\s+(?:the\s+same|that|this|listed)\s+order)?[.:!]?|(?:封面)?(?:圖片|图片|照片)(?:已|都)?(?:依序|按順序|按顺序|照順序|照顺序)?附在(?:後面|后面|下方)[。.!！]?)\s*/gi;
const NON_PAREN_WRAPPED_URL_RE = /([[\（【<《"'])(https?:\/\/[^\s<>[\]（）【】《》"']+?)([\]）】>》"'])/g;
const PAREN_WRAPPED_URL_RE = /\((https?:\/\/[^\s<>,;"'\u3000-\u303F\u3400-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s<>[\]"'\u3000-\u303F\u3400-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]+/g;
function splitUrlAndTrailingPunct(token) {
    let url = token;
    let trailing = '';
    while (url.length > 0) {
        const last = url[url.length - 1];
        if ('.,;:!?、。，；！？\'"】）]}》>'.includes(last)) {
            trailing = last + trailing;
            url = url.slice(0, -1);
            continue;
        }
        if (last === ')') {
            const opens = (url.match(/\(/g) ?? []).length;
            const closes = (url.match(/\)/g) ?? []).length;
            if (closes > opens) {
                trailing = ')' + trailing;
                url = url.slice(0, -1);
                continue;
            }
        }
        break;
    }
    return { url, trailing };
}
/**
 * Ensures URLs stay bare for Narra mobile rendering:
 * - Unwraps Markdown `[text](url)` links into plain text + bare URL
 * - Unwraps brackets/quotes around `(https://...)` or `（https://...）`
 * - Detaches trailing punctuation and adds spacing around bare URLs so clients tap cleanly
 */
export function sanitizeMobileLinks(text) {
    if (!text)
        return '';
    // 0. Remove unrenderable sandbox relative image links (e.g., ![cover](media/cover-xxx.jpg)), empty fences, and orphan captions
    let out = text
        .replace(SANDBOX_IMAGE_MD_RE, '')
        .replace(EMPTY_CODE_FENCE_RE, '')
        .replace(ORPHAN_PICTURES_LINE_RE, '');
    // 1. Unwrap Markdown links [label](https://...)
    out = out.replace(MD_LINK_RE, (_whole, rawLabel, rawUrl) => {
        const label = rawLabel.trim();
        const url = rawUrl.trim();
        if (!label || label === url || url.includes(label)) {
            return ` ${url} `;
        }
        if (/[:：]$/.test(label)) {
            return `${label} ${url} `;
        }
        return `${label}: ${url} `;
    });
    // 2. Unwrap non-paren wrappers like （https://...）, [https://...], "https://..."
    out = out.replace(NON_PAREN_WRAPPED_URL_RE, (_whole, _open, url) => ` ${url} `);
    // 3. Unwrap outer ASCII parentheses around URLs while keeping balanced inner parens like Wiki _(dish)
    out = out.replace(PAREN_WRAPPED_URL_RE, (whole, inner) => {
        const { url, trailing } = splitUrlAndTrailingPunct(inner);
        if (!url)
            return whole;
        return ` ${url}${trailing ? ` ${trailing}` : ' '}`;
    });
    // 4. Separate any remaining bare URL from attached adjacent text or trailing punctuation
    out = out.replace(BARE_URL_RE, (token, offset, full) => {
        const { url, trailing } = splitUrlAndTrailingPunct(token);
        const prev = offset > 0 ? full[offset - 1] : '';
        const nextIdx = offset + token.length;
        const next = nextIdx < full.length ? full[nextIdx] : '';
        const needsLeadingSpace = Boolean(prev && !/\s/.test(prev));
        const lead = needsLeadingSpace ? ' ' : '';
        if (trailing) {
            const needsAfter = Boolean(next && !/\s/.test(next));
            return `${lead}${url} ${trailing}${needsAfter ? ' ' : ''}`;
        }
        const needsAfter = Boolean(next && !/\s/.test(next));
        return `${lead}${url}${needsAfter ? ' ' : ''}`;
    });
    // Clean horizontal multi-spaces on each line and collapse excess blank lines while preserving newlines
    return out
        .split('\n')
        .map((line) => line.replace(/ {2,}/g, ' ').trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
/** Reads the invisible markers kit agents put on their own messages (see `messageContent`). */
export function narraReplyMarkers(content) {
    const answers = content['ai.narra.answers'];
    const answersEventId = answers && typeof answers === 'object' && typeof answers.event_id === 'string'
        ? answers.event_id
        : '';
    return {
        ...(answersEventId ? { answersEventId } : {}),
        ...(content['ai.narra.broadcast'] === true ? { isBroadcast: true } : {}),
    };
}
//# sourceMappingURL=guard.js.map