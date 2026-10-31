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

export type CreateSongInput = z.infer<typeof createSongSchema>;
export type CreateSampleInput = z.infer<typeof createSampleSchema>;
