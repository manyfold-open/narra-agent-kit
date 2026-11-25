/**
 * Which pipeline handles a room's turns:
 * - `v1` (default): the existing triage + fastRespond/A2A pipeline.
 * - `shadow`: v1 answers; v2 only logs what it would have done (no extra Manyfold calls).
 * - `v2`: the chat-native pipeline answers.
 * `NARRA_PIPELINE_ROOMS` (comma-separated room ids) limits shadow/v2 to those rooms, so a live agent
 * can try v2 in a test room while every other room stays on v1.
 */
export type PipelineMode = 'v1' | 'shadow' | 'v2';
export interface PipelineEnv {
    NARRA_PIPELINE?: string;
    NARRA_PIPELINE_ROOMS?: string;
}
export declare function pipelineForRoom(env: PipelineEnv | undefined | null, roomId: string | undefined): PipelineMode;
/** Local hour (0-23) in a time zone, for "daytime only" posting rules. */
export declare function localHour(nowMs: number, timeZone?: string): number;
/** Start of the local calendar day containing `nowMs`, as epoch ms (approximate to the hour). */
export declare function localDayStartMs(nowMs: number, timeZone?: string): number;
//# sourceMappingURL=pipeline.d.ts.map