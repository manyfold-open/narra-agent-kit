export const DEFAULT_COALESCE_WINDOW_MS = 1_800;
function burstTargetSignature(event) {
    if (event.mentions.length > 0) {
        return [...new Set(event.mentions)].sort().join(',');
    }
    const tokens = [
        ...(event.text ?? '').matchAll(/(?:^|\s)@(AI\s+(?:Fortune\s+Stick|Tarot|in\s+5)|Spotted\s+London|London\s+Chinese\s+Food|Manyfold\s+Data|[\p{L}\p{N}._=\-/+]+)/giu),
    ].map((m) => `text:${m[1].replace(/\s+/g, ' ').trim().toLowerCase()}`);
    return tokens.length > 0 ? [...new Set(tokens)].sort().join(',') : null;
}
function shouldSplitBurst(existing, incoming) {
    if (existing.length === 0)
        return false;
    const prevReplyTo = existing.find((f) => f.replyToEventId)?.replyToEventId;
    if (prevReplyTo && incoming.replyToEventId && incoming.replyToEventId !== prevReplyTo) {
        return true;
    }
    const nextSig = burstTargetSignature(incoming);
    if (nextSig === null) {
        // Follow-up fragment without a new @mention continues coalescing with the prior turn.
        return false;
    }
    const prevMentions = [...new Set(existing.flatMap((f) => f.mentions))].sort();
    const prevSig = prevMentions.length > 0 ? prevMentions.join(',') : burstTargetSignature(existing[0]);
    return nextSig !== prevSig;
}
/** Merge a list of fragments from the same (roomId, senderId) into a single logical InboundEvent. */
export function mergeBurstFragments(fragments) {
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
    windowMs;
    maxWaitMs;
    maxFragments;
    onFlush;
    scheduleTimers;
    now;
    buffers = new Map();
    timers = new Map();
    constructor(options = {}) {
        this.windowMs = options.windowMs ?? DEFAULT_COALESCE_WINDOW_MS;
        this.maxWaitMs = options.maxWaitMs ?? this.windowMs * 4;
        this.maxFragments = options.maxFragments ?? 12;
        this.onFlush = options.onFlush;
        this.scheduleTimers = options.scheduleTimers ?? Boolean(options.onFlush);
        this.now = options.now ?? (() => Date.now());
    }
    bufferKey(roomId, senderId) {
        return `${roomId}::${senderId}`;
    }
    clearTimer(key) {
        const timer = this.timers.get(key);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.timers.delete(key);
        }
    }
    armTimer(key, delayMs) {
        if (!this.scheduleTimers)
            return;
        this.clearTimer(key);
        const timer = setTimeout(() => {
            this.timers.delete(key);
            void this.flushKey(key);
        }, Math.max(0, delayMs));
        this.timers.set(key, timer);
    }
    async push(event) {
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
        let flushedPrior;
        if (buf && shouldSplitBurst(buf.fragments, event)) {
            const prior = await this.flushKey(key);
            if (prior)
                flushedPrior = prior;
            buf = undefined;
        }
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
            ...(flushedPrior ? { flushedPrior } : {}),
        };
    }
    /** Cancels a buffered fragment (or entire queued turn if it was the only fragment) when redacted. */
    cancelByEventId(roomId, targetEventId) {
        for (const [key, buf] of this.buffers.entries()) {
            if (buf.roomId !== roomId)
                continue;
            const idx = buf.fragments.findIndex((f) => f.eventId === targetEventId);
            if (idx === -1)
                continue;
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
    applyEdit(editEvent) {
        if (!editEvent.replacesEventId)
            return { updated: false };
        for (const [key, buf] of this.buffers.entries()) {
            if (buf.roomId !== editEvent.roomId)
                continue;
            const idx = buf.fragments.findIndex((f) => f.eventId === editEvent.replacesEventId);
            if (idx === -1)
                continue;
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
    async flushKey(key) {
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
    async flushSender(roomId, senderId) {
        return this.flushKey(this.bufferKey(roomId, senderId));
    }
    async flushDue(nowMs = this.now()) {
        const dueKeys = [];
        for (const [key, buf] of this.buffers.entries()) {
            if (buf.flushAtMs <= nowMs) {
                dueKeys.push(key);
            }
        }
        const out = [];
        for (const key of dueKeys) {
            const merged = await this.flushKey(key);
            if (merged)
                out.push(merged);
        }
        return out;
    }
    async flushAll() {
        const keys = [...this.buffers.keys()];
        const out = [];
        for (const key of keys) {
            const merged = await this.flushKey(key);
            if (merged)
                out.push(merged);
        }
        return out;
    }
    nextFlushAt() {
        let min = null;
        for (const buf of this.buffers.values()) {
            if (min === null || buf.flushAtMs < min)
                min = buf.flushAtMs;
        }
        return min;
    }
    pendingCount(roomId) {
        if (!roomId)
            return this.buffers.size;
        let count = 0;
        for (const buf of this.buffers.values()) {
            if (buf.roomId === roomId)
                count++;
        }
        return count;
    }
    peek(roomId, senderId) {
        return this.buffers.get(this.bufferKey(roomId, senderId));
    }
    exportState() {
        return [...this.buffers.values()].map((b) => ({
            ...b,
            fragments: [...b.fragments],
        }));
    }
    importState(buffers) {
        this.dispose();
        const nowMs = this.now();
        for (const buf of buffers) {
            if (!buf.fragments.length)
                continue;
            this.buffers.set(buf.key, {
                ...buf,
                fragments: [...buf.fragments],
            });
            this.armTimer(buf.key, buf.flushAtMs - nowMs);
        }
    }
    dispose() {
        for (const timer of this.timers.values())
            clearTimeout(timer);
        this.timers.clear();
    }
}
//# sourceMappingURL=debounce.js.map