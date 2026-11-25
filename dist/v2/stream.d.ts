/** Do not show anything until this much reply text exists (avoids a one-word first message). */
export declare const STREAM_FIRST_CHARS = 24;
/** Then update at most this often... */
export declare const STREAM_EDIT_INTERVAL_MS = 1500;
/** ...and only when the text grew by at least this much. */
export declare const STREAM_EDIT_MIN_GROWTH = 30;
/**
 * The part of a partial brain output that is safe to show, or null while it is not: an unfinished
 * or non-reply directive (silence, reaction), or something that may turn out to be leaked notes.
 */
export declare function streamableText(partial: string): string | null;
export interface StreamFlushInput {
    shown: string;
    next: string;
    msSinceLastFlush: number;
}
/** Whether to post (first time) or edit (later) the streamed message now. */
export declare function shouldFlushStream(input: StreamFlushInput): boolean;
//# sourceMappingURL=stream.d.ts.map