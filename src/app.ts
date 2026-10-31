import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { JsonValue, SunoTool } from "./suno.js";
import {
  createCoverSchema,
  createExtensionSchema,
  createMashupSchema,
  createSampleSchema,
  createSongSchema,
  fullSongSchema,
  libraryQuerySchema,
  likedQuerySchema,
  uploadCreateSchema,
  uploadSessionSchema,
  waitBodySchema,
  waitQuerySchema
} from "./schemas.js";
import {
  BridgeError,
  getUploadedClipId,
  getUploadSession,
  putSignedUpload,
  readBoundedMultipart
} from "./upload.js";

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
};

function normalizedToolName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "");
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BridgeError(
      400,
      "Invalid request",
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message
      }))
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
  if (!id || id.length > 255) throw new BridgeError(400, "Invalid clip id");
  return id;
}

/** Build the authenticated REST API with injectable MCP operations and upload limits. */
export function createApp({
  apiKey,
  tools,
  maxUploadBytes = 32 * 1024 * 1024,
  allowedTools = ["account-usage", "audio-retrieve", "library-list"]
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

  app.get("/", (c) => c.json({
    service: "suno-mcp-rest-bridge",
    health: "/health",
    authentication: "Use Authorization: Bearer <API_KEY> for /api/* requests",
    endpoints: {
      tools: "/api/tools",
      usage: "/api/usage",
      library: "/api/library"
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
  app.get("/api/usage", async (c) => c.json(await tools.callTool("account-usage", {})));

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

  app.post("/api/songs", async (c) =>
    c.json(await tools.callTool("audio-create", parse(createSongSchema, await jsonBody(c))), 202)
  );
  app.post("/api/samples", async (c) =>
    c.json(await tools.callTool("audio-create", parse(createSampleSchema, await jsonBody(c))), 202)
  );
  app.post("/api/songs/wait", async (c) =>
    c.json(await tools.callTool("audio-wait", parse(waitBodySchema, await jsonBody(c))))
  );
  app.get("/api/songs/:id", async (c) =>
    c.json(await tools.callTool("audio-retrieve", { id: validId(c.req.param("id")) }))
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
    c.json(await tools.callTool("audio-covers-create", {
      ...parse(createCoverSchema, await jsonBody(c, true)),
      id: validId(c.req.param("id"))
    }), 202)
  );
  app.post("/api/songs/:id/mashup", async (c) =>
    c.json(await tools.callTool("audio-mashups-create", {
      ...parse(createMashupSchema, await jsonBody(c)),
      id: validId(c.req.param("id"))
    }), 202)
  );
  app.post("/api/songs/:id/extend", async (c) =>
    c.json(await tools.callTool("audio-extensions-create", {
      ...parse(createExtensionSchema, await jsonBody(c)),
      id: validId(c.req.param("id"))
    }), 202)
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
    if (error instanceof BridgeError) {
      return c.json({ error: error.message, ...(error.issues ? { issues: error.issues } : {}) }, error.status);
    }
    // Upstream MCP error includes details, while transport errors get a generic 502.
    if (error instanceof Error && error.name === "SunoToolError") {
      const details = "details" in error ? error.details : undefined;
      return c.json({ error: "Suno MCP tool failed", details }, 502);
    }
    console.error("Suno bridge request failed", error);
    return c.json({ error: "Suno MCP connection or internal operation failed" }, 502);
  });

  return app;
}
