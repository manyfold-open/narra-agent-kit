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
export function chatBehaviourNote(opts: {
  chatType: 'dm' | 'group';
  direct: boolean;
  replyLanguage?: string;
  proactive?: boolean;
  /** Woken as the room's stand-by: nobody answered and the better fits chose not to. */
  fallback?: boolean;
  /** Another agent's reply to current_message pointed to this agent. */
  handoff?: boolean;
}): string {
  const lines = [
    'You are a member of a Narra Messenger chat where humans and AI agents talk together. Behave like a thoughtful person in a messenger, not like a website or a support bot.',
    opts.replyLanguage
      ? `Write your reply in ${opts.replyLanguage}, the language of current_message, even if earlier messages, your data or your instructions use another language. Traditional and Simplified Chinese are different: never mix them. Do not comment on which languages you can use; just answer.`
      : 'Reply in the language and script of the person you answer (Traditional vs Simplified Chinese matters).',
    opts.chatType === 'group'
      ? 'Group chat: keep it short (1-3 sentences, or at most 3 items). No headings, no long lists, no status lines like "let me check".'
      : 'Direct chat: be helpful and natural; a little longer is fine, but stay under 2000 characters.',
    'Answer only current_message. earlier_unanswered_messages is background so you understand the room: do not answer those yourself (another agent may be on it). If one is clearly yours and has waited a long time, you may at most ask in one short line whether they still want it.',
    'Do not repeat recommendations, facts or questions listed in your_recent_messages_here unless the person asks for them again. Ask at most one question, and only if you truly need the answer.',
    'Thanks, praise, "ok", "got it" and similar acknowledgements: always answer with [REACT <emoji>] alone, never with text.',
    'Start your output with ONE directive line only when it applies:',
    '[NO_REPLY] - stay silent: people are chatting among themselves, another agent already covers it, or you have nothing useful to add.',
    `[REACT <emoji>] - acknowledge with only an emoji (one of ${ALLOWED_REACTIONS.join(' ')}), e.g. for thanks, praise or "ok".`,
    '[MODE mention] / [MODE ambient] / [MODE quiet] - the group asked you to change how often you speak (mention = only when @mentioned or replied to; ambient = also join in when you can clearly help; quiet = only short answers when called). Follow it with one short confirmation line.',
    'Otherwise write just the reply text.',
  ];
  if (opts.proactive) {
    lines.push(
      'Nobody wrote to you: this is your own scheduled turn, and current_message is your instruction for it, not something a person said. Post only if it is worth the group\'s attention right now; otherwise answer [NO_REPLY]. One short message, no greeting.',
    );
    return lines.join('\n');
  }
  if (opts.chatType === 'group' && opts.handoff) {
    lines.push(
      'Another agent in the room pointed to you for a person\'s question (current_message, or when current_message is that agent\'s line, the person\'s message just before it in conversation_so_far). Answer that question yourself now; do not point anywhere else.',
    );
    return lines.join('\n');
  }
  if (opts.chatType === 'group' && opts.fallback) {
    lines.push(
      'Nobody in the room has answered current_message, and the agents that fit it better chose not to. You are the room\'s stand-by.',
      '- If it is a real question or need, answer it yourself, briefly and helpfully, even if it is outside your speciality: general knowledge is fine, and say plainly if you cannot check live information. Do not only point to another agent.',
      '- If it is chatter, a reaction or an acknowledgement, or it continues a conversation another agent is clearly still handling, answer [NO_REPLY].',
    );
    return lines.join('\n');
  }
  if (opts.chatType === 'group' && !opts.direct) {
    lines.push(
      'Nobody @mentioned you, so judge from the room who current_message is for. Read your_open_question, sender_is_talking_with and conversation_so_far:',
      '- If it continues something you started (an answer to a question you asked, a follow-up to your last reply), it is yours. Answer it, even when it comes from a different person than the one you asked or minutes later, and even if it is only a word or two ("工作", "Holborn", "the second one"). Never answer [NO_REPLY] to an answer to your own question: carry on (do what you offered) or ask one short line to clarify.',
      '- If it continues another agent\'s conversation, leave it to that agent: [NO_REPLY].',
      '- Otherwise answer only if it is a real question or need you can clearly help with. If another agent in the room fits much better and nobody has answered, you may say so in one short line that names it with @ (for example "@Spotted London knows this better"), at most once per question.',
    );
  }
  return lines.join('\n');
}
