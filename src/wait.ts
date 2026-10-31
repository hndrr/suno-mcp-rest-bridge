import { setTimeout as delay } from "node:timers/promises";
import type { JsonObject, JsonValue } from "./suno.js";
import { fields, isRecord } from "./upload.js";

// audio-wait accepts at most four IDs per call.
const maxIdsPerCall = 4;

export type WaitUntil = "playable" | "complete";

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<JsonValue>;

export type WaitOptions = {
  until: WaitUntil;
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
};

export type ClipRound = {
  clips: JsonObject[];
  pending: string[];
  timedOut: boolean;
  error?: unknown;
};

/** Read every clip ID a creation returned, as `clip_ids` or a single `id`. */
export function clipIdsFrom(result: JsonValue): string[] {
  if (!isRecord(result)) return [];
  const data = fields(result);
  if (Array.isArray(data.clip_ids)) {
    return data.clip_ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  return typeof data.id === "string" && data.id.length > 0 ? [data.id] : [];
}

function clipsFrom(result: JsonValue): JsonObject[] {
  if (!isRecord(result)) return [];
  const data = fields(result) as JsonObject;
  const clips = Array.isArray(data.clips) ? data.clips : [data];
  return clips.filter((clip): clip is JsonObject => isRecord(clip) && typeof clip.id === "string");
}

function isSettled(clip: JsonObject, until: WaitUntil): boolean {
  // Suno reports a clip it couldn't read as its id and error, with no status.
  if (clip.status === undefined) return Boolean(clip.error);
  return clip.status === "complete" || clip.status === "error" ||
    (until === "playable" && clip.status === "streaming");
}

/** Repeat audio-wait until every clip settles, yielding what each round returned. */
export async function* pollClips(
  callTool: CallTool,
  ids: string[],
  { until, timeoutMs, pollMs, signal }: WaitOptions
): AsyncGenerator<ClipRound> {
  const deadline = Date.now() + timeoutMs;
  let pending = [...new Set(ids)];
  for (;;) {
    const batches: string[][] = [];
    for (let i = 0; i < pending.length; i += maxIdsPerCall) {
      batches.push(pending.slice(i, i + maxIdsPerCall));
    }
    const rounds = await Promise.allSettled(
      batches.map((batch) => callTool("audio-wait", { ids: batch, until }))
    );
    const clips = rounds.flatMap((round) => round.status === "fulfilled" ? clipsFrom(round.value) : []);
    const failed = rounds.find((round) => round.status === "rejected");
    const latest = new Map(clips.map((clip) => [clip.id, clip]));
    pending = pending.filter((id) => {
      const clip = latest.get(id);
      return !clip || !isSettled(clip, until);
    });
    const timedOut = !failed && pending.length > 0 && Date.now() >= deadline;
    yield { clips, pending, timedOut, ...(failed ? { error: failed.reason } : {}) };
    if (failed || pending.length === 0 || timedOut || signal?.aborted) return;
    await delay(pollMs);
  }
}

/** Wait for clips and keep each one's latest state. Failures are returned, never thrown. */
export async function waitForClips(
  callTool: CallTool,
  ids: string[],
  options: WaitOptions
): Promise<ClipRound> {
  const latest = new Map<string, JsonObject>();
  let last: ClipRound = { clips: [], pending: ids, timedOut: false };
  for await (const round of pollClips(callTool, ids, options)) {
    for (const clip of round.clips) latest.set(clip.id as string, clip);
    last = round;
  }
  return { ...last, clips: [...latest.values()] };
}
