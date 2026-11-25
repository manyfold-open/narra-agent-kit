/**
 * Showing a Manyfold reply while it is still being written: the first sentence appears as a message,
 * later text arrives as edits of that same message. Narra shows no "edited" label on agent messages
 * and merges the push notification, so to people it looks like someone typing a longer reply.
 */
import { parseBrainOutput } from './actions.js';

/** Do not show anything until this much reply text exists (avoids a one-word first message). */
export const STREAM_FIRST_CHARS = 24;
/** Then update at most this often... */
export const STREAM_EDIT_INTERVAL_MS = 1_500;
/** ...and only when the text grew by at least this much. */
export const STREAM_EDIT_MIN_GROWTH = 30;

const LEAKY_START = /^\s*(?:<|thought\b|thinking\b|reasoning\b|internal\b|note to self\b|analysis\b)/i;

/**
 * The part of a partial brain output that is safe to show, or null while it is not: an unfinished
 * or non-reply directive (silence, reaction), or something that may turn out to be leaked notes.
 */
export function streamableText(partial: string): string | null {
  const trimmed = (partial ?? '').trimStart();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) {
    if (!/\]/.test(trimmed)) return null; // directive still arriving
    const action = parseBrainOutput(trimmed);
    if (action.kind !== 'reply' || action.mode) return null;
    return action.text.trim() || null;
  }
  if (LEAKY_START.test(trimmed)) return null;
  return trimmed;
}

export interface StreamFlushInput {
  shown: string;
  next: string;
  msSinceLastFlush: number;
}

/** Whether to post (first time) or edit (later) the streamed message now. */
export function shouldFlushStream(input: StreamFlushInput): boolean {
  const { shown, next } = input;
  if (!shown) return next.length >= STREAM_FIRST_CHARS;
  return next.length - shown.length >= STREAM_EDIT_MIN_GROWTH && input.msSinceLastFlush >= STREAM_EDIT_INTERVAL_MS;
}
