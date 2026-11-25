export function pipelineForRoom(env, roomId) {
    const raw = (env?.NARRA_PIPELINE ?? '').trim().toLowerCase();
    const mode = raw === 'v2' || raw === 'shadow' ? raw : 'v1';
    if (mode === 'v1')
        return 'v1';
    const rooms = (env?.NARRA_PIPELINE_ROOMS ?? '')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
    if (rooms.length === 0)
        return mode;
    return roomId && rooms.includes(roomId) ? mode : 'v1';
}
/** Local hour (0-23) in a time zone, for "daytime only" posting rules. */
export function localHour(nowMs, timeZone = 'Europe/London') {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs));
        const h = Number(parts.find((p) => p.type === 'hour')?.value);
        return Number.isFinite(h) ? h : new Date(nowMs).getUTCHours();
    }
    catch {
        return new Date(nowMs).getUTCHours();
    }
}
/** Start of the local calendar day containing `nowMs`, as epoch ms (approximate to the hour). */
export function localDayStartMs(nowMs, timeZone = 'Europe/London') {
    const d = new Date(nowMs);
    const minutes = d.getUTCMinutes();
    const seconds = d.getUTCSeconds();
    const ms = d.getUTCMilliseconds();
    return nowMs - (localHour(nowMs, timeZone) * 3600_000 + minutes * 60_000 + seconds * 1000 + ms);
}
//# sourceMappingURL=pipeline.js.map