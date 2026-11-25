/**
 * What the Manyfold brain can do with a turn in the v2 pipeline, and how it says so. The brain
 * decides everything about the reply, including staying silent; the Worker only carries it out.
 */
import { isSilence } from '../guard.js';
import { REPLY_MODES, type ReplyMode } from './ledger.js';

/** Reactions the brain may use instead of a text reply. */
export const ALLOWED_REACTIONS = ['❤️', '👍', '😂', '🙏', '🎉', '😮'] as const;

export type BrainAction =
  | { kind: 'silent' }
  | { kind: 'react'; emoji: string }
  | { kind: 'reply'; text: string; mode?: ReplyMode };

const DIRECTIVE_RE = /^\s*\[(NO_REPLY|REACT|MODE)(?:[\s:]+([^\]]*))?\]\s*/i;

/**
 * Parses the brain's output. A leading `[NO_REPLY]`, `[REACT ❤️]` or `[MODE mention]` line is a
 * directive; anything else is the reply text. Unknown or malformed directives are treated as text
 * with the directive stripped, so a model slip never leaks brackets into the chat.
 */
export function parseBrainOutput(raw: string): BrainAction {
  let text = (raw ?? '').trim();
  if (!text || isSilence(text)) return { kind: 'silent' };

  let mode: ReplyMode | undefined;
  for (let guard = 0; guard < 3; guard++) {
    const m = DIRECTIVE_RE.exec(text);
    if (!m) break;
    const name = m[1].toUpperCase();
    const arg = (m[2] ?? '').trim();
    text = text.slice(m[0].length).trim();
    if (name === 'NO_REPLY') return { kind: 'silent' };
    if (name === 'REACT') {
      const emoji = ALLOWED_REACTIONS.find((e) => arg.includes(e) || arg.includes(e.replace('️', '')));
      if (emoji && !text) return { kind: 'react', emoji };
      if (emoji && text) continue; // reaction plus text: just send the text
    }
    if (name === 'MODE') {
      const wanted = arg.toLowerCase() as ReplyMode;
      if ((REPLY_MODES as readonly string[]).includes(wanted)) mode = wanted;
    }
  }
  if (!text || isSilence(text)) {
    return mode ? { kind: 'reply', text: '', mode } : { kind: 'silent' };
  }
  return { kind: 'reply', text, ...(mode ? { mode } : {}) };
}

/** Instructions sent with every v2 turn. English on purpose: the brain replies in the user's language. */
export function chatBehaviourNote(opts: { chatType: 'dm' | 'group'; direct: boolean }): string {
  const lines = [
    'You are a member of a Narra Messenger chat where humans and AI agents talk together. Behave like a thoughtful person in a messenger, not like a website or a support bot.',
    'Reply in the language and script of the person you answer (Traditional vs Simplified Chinese matters).',
    opts.chatType === 'group'
      ? 'Group chat: keep it short (1-3 sentences, or at most 3 items). No headings, no long lists, no status lines like "let me check".'
      : 'Direct chat: be helpful and natural; a little longer is fine, but stay under 2000 characters.',
    'Do not repeat recommendations, facts or questions listed in your_recent_messages_here unless the person asks for them again. Ask at most one question, and only if you truly need the answer.',
    'Start your output with ONE directive line only when it applies:',
    '[NO_REPLY] - stay silent: people are chatting among themselves, another agent already covers it, or you have nothing useful to add.',
    `[REACT <emoji>] - acknowledge with only an emoji (one of ${ALLOWED_REACTIONS.join(' ')}), e.g. for thanks, praise or "ok".`,
    '[MODE mention] / [MODE ambient] / [MODE quiet] - the group asked you to change how often you speak (mention = only when @mentioned or replied to; ambient = also join in when you can clearly help; quiet = only short answers when called). Follow it with one short confirmation line.',
    'Otherwise write just the reply text.',
  ];
  if (opts.chatType === 'group' && !opts.direct) {
    lines.push(
      'Nobody addressed you directly: answer only if this is a real question or need you can clearly help with. If another agent in the room fits much better and nobody has answered, you may say so in one short line that names it with @ (for example "@Spotted London knows this better"), at most once per question.',
    );
  }
  return lines.join('\n');
}
