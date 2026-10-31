import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { JsonValue, SunoTool } from "./suno.js";
import {
  createCoverSchema,
  createExtensionSchema,
  createMashupSchema,
  createPlaylistSchema,
  createQuerySchema,
  createSampleSchema,
  createSongSchema,
  createSpeechSchema,
  createWorkspaceSchema,
  defaultWaitSeconds,
  downloadSchema,
  editSongSchema,
  eventsQuerySchema,
  fullSongSchema,
  libraryQuerySchema,
  likedQuerySchema,
  playlistClipsQuerySchema,
  playlistClipsSchema,
  playlistsQuerySchema,
  updateWorkspaceClipsSchema,
  uploadCreateSchema,
  uploadSessionSchema,
  voicesQuerySchema,
  waitAllSchema,
  waitBodySchema,
  waitQuerySchema,
  workspacesQuerySchema
} from "./schemas.js";
import {
  BridgeError,
  fields,
  getUploadedClipId,
  getUploadSession,
  isRecord,
  putSignedUpload,
  readBoundedMultipart
} from "./upload.js";
import { clipIdsFrom, pollClips, waitForClips, type ClipRound } from "./wait.js";

export type BridgeDependencies = {
  callTool: (name: string, args: Record<string, unknown>) => Promise<JsonValue>;
  listTools: () => Promise<SunoTool[]>;
  putUpload?: (url: string, bytes: Uint8Array) => Promise<void>;
};

export type BridgeOptions = {
  apiKey: string;
  tools: BridgeDependencies;
  maxUploadBytes?: number;
  allowedTools?: string[];
  minCreditsRemaining?: number;
  requireIdempotencyKey?: boolean;
  waitPollMs?: number;
};

type ChargeableArgs = Record<string, unknown> & { model?: string; idempotency_key?: string };

// Suno MCP errors carry a string `code` but no HTTP status.
const upstreamStatuses = new Map<string, 400 | 402 | 403 | 404 | 429>([
  ["invalid_request", 400],
  ["insufficient_credits", 402],
  ["forbidden", 403],
  ["feature_not_on_plan", 403],
  ["not_found", 404],
  ["rate_limited", 429],
  ["quota_exceeded", 429]
]);

function upstreamStatus(details: unknown): 400 | 402 | 403 | 404 | 429 | 502 {
  if (details === null || typeof details !== "object" || !("code" in details)) return 502;
  return typeof details.code === "string" ? upstreamStatuses.get(details.code) ?? 502 : 502;
}

/** Build the status and JSON body for a failure; transport errors get a generic 502. */
function errorResponse(error: unknown) {
  if (error instanceof BridgeError) {
    return {
      status: error.status,
      body: { error: error.message, ...(error.issues ? { issues: error.issues } : {}) }
    };
  }
  if (error instanceof Error && error.name === "SunoToolError") {
    const details = "details" in error ? error.details : undefined;
    return { status: upstreamStatus(details), body: { error: "Suno MCP tool failed", details } };
  }
  console.error("Suno bridge request failed", error);
  return { status: 502 as const, body: { error: "Suno MCP connection or internal operation failed" } };
}

function waitResponse({ clips, pending, timedOut, error }: ClipRound) {
  return {
    clips,
    pending,
    timed_out: timedOut,
    ...(error !== undefined ? { wait_error: errorResponse(error).body } : {})
  };
}

function normalizedToolName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "");
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message
    }));
    if (result.error.issues.some((issue) =>
      issue.code === "unrecognized_keys" && issue.path.length === 0 && issue.keys.includes("clip_count")
    )) {
      issues.unshift({
        path: "clip_count",
        message: "Suno MCP no longer supports clip_count. Omit it; Suno determines the number of songs. Process every returned clip_ids entry."
      });
    }
    throw new BridgeError(
      400,
      "Invalid request",
      issues
    );
  }
  return result.data;
}

async function jsonBody(c: Context, emptyIsObject = false): Promise<unknown> {
  const raw = await c.req.text();
  if (emptyIsObject && raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BridgeError(400, "Expected a JSON request body");
  }
}

function queryObject(c: Context): Record<string, string> {
  const params = new URL(c.req.url).searchParams;
  return Object.fromEntries(params.entries());
}

function validId(id: string): string {
  const normalized = id.trim();
  if (!normalized || normalized.length > 255) throw new BridgeError(400, "Invalid id");
  return normalized;
}

/** Build the authenticated REST API with injectable MCP operations and upload limits. */
export function createApp({
  apiKey,
  tools,
  maxUploadBytes = 32 * 1024 * 1024,
  allowedTools = ["account-usage", "audio-retrieve", "library-list"],
  minCreditsRemaining,
  requireIdempotencyKey = false,
  waitPollMs = 1000
}: BridgeOptions): Hono {
  if (!apiKey || apiKey === "replace_with_a_random_key") {
    throw new Error("Set a non-default API_KEY");
  }
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1024) {
    throw new Error("maxUploadBytes must be a positive integer >= 1024");
  }

  const apiKeyBuffer = Buffer.from(apiKey);
  const allowed = new Set(allowedTools.map(normalizedToolName));
  const putUpload = tools.putUpload ?? putSignedUpload;
  const app = new Hono();

  // A guard that can't read the account refuses rather than spending credits unchecked.
  const guardCharge = async ({ model, idempotency_key }: ChargeableArgs) => {
    if (requireIdempotencyKey && !idempotency_key) {
      throw new BridgeError(400, "Invalid request", [{
        path: "idempotency_key",
        message: "REQUIRE_IDEMPOTENCY_KEY is on; send a unique idempotency_key"
      }]);
    }
    if (!model && minCreditsRemaining === undefined) return;
    const usage = fields(await tools.callTool("account-usage", {}));
    if (model && Array.isArray(usage.allowed_models) && !usage.allowed_models.includes(model)) {
      throw new BridgeError(400, "Invalid request", [{
        path: "model",
        message: `Model not available on this account. Allowed: ${usage.allowed_models.join(", ")}`
      }]);
    }
    if (minCreditsRemaining === undefined) return;
    const credits = isRecord(usage.suno_account) ? usage.suno_account.credits_remaining : undefined;
    if (typeof credits !== "number") {
      throw new BridgeError(502, "Could not read credits_remaining to check MIN_CREDITS_REMAINING");
    }
    if (credits < minCreditsRemaining) {
      throw new BridgeError(402, `Credits remaining (${credits}) are below MIN_CREDITS_REMAINING (${minCreditsRemaining})`);
    }
  };

  // Once Suno accepts a creation the credits are spent, so a failed wait still returns its clip IDs.
  const create = async (c: Context, tool: string, args: ChargeableArgs) => {
    const { wait, timeout } = parse(createQuerySchema, queryObject(c));
    await guardCharge(args);
    const created = await tools.callTool(tool, args);
    if (!wait) return c.json(created, 202);
    const ids = clipIdsFrom(created);
    if (ids.length === 0) {
      return c.json({
        created, clips: [], pending: [], timed_out: false,
        wait_error: { error: "Suno returned no clip IDs to wait for" }
      }, 202);
    }
    const result = await waitForClips(tools.callTool, ids, {
      until: wait,
      timeoutMs: (timeout ?? defaultWaitSeconds) * 1000,
      pollMs: waitPollMs
    });
    return c.json(
      { created, ...waitResponse(result) },
      result.pending.length === 0 && result.error === undefined ? 200 : 202
    );
  };

  app.get("/", (c) => c.json({
    service: "suno-mcp-rest-bridge",
    health: "/health",
    authentication: "Use Authorization: Bearer <API_KEY> for /api/* requests",
    endpoints: {
      tools: "/api/tools",
      account: "/api/account",
      usage: "/api/usage",
      models: "/api/models",
      library: "/api/library",
      voices: "/api/voices",
      playlists: "/api/playlists",
      workspaces: "/api/workspaces"
    },
    operations: {
      wait: { method: "POST", path: "/api/songs/wait" },
      waitAll: { method: "POST", path: "/api/songs/wait-all" },
      events: { method: "GET", path: "/api/songs/events?ids=ID1,ID2" }
    }
  }));
  app.get("/health", (c) => c.json({ ok: true }));
  app.use("/api/*", async (c, next) => {
    const header = c.req.header("Authorization");
    const received = header?.startsWith("Bearer ") ? Buffer.from(header.slice(7)) : undefined;
    if (!received || received.length !== apiKeyBuffer.length ||
        !timingSafeEqual(received, apiKeyBuffer)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/api/tools", async (c) => c.json({ tools: await tools.listTools() }));
  app.get("/api/account", async (c) => c.json(await tools.callTool("account-me", {})));
  app.get("/api/account/upgrade", async (c) => c.json(await tools.callTool("account-upgrade", {})));
  app.get("/api/usage", async (c) => c.json(await tools.callTool("account-usage", {})));
  app.get("/api/models", async (c) => {
    const usage = fields(await tools.callTool("account-usage", {}));
    return c.json({ allowed_models: Array.isArray(usage.allowed_models) ? usage.allowed_models : [] });
  });

  // Register collection endpoints before song-id endpoints for easy discovery.
  app.get("/api/library", async (c) => {
    const { query, ...filters } = parse(libraryQuerySchema, queryObject(c));
    return c.json(await tools.callTool(query ? "library-search" : "library-list", {
      ...filters,
      ...(query ? { query } : {})
    }));
  });
  app.get("/api/library/liked", async (c) =>
    c.json(await tools.callTool("library-liked", parse(likedQuerySchema, queryObject(c))))
  );

  app.get("/api/voices", async (c) =>
    c.json(await tools.callTool("voices-list", parse(voicesQuerySchema, queryObject(c))))
  );
  // Returns a suno.com URL where the user records and verifies the voice.
  app.post("/api/voices/start", async (c) => c.json(await tools.callTool("voices-start", {})));

  app.get("/api/playlists", async (c) =>
    c.json(await tools.callTool("playlists-list", parse(playlistsQuerySchema, queryObject(c))))
  );
  app.post("/api/playlists", async (c) =>
    c.json(await tools.callTool("playlists-create", parse(createPlaylistSchema, await jsonBody(c))), 201)
  );
  app.get("/api/playlists/:id/songs", async (c) =>
    c.json(await tools.callTool("playlists-list-clips", {
      ...parse(playlistClipsQuerySchema, queryObject(c)),
      id: validId(c.req.param("id"))
    }))
  );
  app.post("/api/playlists/:id/songs", async (c) =>
    c.json(await tools.callTool("playlists-add-clips", {
      ...parse(playlistClipsSchema, await jsonBody(c)),
      id: validId(c.req.param("id"))
    }))
  );
  app.delete("/api/playlists/:id/songs", async (c) =>
    c.json(await tools.callTool("playlists-remove-clips", {
      ...parse(playlistClipsSchema, await jsonBody(c)),
      id: validId(c.req.param("id"))
    }))
  );

  app.get("/api/workspaces", async (c) =>
    c.json(await tools.callTool("workspaces-list", parse(workspacesQuerySchema, queryObject(c))))
  );
  app.post("/api/workspaces", async (c) =>
    c.json(await tools.callTool("workspaces-create", parse(createWorkspaceSchema, await jsonBody(c))), 201)
  );
  app.patch("/api/workspaces/:id/songs", async (c) =>
    c.json(await tools.callTool("workspaces-update-clips", {
      ...parse(updateWorkspaceClipsSchema, await jsonBody(c)),
      id: validId(c.req.param("id"))
    }))
  );

  app.post("/api/speech", async (c) =>
    create(c, "speech-create", parse(createSpeechSchema, await jsonBody(c)))
  );
  app.post("/api/songs", async (c) =>
    create(c, "audio-create", parse(createSongSchema, await jsonBody(c)))
  );
  app.post("/api/samples", async (c) =>
    create(c, "audio-create", parse(createSampleSchema, await jsonBody(c)))
  );
  app.post("/api/songs/wait", async (c) =>
    c.json(await tools.callTool("audio-wait", parse(waitBodySchema, await jsonBody(c))))
  );
  app.post("/api/songs/wait-all", async (c) => {
    const { ids, until, timeout } = parse(waitAllSchema, await jsonBody(c));
    const result = await waitForClips(tools.callTool, ids, {
      until, timeoutMs: timeout * 1000, pollMs: waitPollMs
    });
    if (result.error !== undefined && result.clips.length === 0) throw result.error;
    return c.json(
      waitResponse(result),
      result.pending.length === 0 && result.error === undefined ? 200 : 202
    );
  });
  // Register before /api/songs/:id, which would otherwise read "events" as a clip ID.
  app.get("/api/songs/events", async (c) => {
    const { ids, until, timeout } = parse(eventsQuerySchema, queryObject(c));
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      const statuses = new Map<string, JsonValue>();
      const rounds = pollClips(tools.callTool, ids, {
        until, timeoutMs: timeout * 1000, pollMs: waitPollMs, signal: abort.signal
      });
      for await (const { clips, pending, timedOut, error } of rounds) {
        for (const clip of clips) {
          const status = clip.status ?? null;
          if (statuses.has(clip.id as string) && statuses.get(clip.id as string) === status) continue;
          statuses.set(clip.id as string, status);
          await stream.writeSSE({ event: "clip", data: JSON.stringify(clip) });
        }
        if (error !== undefined) {
          // "failed" because browsers reserve the "error" event for connection problems.
          await stream.writeSSE({ event: "failed", data: JSON.stringify(errorResponse(error).body) });
        } else if (pending.length === 0 || timedOut) {
          await stream.writeSSE({ event: "done", data: JSON.stringify({ pending, timed_out: timedOut }) });
        }
      }
    });
  });
  app.get("/api/songs/:id", async (c) =>
    c.json(await tools.callTool("audio-retrieve", { id: validId(c.req.param("id")) }))
  );
  app.patch("/api/songs/:id", async (c) =>
    c.json(await tools.callTool("audio-edit", {
      ...parse(editSongSchema, await jsonBody(c)),
      id: validId(c.req.param("id"))
    }))
  );
  app.get("/api/songs/:id/analysis", async (c) =>
    c.json(await tools.callTool("audio-analysis", { id: validId(c.req.param("id")) }))
  );
  app.get("/api/songs/:id/lyrics-alignment", async (c) =>
    c.json(await tools.callTool("audio-lyrics-alignment", { id: validId(c.req.param("id")) }))
  );
  // A download can spend a credit, so `confirm` only ever comes from the client.
  app.post("/api/songs/:id/download", async (c) =>
    c.json(await tools.callTool("audio-download", {
      ...parse(downloadSchema, await jsonBody(c, true)),
      id: validId(c.req.param("id"))
    }))
  );
  app.post("/api/songs/:id/like", async (c) =>
    c.json(await tools.callTool("audio-like", { id: validId(c.req.param("id")) }))
  );
  app.delete("/api/songs/:id/like", async (c) =>
    c.json(await tools.callTool("audio-unlike", { id: validId(c.req.param("id")) }))
  );
  app.get("/api/songs/:id/wait", async (c) =>
    c.json(await tools.callTool("audio-wait", {
      id: validId(c.req.param("id")),
      ...parse(waitQuerySchema, queryObject(c))
    }))
  );

  // Without a file this returns signed URLs; an attached file starts processing immediately.
  app.post("/api/uploads/sessions", async (c) => {
    const args = parse(uploadCreateSchema, await jsonBody(c, true));
    return c.json(await tools.callTool("audio-upload-create", args), args.file ? 202 : 201);
  });
  app.post("/api/uploads/:id/complete", async (c) =>
    c.json(await tools.callTool("audio-upload-complete", {
      id: validId(c.req.param("id")),
      ...parse(uploadSessionSchema, await jsonBody(c, true))
    }), 202)
  );

  // Single-request convenience wrapper around Suno's three-step upload protocol.
  // No shared state or temp files: the audio is held in memory up to MAX_UPLOAD_MB.
  app.post("/api/uploads/file", async (c) => {
    const form = await readBoundedMultipart(c.req.raw, maxUploadBytes);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new BridgeError(400, "The multipart field 'file' must contain a non-empty audio file");
    }
    const maybeTitle = form.get("title");
    if (maybeTitle !== null && typeof maybeTitle !== "string") {
      throw new BridgeError(400, "The multipart field 'title' must be text");
    }
    const { title } = parse(uploadSessionSchema, {
      title: maybeTitle === null ? file.name : maybeTitle
    });
    const rawSession = await tools.callTool("audio-upload-create", { title });
    const { sessionId, uploadUrl, clipId } = getUploadSession(rawSession);
    await putUpload(uploadUrl, new Uint8Array(await file.arrayBuffer()));
    const completed = await tools.callTool("audio-upload-complete", { id: sessionId, title });
    return c.json({
      session_id: sessionId,
      clip_id: getUploadedClipId(completed) ?? clipId ?? null,
      result: completed
    }, 202);
  });

  app.post("/api/songs/:id/cover", async (c) =>
    create(c, "audio-covers-create", {
      ...parse(createCoverSchema, await jsonBody(c, true)),
      id: validId(c.req.param("id"))
    })
  );
  app.post("/api/songs/:id/mashup", async (c) =>
    create(c, "audio-mashups-create", {
      ...parse(createMashupSchema, await jsonBody(c)),
      id: validId(c.req.param("id"))
    })
  );
  app.post("/api/songs/:id/extend", async (c) =>
    create(c, "audio-extensions-create", {
      ...parse(createExtensionSchema, await jsonBody(c)),
      id: validId(c.req.param("id"))
    })
  );
  app.post("/api/songs/:id/full-song", async (c) =>
    c.json(await tools.callTool("audio-full-song", {
      ...parse(fullSongSchema, await jsonBody(c, true)),
      id: validId(c.req.param("id"))
    }), 202)
  );

  app.post("/api/tools/:name/call", async (c) => {
    const name = c.req.param("name");
    if (!allowed.has(normalizedToolName(name))) {
      throw new BridgeError(403, "Tool not in ALLOWED_TOOLS");
    }
    const args = await jsonBody(c);
    if (args === null || Array.isArray(args) || typeof args !== "object") {
      throw new BridgeError(400, "Expected a JSON object");
    }
    return c.json(await tools.callTool(name, args as Record<string, unknown>));
  });

  app.onError((error, c) => {
    const { status, body } = errorResponse(error);
    return c.json(body, status);
  });

  return app;
}
