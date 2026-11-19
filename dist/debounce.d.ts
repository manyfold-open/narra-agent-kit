import type { InboundEvent } from './types.js';
export declare const DEFAULT_COALESCE_WINDOW_MS = 1800;
export interface BurstCoalescerOptions {
    /** Merge window between consecutive fragments from the same sender in the same room. Default 1800ms. */
    windowMs?: number;
    /** Maximum total wait from the first fragment in a burst. Default 4 * windowMs. */
    maxWaitMs?: number;
    /** Maximum number of fragments merged before forcing flush. Default 12. */
    maxFragments?: number;
    /** Optional callback invoked when a burst flushes (via timer or flushDue/flushAll). */
    onFlush?: (merged: InboundEvent) => Promise<void> | void;
    /** Whether to arm JS setTimeout timers automatically (disable in DO alarm mode). */
    scheduleTimers?: boolean;
    /** Injectable clock for deterministic testing. */
    now?: () => number;
}
export interface PendingBurstBuffer {
    key: string;
    roomId: string;
    senderId: string;
    firstSeenAtMs: number;
    flushAtMs: number;
    fragments: InboundEvent[];
}
export type CoalescePushResult = {
    status: 'buffered';
    key: string;
    flushAtMs: number;
    fragmentCount: number;
} | {
    status: 'flushed';
    key: string;
    event: InboundEvent;
} | {
    status: 'updated';
    updated: boolean;
    key?: string;
} | {
    status: 'cancelled';
    cancelled: boolean;
    empty?: boolean;
} | {
    status: 'bypass';
    event: InboundEvent;
};
/** Merge a list of fragments from the same (roomId, senderId) into a single logical InboundEvent. */
export declare function mergeBurstFragments(fragments: InboundEvent[]): InboundEvent;
/**
 * Coalesces sequential short fragments from the same sender in the same room
 * within a configurable window (default 1800ms) into one logical turn.
 * Also handles in-flight edits (`m.replace`) and redactions (`m.room.redaction`).
 */
export declare class BurstCoalescer {
    private readonly windowMs;
    private readonly maxWaitMs;
    private readonly maxFragments;
    private readonly onFlush?;
    private readonly scheduleTimers;
    private readonly now;
    private readonly buffers;
    private readonly timers;
    constructor(options?: BurstCoalescerOptions);
    private bufferKey;
    private clearTimer;
    private armTimer;
    push(event: InboundEvent): Promise<CoalescePushResult>;
    /** Cancels a buffered fragment (or entire queued turn if it was the only fragment) when redacted. */
    cancelByEventId(roomId: string, targetEventId: string): {
        cancelled: boolean;
        empty: boolean;
    };
    /** Updates a buffered fragment in place if an `m.replace` edit arrives before flush. */
    applyEdit(editEvent: InboundEvent): {
        updated: boolean;
        key?: string;
    };
    flushKey(key: string): Promise<InboundEvent | null>;
    flushSender(roomId: string, senderId: string): Promise<InboundEvent | null>;
    flushDue(nowMs?: number): Promise<InboundEvent[]>;
    flushAll(): Promise<InboundEvent[]>;
    nextFlushAt(): number | null;
    pendingCount(roomId?: string): number;
    peek(roomId: string, senderId: string): PendingBurstBuffer | undefined;
    exportState(): PendingBurstBuffer[];
    importState(buffers: PendingBurstBuffer[]): void;
    dispose(): void;
}
//# sourceMappingURL=debounce.d.ts.map