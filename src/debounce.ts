import type { InboundEvent } from './types.js';

export const DEFAULT_COALESCE_WINDOW_MS = 1_800;

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

export type CoalescePushResult =
  | { status: 'buffered'; key: string; flushAtMs: number; fragmentCount: number }
  | { status: 'flushed'; key: string; event: InboundEvent }
  | { status: 'updated'; updated: boolean; key?: string }
  | { status: 'cancelled'; cancelled: boolean; empty?: boolean }
  | { status: 'bypass'; event: InboundEvent };

/** Merge a list of fragments from the same (roomId, senderId) into a single logical InboundEvent. */
export function mergeBurstFragments(fragments: InboundEvent[]): InboundEvent {
  if (fragments.length === 1) {
    const only = fragments[0];
    return {
      ...only,
      coalescedEventIds: only.coalescedEventIds ?? [only.eventId],
    };
  }
  const first = fragments[0];
  const last = fragments[fragments.length - 1];
  const mentions = [...new Set(fragments.flatMap((f) => f.mentions))];
  const replyToEventId = fragments.find((f) => f.replyToEventId)?.replyToEventId;
  const coalescedEventIds = fragments.flatMap((f) => f.coalescedEventIds ?? [f.eventId]);
  const text = fragments
    .map((f) => f.text.trim())
    .filter(Boolean)
    .join('\n');

  return {
    ...last,
    eventId: last.eventId,
    text,
    mentions,
    timestampMs: last.timestampMs,
    timeIso: last.timeIso,
    roomName: last.roomName ?? first.roomName,
    senderName: last.senderName ?? first.senderName,
    ...(replyToEventId ? { replyToEventId } : {}),
    coalescedEventIds,
  };
}

/**
 * Coalesces sequential short fragments from the same sender in the same room
 * within a configurable window (default 1800ms) into one logical turn.
 * Also handles in-flight edits (`m.replace`) and redactions (`m.room.redaction`).
 */
export class BurstCoalescer {
  private readonly windowMs: number;
  private readonly maxWaitMs: number;
  private readonly maxFragments: number;
  private readonly onFlush?: (merged: InboundEvent) => Promise<void> | void;
  private readonly scheduleTimers: boolean;
  private readonly now: () => number;

  private readonly buffers = new Map<string, PendingBurstBuffer>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: BurstCoalescerOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    this.maxWaitMs = options.maxWaitMs ?? this.windowMs * 4;
    this.maxFragments = options.maxFragments ?? 12;
    this.onFlush = options.onFlush;
    this.scheduleTimers = options.scheduleTimers ?? Boolean(options.onFlush);
    this.now = options.now ?? (() => Date.now());
  }

  private bufferKey(roomId: string, senderId: string): string {
    return `${roomId}::${senderId}`;
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  private armTimer(key: string, delayMs: number): void {
    if (!this.scheduleTimers) return;
    this.clearTimer(key);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.flushKey(key);
    }, Math.max(0, delayMs));
    this.timers.set(key, timer);
  }

  async push(event: InboundEvent): Promise<CoalescePushResult> {
    if (event.kind === 'redaction' && event.redactsEventId) {
      const outcome = this.cancelByEventId(event.roomId, event.redactsEventId);
      return { status: 'cancelled', cancelled: outcome.cancelled, empty: outcome.empty };
    }

    if (event.kind === 'edit' && event.replacesEventId) {
      const updated = this.applyEdit(event);
      return { status: 'updated', updated: updated.updated, key: updated.key };
    }

    if (event.kind === 'reaction' || event.kind === 'voice') {
      return { status: 'bypass', event };
    }

    const nowMs = this.now();
    const key = this.bufferKey(event.roomId, event.senderId);
    let buf = this.buffers.get(key);
    if (!buf) {
      buf = {
        key,
        roomId: event.roomId,
        senderId: event.senderId,
        firstSeenAtMs: nowMs,
        flushAtMs: nowMs + this.windowMs,
        fragments: [],
      };
      this.buffers.set(key, buf);
    }

    // Avoid duplicating the same event_id if delivered twice.
    if (!buf.fragments.some((f) => f.eventId === event.eventId)) {
      buf.fragments.push(event);
    }

    const maxDeadline = buf.firstSeenAtMs + this.maxWaitMs;
    buf.flushAtMs = Math.min(maxDeadline, nowMs + this.windowMs);

    if (buf.fragments.length >= this.maxFragments || buf.flushAtMs <= nowMs) {
      const merged = await this.flushKey(key);
      if (merged) {
        return { status: 'flushed', key, event: merged };
      }
    }

    this.armTimer(key, buf.flushAtMs - nowMs);
    return {
      status: 'buffered',
      key,
      flushAtMs: buf.flushAtMs,
      fragmentCount: buf.fragments.length,
    };
  }

  /** Cancels a buffered fragment (or entire queued turn if it was the only fragment) when redacted. */
  cancelByEventId(roomId: string, targetEventId: string): { cancelled: boolean; empty: boolean } {
    for (const [key, buf] of this.buffers.entries()) {
      if (buf.roomId !== roomId) continue;
      const idx = buf.fragments.findIndex((f) => f.eventId === targetEventId);
      if (idx === -1) continue;
      buf.fragments.splice(idx, 1);
      if (buf.fragments.length === 0) {
        this.clearTimer(key);
        this.buffers.delete(key);
        return { cancelled: true, empty: true };
      }
      return { cancelled: true, empty: false };
    }
    return { cancelled: false, empty: false };
  }

  /** Updates a buffered fragment in place if an `m.replace` edit arrives before flush. */
  applyEdit(editEvent: InboundEvent): { updated: boolean; key?: string } {
    if (!editEvent.replacesEventId) return { updated: false };
    for (const [key, buf] of this.buffers.entries()) {
      if (buf.roomId !== editEvent.roomId) continue;
      const idx = buf.fragments.findIndex((f) => f.eventId === editEvent.replacesEventId);
      if (idx === -1) continue;
      const prev = buf.fragments[idx];
      buf.fragments[idx] = {
        ...prev,
        text: editEvent.text,
        mentions: editEvent.mentions.length ? editEvent.mentions : prev.mentions,
        msgtype: editEvent.msgtype ?? prev.msgtype,
      };
      return { updated: true, key };
    }
    return { updated: false };
  }

  async flushKey(key: string): Promise<InboundEvent | null> {
    this.clearTimer(key);
    const buf = this.buffers.get(key);
    if (!buf || buf.fragments.length === 0) {
      this.buffers.delete(key);
      return null;
    }
    this.buffers.delete(key);
    const merged = mergeBurstFragments(buf.fragments);
    if (this.onFlush) {
      await this.onFlush(merged);
    }
    return merged;
  }

  async flushSender(roomId: string, senderId: string): Promise<InboundEvent | null> {
    return this.flushKey(this.bufferKey(roomId, senderId));
  }

  async flushDue(nowMs = this.now()): Promise<InboundEvent[]> {
    const dueKeys: string[] = [];
    for (const [key, buf] of this.buffers.entries()) {
      if (buf.flushAtMs <= nowMs) {
        dueKeys.push(key);
      }
    }
    const out: InboundEvent[] = [];
    for (const key of dueKeys) {
      const merged = await this.flushKey(key);
      if (merged) out.push(merged);
    }
    return out;
  }

  async flushAll(): Promise<InboundEvent[]> {
    const keys = [...this.buffers.keys()];
    const out: InboundEvent[] = [];
    for (const key of keys) {
      const merged = await this.flushKey(key);
      if (merged) out.push(merged);
    }
    return out;
  }

  nextFlushAt(): number | null {
    let min: number | null = null;
    for (const buf of this.buffers.values()) {
      if (min === null || buf.flushAtMs < min) min = buf.flushAtMs;
    }
    return min;
  }

  pendingCount(roomId?: string): number {
    if (!roomId) return this.buffers.size;
    let count = 0;
    for (const buf of this.buffers.values()) {
      if (buf.roomId === roomId) count++;
    }
    return count;
  }

  peek(roomId: string, senderId: string): PendingBurstBuffer | undefined {
    return this.buffers.get(this.bufferKey(roomId, senderId));
  }

  exportState(): PendingBurstBuffer[] {
    return [...this.buffers.values()].map((b) => ({
      ...b,
      fragments: [...b.fragments],
    }));
  }

  importState(buffers: PendingBurstBuffer[]): void {
    this.dispose();
    const nowMs = this.now();
    for (const buf of buffers) {
      if (!buf.fragments.length) continue;
      this.buffers.set(buf.key, {
        ...buf,
        fragments: [...buf.fragments],
      });
      this.armTimer(buf.key, buf.flushAtMs - nowMs);
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
