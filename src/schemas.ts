import { z } from "zod";

const boundedId = z.string().trim().min(1).max(255);
const idempotencyKey = z.string().min(1).max(255).regex(/\S/, "Must contain a non-whitespace character");
const duration = z.number().int().min(15).max(360);

export const emptyBodySchema = z.object({}).strict();
export const maxWaitIdsPerCall = 12;

export const controlsSchema = z.object({
  audio_influence: z.number().min(0).max(1).optional(),
  style_influence: z.number().min(0).max(1).optional(),
  variety: z.number().int().min(0).max(4).optional(),
  weirdness: z.number().min(0).max(1).optional()
}).strict();

const createSongFields = {
  description: z.string().trim().min(1).max(3000).optional(),
  reference_audio_ids: z.array(boundedId).max(10).refine((ids) => new Set(ids).size === ids.length, {
    message: "reference_audio_ids must be unique"
  }).optional(),
  lyrics: z.string().min(1).max(5000).optional(),
  style: z.string().min(1).max(1000).optional(),
  title: z.string().min(1).max(256).optional(),
  instrumental: z.boolean().optional(),
  max_mode: z.boolean().optional(),
  midi_upload_id: boundedId.optional(),
  duration: duration.optional(),
  duration_guidance: z.boolean().optional(),
  duration_strict: z.boolean().optional(),
  model: z.string().min(1).optional(),
  custom_model_id: z.string().optional(),
  negative_style: z.string().min(1).max(1000).optional(),
  vocal_gender: z.enum(["male", "female"]).optional(),
  voice_id: boundedId.optional(),
  workspace_id: z.string().uuid().optional(),
  controls: controlsSchema.optional(),
  idempotency_key: idempotencyKey.optional()
};

type SongModeInput = {
  description?: string;
  reference_audio_ids?: string[];
  lyrics?: string;
  style?: string;
  negative_style?: string;
  instrumental?: boolean;
  midi_upload_id?: string;
  duration?: number;
  duration_guidance?: boolean;
  duration_strict?: boolean;
  voice_id?: string;
  controls?: z.infer<typeof controlsSchema>;
};

type SongModeIssue = { path: string[]; message: string };

function songModeIssues(song: SongModeInput): SongModeIssue[] {
  const issues: SongModeIssue[] = [];
  if (song.reference_audio_ids?.length && (
    (!song.description && !song.midi_upload_id) || song.lyrics !== undefined || song.style !== undefined || song.negative_style !== undefined
  )) {
    issues.push({
      path: ["reference_audio_ids"],
      message: "Reference audio requires description or midi_upload_id in simple mode, without lyrics, style or negative_style"
    });
  }
  if (song.description && (
    song.style || song.negative_style || (song.lyrics && song.instrumental !== true)
  )) {
    issues.push({
      path: ["description"],
      message: "Simple mode cannot combine description with style or negative_style, or lyrics unless instrumental=true"
    });
  }
  if (!song.description && !song.lyrics && !song.midi_upload_id && song.instrumental !== true) {
    issues.push({
      path: ["lyrics"],
      message: "Provide description, lyrics or midi_upload_id, or set instrumental=true"
    });
  }
  if (song.midi_upload_id) {
    if (song.lyrics !== undefined || song.style !== undefined || song.negative_style !== undefined) {
      issues.push({ path: ["midi_upload_id"], message: "MIDI requires simple mode, without lyrics, style or negative_style" });
    }
    // MIDI model compatibility lives in upstream prose, which schema monitoring ignores.
    // Let Suno enforce it so newly supported account models are not rejected locally.
    if ((song.reference_audio_ids?.length ?? 0) >= 10) {
      issues.push({ path: ["reference_audio_ids"], message: "MIDI counts as one of the 10 reference inputs; provide at most 9 audio IDs" });
    }
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
  max_mode: z.boolean().optional(),
  idempotency_key: idempotencyKey.optional(),
  lyrics: z.string().min(1).max(5000).optional(),
  model: z.string().min(1).optional(),
  custom_model_id: z.string().optional(),
  negative_style: z.string().min(1).max(1000).optional(),
  style: z.string().min(1).max(1000).optional(),
  workspace_id: z.string().uuid().optional()
};

export const createCoverSchema = z.object({
  ...remixFields,
  title: z.string().min(1).max(256).optional(),
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

export const listenSchema = z.object({
  question: z.string().trim().min(1).max(2000)
}).strict();

export const likeSchema = z.object({
  dislike: z.boolean().optional()
}).strict();

export const createSoundSchema = z.object({
  description: z.string().trim().min(1).max(500),
  loop: z.boolean().optional(),
  tempo: z.number().int().min(1).max(300).optional(),
  key: z.enum([
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    "Cm", "C#m", "Dm", "D#m", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "A#m", "Bm"
  ]).optional(),
  title: z.string().min(1).max(256).optional(),
  idempotency_key: idempotencyKey.optional()
}).strict();

export const uploadSessionSchema = z.object({
  title: z.string().trim().min(1).max(256).optional()
}).strict();

// Match the upstream attachment contract: strings plus optional provider metadata.
const attachmentSchema = z.object({
  download_url: z.string(),
  file_id: z.string(),
  file_name: z.string().optional(),
  mime_type: z.string().optional()
}).loose();

export const uploadCreateSchema = uploadSessionSchema.extend({
  file: attachmentSchema.optional()
});

export const midiUploadCreateSchema = z.object({ file: attachmentSchema.optional() }).strict();

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
  ids: z.array(boundedId).min(1).max(maxWaitIdsPerCall).transform((ids) => [...new Set(ids)]).optional()
}).refine((body) => (body.id !== undefined) !== (body.ids !== undefined), {
  message: "Provide exactly one of id or ids",
  path: ["ids"]
});

export const defaultWaitSeconds = 300;
const waitSeconds = z.coerce.number().int().min(1).max(600);
const untilField = z.enum(["playable", "complete"]);
// Up to 20 IDs means at most two concurrent upstream calls, with 12 IDs per call.
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
  lyrics: z.string().optional(),
  caption: z.string().max(500).optional()
}).strict().refine((edit) => edit.title !== undefined || edit.lyrics !== undefined || edit.caption !== undefined, {
  message: "Provide title, lyrics or caption",
  path: ["title"]
});

export const songSettingsSchema = z.object({
  visibility: z.enum(["public", "private"]).optional(),
  can_remix: z.boolean().optional()
}).strict().refine((settings) => settings.visibility !== undefined || settings.can_remix !== undefined, {
  message: "Provide visibility or can_remix",
  path: ["visibility"]
});

export const createStemsSchema = z.object({
  mode: z.enum(["two", "twelve"]),
  idempotency_key: idempotencyKey.optional()
}).strict();

export const voicesQuerySchema = z.object({
  collection: z.enum(["own", "loved"]).optional(),
  cursor: libraryFields.cursor,
  limit: z.coerce.number().int().min(1).max(100).optional(),
  query: z.string().min(1).max(200).optional()
}).strict();

export const customModelsQuerySchema = z.object({
  collection: z.enum(["own", "shared"]).optional(),
  cursor: z.string().optional(),
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

const visualAspect = z.enum(["1:1", "9:16", "16:9"]);
const visualView = z.enum(["full", "summary"]);
const queryBoolean = z.enum(["true", "false"]).transform((value) => value === "true");

export const charactersQuerySchema = z.object({
  presets: queryBoolean.optional()
}).strict();

export const visualLibraryQuerySchema = z.object({
  cursor: z.string().optional(),
  liked: queryBoolean.optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  media_type: z.enum(["image", "video"]).optional(),
  sequence_id: z.string().optional(),
  song_id: z.string().optional()
}).strict();

export const visualShowQuerySchema = z.object({
  at: z.string().optional(),
  ids: z.string().optional()
}).strict();

export const visualWaitSchema = z.object({
  ids: z.string().optional(),
  view: visualView.optional()
}).strict();

const visualGenerationFields = {
  aspect: visualAspect.optional(),
  dry_run: z.boolean().optional(),
  idempotency_key: idempotencyKey.optional(),
  model: z.string().optional()
};

const visualPromptFields = {
  ...visualGenerationFields,
  prompt: z.string(),
  sequence_id: z.string().optional(),
  shot_id: z.string().optional()
};

export const createImageSchema = z.object(visualPromptFields).strict();

export const createVideoSchema = z.object({
  ...visualPromptFields,
  duration_s: z.number().int().min(5).max(15).optional(),
  first_frame_asset_id: z.string().optional(),
  last_frame_asset_id: z.string().optional(),
  lip_sync: z.boolean().optional(),
  resolution: z.string().optional(),
  song_id: z.string().optional(),
  song_start_s: z.number().min(0).optional()
}).strict();

export const assembleVideoSchema = z.object({
  aspect: visualAspect.optional(),
  clips: z.array(z.looseObject({
    asset_id: z.string(),
    duration_s: z.number().positive().max(60).optional(),
    trim_end_s: z.number().optional(),
    trim_start_s: z.number().min(0).optional()
  })).min(1).max(40),
  idempotency_key: idempotencyKey.optional(),
  lyrics: z.boolean().optional(),
  song_id: z.string(),
  song_start_s: z.number().min(0).optional()
}).strict();

export const sequencesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
  query: z.string().optional()
}).strict();

export const sequenceQuerySchema = z.object({
  view: visualView.optional()
}).strict();

const sequenceReference = z.looseObject({
  asset_ids: z.array(z.string()).min(1).max(3),
  description: z.string().max(500).optional(),
  name: z.string().max(60)
});

const sequenceShotFields = {
  characters: z.array(z.string()).optional(),
  notes: z.string().max(1000).optional(),
  set: z.string().optional()
};

const sequenceStyle = z.looseObject({});

export const createSequenceSchema = z.object({
  aspect: visualAspect.optional(),
  characters: z.array(sequenceReference).max(12).optional(),
  idempotency_key: idempotencyKey.optional(),
  lyrics: z.boolean().optional(),
  sets: z.array(sequenceReference).max(12).optional(),
  shots: z.array(z.looseObject({
    ...sequenceShotFields,
    duration_s: z.number().positive().max(15)
  })).min(1).max(200),
  song_id: z.string().optional(),
  song_start_s: z.number().min(0).optional(),
  style: sequenceStyle.optional(),
  title: z.string().optional()
}).strict();

const sequenceReferenceUpdate = sequenceReference.partial({ asset_ids: true }).extend({
  delete: z.boolean().optional()
});

export const updateSequenceSchema = z.object({
  characters: z.array(sequenceReferenceUpdate).optional(),
  idempotency_key: idempotencyKey.optional(),
  ops: z.array(z.looseObject({
    action: z.enum(["move", "delete", "trim", "split", "add"]),
    after_shot_id: z.string().optional(),
    asset_id: z.string().optional(),
    at_s: z.number().positive().optional(),
    duration_s: z.number().positive().optional(),
    notes: z.string().max(1000).optional(),
    shot_id: z.string().optional(),
    trim_end_s: z.number().positive().optional(),
    trim_start_s: z.number().min(0).optional()
  })).max(49).optional(),
  sets: z.array(sequenceReferenceUpdate).optional(),
  shots: z.array(z.looseObject({
    ...sequenceShotFields,
    asset_id: z.string().optional(),
    shot_id: z.string()
  })).optional(),
  style: sequenceStyle.optional(),
  view: z.enum(["full", "changed"]).optional()
}).strict();

export const generateSequenceSchema = z.object({
  ...visualGenerationFields,
  resolution: z.string().optional(),
  shots: z.array(z.looseObject({
    continues_shot_id: z.string().optional(),
    first_frame_asset_id: z.string().optional(),
    last_frame_asset_id: z.string().optional(),
    leads_into_shot_id: z.string().optional(),
    lip_sync: z.boolean().optional(),
    prompt: z.string(),
    shot_id: z.string()
  })).min(1).max(8),
  step: z.enum(["keyframes", "clips"])
}).strict();

export const visualUploadConsentSchema = z.object({
  decisions: z.array(z.looseObject({
    consent_key: z.string(),
    outcome: z.string(),
    version: z.number().int()
  })).min(1)
}).strict();

export const visualUploadCreateSchema = z.object({
  bytes: z.number().int().min(1).optional(),
  content_type: z.enum([
    "image/jpeg", "image/png", "image/webp", "image/bmp",
    "video/mp4", "video/quicktime", "video/webm", "video/x-msvideo",
    "video/x-matroska", "video/x-ms-wmv"
  ]).optional(),
  file: attachmentSchema.optional()
}).strict();

export type CreateSongInput = z.infer<typeof createSongSchema>;
export type CreateSampleInput = z.infer<typeof createSampleSchema>;
