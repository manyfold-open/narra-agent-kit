/**
 * Do not show anything until this much reply text exists. Long enough that a short working note the
 * brain writes before a tool call ("Group and members exist. Add the entry.") is never posted.
 */
export declare const STREAM_FIRST_CHARS = 60;
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
/**
 * Tracks whether streamed text is one growing answer. A brain may write a working note, call a tool,
 * then replace it with the real answer; only text that has grown in place (a later chunk extends an
 * earlier one) is shown, and once the text is replaced the rest waits for the final reply.
 */
export interface StreamContinuity {
    last: string;
    grew: boolean;
    replaced: boolean;
}
export declare function newStreamContinuity(): StreamContinuity;
/** Records `partial` and says whether it may be shown now. */
export declare function continuousStreamText(state: StreamContinuity, partial: string, alreadyShown: boolean): boolean;
//# sourceMappingURL=stream.d.ts.map