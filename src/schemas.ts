import { z } from "zod";

const boundedId = z.string().trim().min(1).max(255);
const idempotencyKey = z.string().min(1).max(255).regex(/\S/, "Must contain a non-whitespace character");
const duration = z.number().int().min(15).max(360);

export const controlsSchema = z.object({
  audio_influence: z.number().min(0).max(1).optional(),
  style_influence: z.number().min(0).max(1).optional(),
  weirdness: z.number().min(0).max(1).optional()
}).strict();

const createSongFields = {
  description: z.string().trim().min(1).max(3000).optional(),
  lyrics: z.string().min(1).max(5000).optional(),
  style: z.string().min(1).max(1000).optional(),
  title: z.string().min(1).max(256).optional(),
  instrumental: z.boolean().optional(),
  duration: duration.optional(),
  duration_guidance: z.boolean().optional(),
  duration_strict: z.boolean().optional(),
  model: z.string().min(1).optional(),
  negative_style: z.string().min(1).max(1000).optional(),
  vocal_gender: z.enum(["male", "female"]).optional(),
  voice_id: boundedId.optional(),
  workspace_id: z.string().uuid().optional(),
  controls: controlsSchema.optional(),
  idempotency_key: idempotencyKey.optional()
};

type SongModeInput = {
  description?: string;
  lyrics?: string;
  style?: string;
  negative_style?: string;
  instrumental?: boolean;
  duration?: number;
  duration_guidance?: boolean;
  duration_strict?: boolean;
  voice_id?: string;
  controls?: z.infer<typeof controlsSchema>;
};

type SongModeIssue = { path: string[]; message: string };

function songModeIssues(song: SongModeInput): SongModeIssue[] {
  const issues: SongModeIssue[] = [];
  if (song.description && (
    song.style || song.negative_style || (song.lyrics && song.instrumental !== true)
  )) {
    issues.push({
      path: ["description"],
      message: "Simple mode cannot combine description with style or negative_style, or lyrics unless instrumental=true"
    });
  }
  if (!song.description && !song.lyrics && song.instrumental !== true) {
    issues.push({
      path: ["lyrics"],
      message: "Provide description or lyrics, or set instrumental=true"
    });
  }
  if (song.controls?.audio_influence !== undefined && !song.voice_id) {
    issues.push({
      path: ["controls", "audio_influence"],
      message: "audio_influence on a new song requires voice_id; for a source clip use /cover, /mashup or /extend"
    });
  }
  if (song.duration === undefined &&
      (song.duration_strict !== undefined || song.duration_guidance !== undefined)) {
    issues.push({
      path: ["duration"],
      message: "duration_strict and duration_guidance require duration"
    });
  }
  return issues;
}

export const createSongSchema = z.object(createSongFields).strict().superRefine((song, ctx) => {
  for (const issue of songModeIssues(song)) ctx.addIssue({ code: "custom", ...issue });
});

export const createSampleSchema = z.object({
  ...createSongFields,
  duration: z.number().int().min(15).max(60).default(15),
  duration_guidance: z.boolean().default(true),
  duration_strict: z.boolean().default(true)
}).strict().superRefine((song, ctx) => {
  for (const issue of songModeIssues(song)) ctx.addIssue({ code: "custom", ...issue });
});

const remixFields = {
  controls: controlsSchema.optional(),
  duration: duration.optional(),
  idempotency_key: idempotencyKey.optional(),
  lyrics: z.string().min(1).max(5000).optional(),
  model: z.string().min(1).optional(),
  negative_style: z.string().min(1).max(1000).optional(),
  style: z.string().min(1).max(1000).optional(),
  workspace_id: z.string().uuid().optional()
};

export const createCoverSchema = z.object({
  ...remixFields,
  voice_id: boundedId.optional()
}).strict();

export const createMashupSchema = z.object({
  ...remixFields,
  additional_audio_id: boundedId,
  title: z.string().min(1).max(256).optional()
}).strict();

export const createExtensionSchema = z.object({
  ...remixFields,
  continue_at: z.number().min(0.4),
  instrumental: z.boolean().optional(),
  title: z.string().min(1).max(256).optional(),
  voice_id: boundedId.optional()
}).strict();

export const fullSongSchema = z.object({
  idempotency_key: idempotencyKey.optional()
}).strict();

export const uploadSessionSchema = z.object({
  title: z.string().trim().min(1).max(256).optional()
}).strict();

export const uploadCreateSchema = uploadSessionSchema.extend({
  // Match the upstream attachment contract: strings plus optional provider metadata.
  file: z.object({
    download_url: z.string(),
    file_id: z.string(),
    file_name: z.string().optional(),
    mime_type: z.string().optional()
  }).loose().optional()
});

const libraryFields = {
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  downloaded: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  liked: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  origin: z.enum(["upload", "cover", "extension", "remaster"]).optional(),
  visibility: z.enum(["public", "private"]).optional(),
  workspace_id: z.string().uuid().optional()
};

export const libraryQuerySchema = z.object({
  ...libraryFields,
  query: z.string().min(1).max(200).optional()
}).strict();

export const likedQuerySchema = z.object({
  cursor: libraryFields.cursor,
  limit: libraryFields.limit
}).strict();

export const waitQuerySchema = z.object({
  until: z.enum(["playable", "complete"]).default("playable")
}).strict();

export const waitBodySchema = waitQuerySchema.extend({
  id: boundedId.optional(),
  ids: z.array(boundedId).min(1).max(4).transform((ids) => [...new Set(ids)]).optional()
}).refine((body) => (body.id !== undefined) !== (body.ids !== undefined), {
  message: "Provide exactly one of id or ids",
  path: ["ids"]
});

export const defaultWaitSeconds = 300;
const waitSeconds = z.coerce.number().int().min(1).max(600);
const untilField = z.enum(["playable", "complete"]);
// Each batch of four IDs is one concurrent upstream call, so this caps them at five.
const waitIds = z.array(boundedId).min(1).max(20).transform((ids) => [...new Set(ids)]);

export const createQuerySchema = z.object({
  wait: untilField.optional(),
  timeout: waitSeconds.optional()
}).strict().refine((query) => query.timeout === undefined || query.wait !== undefined, {
  message: "timeout requires wait",
  path: ["timeout"]
});

export const waitAllSchema = z.object({
  ids: waitIds,
  until: untilField.default("playable"),
  timeout: waitSeconds.default(defaultWaitSeconds)
}).strict();

export const eventsQuerySchema = z.object({
  ids: z.string().transform((ids) => ids.split(",")).pipe(waitIds),
  until: untilField.default("playable"),
  timeout: waitSeconds.default(defaultWaitSeconds)
}).strict();

// IDs reach the page's HTML and URLs, so only UUIDs are accepted here.
export const previewQuerySchema = z.object({
  ids: z.string()
    .transform((ids) => ids.split(","))
    .pipe(z.array(z.string().uuid()).min(1).max(20).transform((ids) => [...new Set(ids)]))
}).strict();

export const createSpeechSchema = z.object({
  script: z.string().min(1).max(5000).optional(),
  prompt: z.string().trim().min(1).max(2947).optional(),
  backing_music: z.boolean().optional(),
  duration: duration.optional(),
  duration_guidance: z.boolean().optional(),
  duration_strict: z.boolean().optional(),
  idempotency_key: idempotencyKey.optional(),
  negative_style: z.string().min(1).max(1000).optional(),
  style: z.string().min(1).max(1000).optional(),
  title: z.string().min(1).max(256).optional(),
  vocal_gender: z.enum(["male", "female"]).optional(),
  voice_id: boundedId.optional(),
  workspace_id: z.string().uuid().optional()
}).strict().superRefine((speech, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  if ((speech.script === undefined) === (speech.prompt === undefined)) {
    issue("script", "Provide exactly one of script or prompt");
  }
  if (speech.prompt !== undefined && (speech.style !== undefined || speech.negative_style !== undefined)) {
    issue("prompt", "style and negative_style require script");
  }
  if (speech.backing_music && speech.prompt !== undefined && speech.prompt.length > 2887) {
    issue("prompt", "prompt is limited to 2887 characters with backing_music");
  }
  if (speech.duration === undefined &&
      (speech.duration_strict !== undefined || speech.duration_guidance !== undefined)) {
    issue("duration", "duration_strict and duration_guidance require duration");
  }
});

export const downloadSchema = z.object({
  format: z.enum(["mp3", "wav"]).optional(),
  confirm: z.boolean().optional()
}).strict();

export const editSongSchema = z.object({
  title: z.string().optional(),
  lyrics: z.string().optional()
}).strict().refine((edit) => edit.title !== undefined || edit.lyrics !== undefined, {
  message: "Provide title or lyrics",
  path: ["title"]
});

export const voicesQuerySchema = z.object({
  collection: z.enum(["own", "loved"]).optional(),
  cursor: libraryFields.cursor,
  limit: z.coerce.number().int().min(1).max(100).optional(),
  query: z.string().min(1).max(200).optional()
}).strict();

export const playlistsQuerySchema = z.object({
  cursor: libraryFields.cursor,
  limit: libraryFields.limit,
  query: z.string().min(1).max(200).optional()
}).strict();

export const createPlaylistSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  visibility: z.enum(["public", "private"]).optional()
}).strict();

export const playlistClipsQuerySchema = z.object({
  cursor: libraryFields.cursor,
  limit: libraryFields.limit
}).strict();

export const playlistClipsSchema = z.object({
  clip_ids: z.array(boundedId).min(1).max(100)
}).strict();

export const workspacesQuerySchema = z.object({
  cursor: libraryFields.cursor,
  query: z.string().min(1).max(200).optional()
}).strict();

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional()
}).strict();

export const updateWorkspaceClipsSchema = z.object({
  add: z.array(boundedId).max(50).optional(),
  remove: z.array(boundedId).max(50).optional()
}).strict().refine((update) => Boolean(update.add?.length || update.remove?.length), {
  message: "Provide songs in add or remove",
  path: ["add"]
});

export type CreateSongInput = z.infer<typeof createSongSchema>;
export type CreateSampleInput = z.infer<typeof createSampleSchema>;
