import { isNarraAgent, sanitizeMobileLinks } from './guard.js';

const MENTION_TOKEN = /\[@([^\]\n]{1,60})\]\((@[A-Za-z0-9._=\-/+]+:[A-Za-z0-9.-]+(?::\d{1,5})?)\)/g;

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface RenderedMention {
  body: string;
  /** `org.matrix.custom.html` payload, or `null` when there is no human pill mention. */
  html: string | null;
  /** Human Matrix user IDs to include in `m.mentions.user_ids`. NEVER contains `@agent-*` or self. */
  userIds: string[];
}

/**
 * Turns `[@Name](@user:server)` markup into Matrix pill mentions (`m.mentions` + `matrix.to` HTML pill).
 * NEVER creates Matrix `@mentions` for `@agent-*` or `selfMatrixId` (to avoid agent mention loops).
 */
export function renderMentions(text: string, selfMatrixId = ''): RenderedMention {
  const userIds: string[] = [];
  let body = '';
  let html = '';
  let last = 0;

  for (const match of (text ?? '').matchAll(MENTION_TOKEN)) {
    const [whole, rawName, userId] = match;
    const name = rawName.trim().replace(/^@/, '');
    const idx = match.index ?? 0;
    const before = text.slice(last, idx);
    body += before;
    html += escapeHtml(before);

    if (userId === selfMatrixId || isNarraAgent(userId)) {
      // Render plain name only: never '@' prefix, never matrix.to link, never m.mentions.user_ids.
      body += name;
      html += escapeHtml(name);
    } else {
      body += `@${name}`;
      html += `<a href="https://matrix.to/#/${escapeHtml(userId)}">@${escapeHtml(name)}</a>`;
      if (!userIds.includes(userId)) userIds.push(userId);
    }
    last = idx + whole.length;
  }

  const tail = (text ?? '').slice(last);
  body += tail;
  html += escapeHtml(tail);

  return {
    body,
    html: userIds.length > 0 ? html.replace(/\n/g, '<br>') : null,
    userIds,
  };
}

/** Plain text version (for APIs without HTML pills). */
export function plainMentions(text: string, selfMatrixId = ''): string {
  return renderMentions(text, selfMatrixId).body;
}

export interface MessageContentOptions {
  selfMatrixId?: string;
  replyToEventId?: string;
  /** The message this one answers, kept even when not quoted, so peers know what was answered. */
  answersEventId?: string;
  /** A scheduled digest, not an answer to anyone. */
  broadcast?: boolean;
  sanitizeLinks?: boolean;
  msgtype?: 'm.text' | 'm.notice';
}

/**
 * Builds a Matrix `m.room.message` content object with safe mentions and optional reply relation.
 * Accepts either an options object or `(text, selfMatrixId, replyToEventId)`.
 */
export function messageContent(
  text: string,
  optionsOrSelfId: MessageContentOptions | string = {},
  replyToLegacy?: string,
): Record<string, unknown> {
  const opts: MessageContentOptions =
    typeof optionsOrSelfId === 'string'
      ? { selfMatrixId: optionsOrSelfId, replyToEventId: replyToLegacy }
      : optionsOrSelfId;

  const prepared = opts.sanitizeLinks === false ? text : sanitizeMobileLinks(text);
  const rendered = renderMentions(prepared, opts.selfMatrixId ?? '');

  return {
    msgtype: opts.msgtype ?? 'm.text',
    body: rendered.body,
    ...(rendered.html ? { format: 'org.matrix.custom.html', formatted_body: rendered.html } : {}),
    // Always present: empty m.mentions tells Synapse/clients not to infer mentions from body text.
    'm.mentions': rendered.userIds.length > 0 ? { user_ids: rendered.userIds } : {},
    ...(opts.replyToEventId
      ? { 'm.relates_to': { 'm.in_reply_to': { event_id: opts.replyToEventId } } }
      : {}),
    ...(opts.answersEventId ? { 'ai.narra.answers': { event_id: opts.answersEventId } } : {}),
    ...(opts.broadcast ? { 'ai.narra.broadcast': true } : {}),
  };
}

/**
 * Builds a Matrix `m.replace` edit payload replacing one of the agent's own earlier messages.
 */
export function editContent(
  eventId: string,
  text: string,
  optionsOrSelfId: MessageContentOptions | string = {},
): Record<string, unknown> {
  const opts: MessageContentOptions =
    typeof optionsOrSelfId === 'string' ? { selfMatrixId: optionsOrSelfId } : optionsOrSelfId;

  const prepared = opts.sanitizeLinks === false ? text : sanitizeMobileLinks(text);
  const rendered = renderMentions(prepared, opts.selfMatrixId ?? '');
  const mentions = rendered.userIds.length > 0 ? { user_ids: rendered.userIds } : {};

  const fresh: Record<string, unknown> = {
    msgtype: opts.msgtype ?? 'm.text',
    body: rendered.body,
    ...(rendered.html ? { format: 'org.matrix.custom.html', formatted_body: rendered.html } : {}),
    'm.mentions': mentions,
    ...(opts.replyToEventId
      ? { 'm.relates_to': { 'm.in_reply_to': { event_id: opts.replyToEventId } } }
      : {}),
  };

  return {
    msgtype: opts.msgtype ?? 'm.text',
    body: `* ${rendered.body}`,
    'm.new_content': fresh,
    'm.mentions': mentions,
    'm.relates_to': {
      rel_type: 'm.replace',
      event_id: eventId,
    },
  };
}
