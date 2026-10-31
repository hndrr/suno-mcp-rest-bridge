import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { createApp, type BridgeDependencies, type BridgeOptions } from "../src/app.js";
import { BridgeError, getUploadSession, putSignedUpload } from "../src/upload.js";
import { simplifyToolResult, SunoToolError, type JsonValue } from "../src/suno.js";

type Call = { name: string; args: Record<string, unknown> };

// Captured from the official MCP server, independently of the bridge's Zod schemas.
const upstreamSnapshot = JSON.parse(readFileSync(
  new URL("./fixtures/suno-input-schemas.json", import.meta.url), "utf8"
)) as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }> };
const upstreamSchemas = new Map(upstreamSnapshot.tools.map((tool) => [tool.name, tool.inputSchema]));

/** Build an isolated bridge whose mock calls are checked against the captured MCP contract. */
function harness({
  uploadResult = { id: "session-123", upload_url: "https://storage.example.net/upload" } as JsonValue,
  maxUploadBytes = 1024 * 1024,
  toolResults = {},
  options = {}
}: {
  uploadResult?: JsonValue;
  maxUploadBytes?: number;
  toolResults?: Record<string, JsonValue | ((args: Record<string, unknown>) => JsonValue)>;
  options?: Partial<BridgeOptions>;
} = {}) {
  const calls: Call[] = [];
  const uploaded: { url: string; bytes: Uint8Array }[] = [];
  const contractViolations: string[] = [];
  after(() => assert.equal(contractViolations.length, 0, `MCP contract violations:\n${contractViolations.join("\n")}`));
  const tools: BridgeDependencies = {
    callTool: async (name, args) => {
      const schema = upstreamSchemas.get(name);
      if (!schema) {
        contractViolations.push(`Missing upstream contract for ${name}`);
      } else {
        for (const key of Object.keys(args)) {
          if (!Object.hasOwn(schema.properties, key)) contractViolations.push(`${name} does not accept ${key}`);
        }
        for (const key of schema.required ?? []) {
          if (args[key] === undefined) contractViolations.push(`${name} requires ${key}`);
        }
      }
      calls.push({ name, args });
      if (Object.hasOwn(toolResults, name)) {
        const result = toolResults[name];
        return typeof result === "function" ? result(args) : result;
      }
      if (name === "audio-upload-create") return uploadResult;
      if (name === "audio-upload-complete") return { id: "source-clip", status: "processing" };
      return { ok: true, name, args };
    },
    listTools: async () => [],
    putUpload: async (url, bytes) => { uploaded.push({ url, bytes }); }
  };
  const app = createApp({ apiKey: "test-secret", tools, maxUploadBytes, waitPollMs: 1, ...options });
  const url = (path: string) => `http://localhost${path}`;
  const auth = { Authorization: "Bearer test-secret" };
  const post = async (path: string, body: unknown): Promise<Response> =>
    app.request(url(path), {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  const get = async (path: string): Promise<Response> => app.request(url(path), { headers: auth });
  const send = async (method: string, path: string, body?: unknown): Promise<Response> =>
    app.request(url(path), {
      method,
      headers: { ...auth, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  return { app, calls, uploaded, post, get, send, auth, url };
}

const usage = {
  allowed_models: ["v6-mini", "v6", "v6-wild"],
  suno_account: { credits_remaining: 100 }
};

describe("authentication and generated samples", () => {
  it("serves API discovery at the root without credentials or a Suno connection", async () => {
    const { app, calls, url } = harness();
    const res = await app.request(url("/"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /application\/json/);
    const responseText = await res.text();
    const body = JSON.parse(responseText) as {
      service: string; health: string; endpoints: Record<string, string>;
      operations: { wait: { method: string; path: string } };
    };
    assert.equal(body.service, "suno-mcp-rest-bridge");
    assert.deepEqual(body.operations.wait, { method: "POST", path: "/api/songs/wait" });
    assert.equal((await app.request(url(body.health))).status, 200);
    for (const path of Object.values(body.endpoints)) {
      assert.equal((await app.request(url(path))).status, 401);
    }
    assert.equal(calls.length, 0);
    assert.ok(!responseText.includes("test-secret"));
  });

  it("rejects missing or wrong credentials", async () => {
    const { app, url } = harness();
    assert.equal((await app.request(url("/api/usage"))).status, 401);
    assert.equal((await app.request(url("/api/usage"), {
      headers: { Authorization: "Bearer wrong" }
    })).status, 401);
    assert.equal((await app.request(url("/health"))).status, 200);
  });

  it("creates songs without injecting the removed clip_count argument", async () => {
    const { post, calls } = harness();
    const res = await post("/api/songs", { description: "bright pop", duration: 30 });
    assert.equal(res.status, 202);
    assert.equal(calls.at(-1)?.name, "audio-create");
    assert.ok(!Object.hasOwn(calls.at(-1)!.args, "clip_count"));
    assert.equal(calls.at(-1)?.args.duration, 30);
  });

  it("defaults samples to 15 seconds and strict duration without choosing a clip count", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/samples", { instrumental: true })).status, 202);
    assert.deepEqual({
      duration: calls.at(-1)?.args.duration,
      strict: calls.at(-1)?.args.duration_strict,
      guidance: calls.at(-1)?.args.duration_guidance
    }, { duration: 15, strict: true, guidance: true });
    assert.ok(!Object.hasOwn(calls.at(-1)!.args, "clip_count"));
  });

  it("validates duration and prompt modes before calling Suno", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/samples", { description: "a", duration: 10 })).status, 400);
    assert.equal((await post("/api/songs", { description: "a", style: "jazz" })).status, 400);
    assert.equal((await post("/api/songs", { description: "a", controls: { audio_influence: .6 } })).status, 400);
    assert.equal(calls.length, 0);
  });

  it("passes through custom lyrics, style and advanced controls", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/songs", {
      lyrics: "hello", style: "indie pop",
      controls: { style_influence: 0.5, weirdness: 0.2 }, idempotency_key: "demo-1"
    })).status, 202);
    assert.equal(calls.at(-1)?.args.lyrics, "hello");
    assert.deepEqual(calls.at(-1)?.args.controls, { style_influence: 0.5, weirdness: 0.2 });
  });

  it("rejects clip_count on every generation route before calling Suno", async () => {
    const { post, calls } = harness();
    const requests: Array<[string, Record<string, unknown>]> = [
      ["/api/songs", { description: "bright pop" }],
      ["/api/samples", { instrumental: true }],
      ["/api/songs/source/cover", {}],
      ["/api/songs/source/mashup", { additional_audio_id: "second" }],
      ["/api/songs/source/extend", { continue_at: 1 }]
    ];
    for (const [path, body] of requests) {
      for (const clip_count of [1, 2]) {
        const response = await post(path, { ...body, clip_count });
        assert.equal(response.status, 400, path);
        const error = await response.json() as { issues: Array<{ path: string; message: string }> };
        assert.match(error.issues.find((issue) => issue.path === "clip_count")?.message ?? "", /Suno MCP no longer supports clip_count/);
      }
    }
    assert.equal(calls.length, 0);
  });

  it("returns every clip ID when Suno generates multiple songs", async () => {
    const result = { id: "first", clip_ids: ["first", "second"], status: "submitted" };
    for (const path of ["/api/songs", "/api/samples"]) {
      const { post } = harness({ toolResults: { "audio-create": result } });
      const response = await post(path, { instrumental: true });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), result);
    }
  });
});

describe("reference-based generation", () => {
  it("covers a finished clip with duration and influence", async () => {
    const { post, calls } = harness();
    const res = await post("/api/songs/source-id/cover", {
      duration: 30, style: "bright hi-fi pop", controls: { audio_influence: 0.7 }
    });
    assert.equal(res.status, 202);
    assert.deepEqual(calls.at(-1), {
      name: "audio-covers-create",
      args: { id: "source-id", duration: 30, style: "bright hi-fi pop", controls: { audio_influence: 0.7 } }
    });
  });

  it("mashes exactly two source clips", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/songs/source1/mashup", { additional_audio_id: "source2" })).status, 202);
    assert.equal(calls.at(-1)?.name, "audio-mashups-create");
    assert.equal(calls.at(-1)?.args.additional_audio_id, "source2");
    assert.equal((await post("/api/songs/source1/mashup", {})).status, 400);
  });

  it("extends from a specific time, then joins the chain", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/songs/source1/extend", { continue_at: 12.5, duration: 30 })).status, 202);
    assert.equal(calls.at(-1)?.name, "audio-extensions-create");
    assert.equal(calls.at(-1)?.args.continue_at, 12.5);
    assert.equal((await post("/api/songs/extension1/full-song", {})).status, 202);
    assert.deepEqual(calls.at(-1), { name: "audio-full-song", args: { id: "extension1" } });
    assert.equal((await post("/api/songs/source1/extend", { continue_at: 0.3 })).status, 400);
  });

  it("reads original library or search and waits for a clip", async () => {
    const { get, calls } = harness();
    assert.equal((await get("/api/library?limit=5&origin=upload")).status, 200);
    assert.deepEqual(calls.at(-1), { name: "library-list", args: { limit: 5, origin: "upload" } });
    assert.equal((await get("/api/library?query=bright&limit=3")).status, 200);
    assert.deepEqual(calls.at(-1), { name: "library-search", args: { query: "bright", limit: 3 } });
    assert.equal((await get("/api/library/liked")).status, 200);
    assert.equal(calls.at(-1)?.name, "library-liked");
    assert.equal((await get("/api/songs/source1/wait?until=complete")).status, 200);
    assert.deepEqual(calls.at(-1), { name: "audio-wait", args: { id: "source1", until: "complete" } });
    assert.equal((await get("/api/library?limit=51")).status, 400);
  });
});

describe("waiting for generated songs", () => {
  it("waits for all supplied IDs and preserves every clip in the response", async () => {
    const result = {
      id: "first", status: "complete",
      clips: [{ id: "first", status: "complete" }, { id: "second", status: "complete" }]
    };
    const { post, calls } = harness({ toolResults: { "audio-wait": result } });
    const response = await post("/api/songs/wait", { ids: ["first", "second"], until: "complete" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
    assert.deepEqual(calls, [{ name: "audio-wait", args: { ids: ["first", "second"], until: "complete" } }]);
  });

  it("also accepts a single ID and defaults to waiting until playable", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/songs/wait", { id: "first" })).status, 200);
    assert.deepEqual(calls, [{ name: "audio-wait", args: { id: "first", until: "playable" } }]);
  });

  it("normalizes and deduplicates batch IDs before waiting", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/songs/wait", { ids: [" first ", "first", "second"] })).status, 200);
    assert.deepEqual(calls, [{ name: "audio-wait", args: { ids: ["first", "second"], until: "playable" } }]);
  });

  it("normalizes path IDs consistently and rejects whitespace-only IDs", async () => {
    const { get, calls } = harness();
    assert.equal((await get("/api/songs/%20first%20/wait")).status, 200);
    assert.deepEqual(calls, [{ name: "audio-wait", args: { id: "first", until: "playable" } }]);
    assert.equal((await get("/api/songs/%20/wait")).status, 400);
    assert.equal(calls.length, 1);
  });

  it("rejects missing, conflicting, empty and oversized ID lists before calling Suno", async () => {
    const { post, calls } = harness();
    for (const body of [
      {}, { ids: [] }, { id: "" }, { ids: [" "] },
      { id: "first", ids: ["second"] }, { ids: ["1", "2", "3", "4", "5"] }
    ]) {
      assert.equal((await post("/api/songs/wait", body)).status, 400);
    }
    assert.equal(calls.length, 0);
  });

  it("requires authentication for batch waiting", async () => {
    const { app, calls, url } = harness();
    const response = await app.request(url("/api/songs/wait"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: ["first"] })
    });
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  });
});

describe("reference audio uploads", () => {
  it("starts and completes a manual upload session", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/uploads/sessions", { title: "loop" })).status, 201);
    assert.deepEqual(calls.at(-1), { name: "audio-upload-create", args: { title: "loop" } });
    assert.equal((await post("/api/uploads/session-123/complete", {})).status, 202);
    assert.deepEqual(calls.at(-1), { name: "audio-upload-complete", args: { id: "session-123" } });
  });

  it("accepts a multipart audio file and sends bytes to the signed URL", async () => {
    const { app, calls, uploaded, url, auth } = harness();
    const form = new FormData();
    form.set("file", new File([Uint8Array.from([0, 1, 2, 3])], "riff.wav", { type: "audio/wav" }));
    const res = await app.request(url("/api/uploads/file"), { method: "POST", headers: auth, body: form });
    assert.equal(res.status, 202);
    assert.deepEqual(uploaded.map((x) => ({ url: x.url, bytes: Array.from(x.bytes) })), [
      { url: "https://storage.example.net/upload", bytes: [0, 1, 2, 3] }
    ]);
    assert.equal(calls.at(0)?.name, "audio-upload-create");
    assert.equal(calls.at(1)?.name, "audio-upload-complete");
    const body = await res.json() as { clip_id: string; session_id: string };
    assert.equal(body.clip_id, "source-clip");
    assert.equal(body.session_id, "session-123");
  });

  it("completes multipart uploads when MCP upload results also contain media", async () => {
    const media = { type: "resource_link", uri: "https://files.example.net/reference.wav", name: "reference.wav" };
    for (const structured of [true, false]) {
      const wrap = (payload: JsonValue) => simplifyToolResult({
        ...(structured ? { structuredContent: { data: payload } } : {}),
        content: [
          { type: "text", text: JSON.stringify({ data: payload }) },
          { type: "text", text: "Upload information is ready." },
          media
        ]
      });
      const completed = wrap({ clip: { id: "uploaded-clip", status: "processing" } });
      const { app, uploaded, calls, url, auth } = harness({
        toolResults: {
          "audio-upload-create": wrap({ session_id: "media-session", clip_id: "source-clip", upload_url: "https://storage.example.net/upload" }),
          "audio-upload-complete": completed
        }
      });
      const form = new FormData();
      form.set("file", new File([new Uint8Array([1, 2, 3])], "reference.wav", { type: "audio/wav" }));
      const response = await app.request(url("/api/uploads/file"), { method: "POST", headers: auth, body: form });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { session_id: "media-session", clip_id: "uploaded-clip", result: completed });
      assert.equal(uploaded[0]?.url, "https://storage.example.net/upload");
      assert.deepEqual(Array.from(uploaded[0].bytes), [1, 2, 3]);
      assert.deepEqual(calls.at(-1), { name: "audio-upload-complete", args: { id: "media-session", title: "reference.wav" } });
    }
  });

  it("forwards an attached file and returns the processing clip without proxying bytes", async () => {
    const clip = { id: "attached-clip", status: "processing" };
    const { post, calls, uploaded } = harness({ toolResults: { "audio-upload-create": clip } });
    const body = {
      title: "Reference",
      file: { download_url: "https://files.example.net/reference.wav", file_id: "attachment-1", file_name: "reference.wav", mime_type: "audio/wav" }
    };
    const response = await post("/api/uploads/sessions", body);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), clip);
    assert.deepEqual(calls, [{ name: "audio-upload-create", args: body }]);
    assert.equal(uploaded.length, 0);
  });

  it("validates attachment metadata and prevents passing file to upload completion", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/uploads/sessions", { file: { download_url: "https://files.example.net/audio.wav" } })).status, 400);
    assert.equal((await post("/api/uploads/sessions", { file: { download_url: 42, file_id: "attachment" } })).status, 400);
    assert.equal((await post("/api/uploads/sessions", { file: { download_url: "https://files.example.net/audio.wav", file_id: null } })).status, 400);
    assert.equal((await post("/api/uploads/session/complete", { file: { download_url: "https://files.example.net/audio.wav", file_id: "attachment" } })).status, 400);
    assert.equal(calls.length, 0);
  });

  it("preserves attachment provider metadata without imposing extra string constraints", async () => {
    const { post, calls } = harness();
    const file = {
      download_url: "provider:attachment",
      file_id: "",
      provider_metadata: { original_name: "reference.wav", expires_at: 1234567890 }
    };
    assert.equal((await post("/api/uploads/sessions", { file })).status, 202);
    assert.deepEqual(calls, [{ name: "audio-upload-create", args: { file } }]);
  });

  it("rejects oversized uploads before touching Suno", async () => {
    const { app, calls, url, auth } = harness({ maxUploadBytes: 1024 });
    const form = new FormData();
    form.set("file", new File([new Uint8Array(2048)], "big.wav"));
    const res = await app.request(url("/api/uploads/file"), { method: "POST", headers: auth, body: form });
    assert.equal(res.status, 413);
    assert.equal(calls.length, 0);
  });

  it("rejects upload responses without the expected signing fields", () => {
    assert.throws(() => getUploadSession({ id: "1" }), BridgeError);
  });

  it("rejects an unsafe upload URL before sending any bytes", async () => {
    await assert.rejects(() => putSignedUpload("http://127.0.0.1/test", new Uint8Array(1)), BridgeError);
  });
});

describe("upstream error statuses", () => {
  const request = (callTool: BridgeDependencies["callTool"]) => createApp({
    apiKey: "test-secret",
    tools: { callTool, listTools: async () => [] }
  }).request("http://localhost/api/usage", { headers: { Authorization: "Bearer test-secret" } });
  const failWith = (details: JsonValue) => request(async () => { throw new SunoToolError(details); });

  it("maps Suno error codes to HTTP statuses and keeps the upstream details", async () => {
    const statuses: Array<[string, number]> = [
      ["invalid_request", 400],
      ["insufficient_credits", 402],
      ["forbidden", 403],
      ["feature_not_on_plan", 403],
      ["not_found", 404],
      ["rate_limited", 429],
      ["quota_exceeded", 429]
    ];
    for (const [code, status] of statuses) {
      const details = { error: "refused", code, reason: "detail" };
      const response = await failWith(details);
      assert.equal(response.status, status, code);
      assert.deepEqual(await response.json(), { error: "Suno MCP tool failed", details });
    }
  });

  it("reads the code from a real MCP error result", async () => {
    // Captured from the official MCP server for an unknown clip ID.
    const details = simplifyToolResult({
      isError: true,
      content: [{ type: "text", text: '{"error":"audio not found","code":"not_found"}' }]
    });
    assert.equal((await failWith(details)).status, 404);
  });

  it("keeps 502 and the details for unknown or missing codes", async () => {
    const unmapped: JsonValue[] = [
      { error: "refused", code: "something_new" },
      { error: "refused", code: "constructor" },
      { error: "refused", code: 404 },
      { error: "refused" },
      { text: "Not JSON" },
      null
    ];
    for (const details of unmapped) {
      const response = await failWith(details);
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: "Suno MCP tool failed", details });
    }
  });

  it("keeps a generic 502 for connection failures", async (t) => {
    t.mock.method(console, "error", () => {});
    const response = await request(async () => { throw new Error("transport closed"); });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Suno MCP connection or internal operation failed" });
  });
});

describe("account, library and voice tools", () => {
  it("maps each route to its tool and arguments", async () => {
    const cases: Array<[string, string, unknown, string, Record<string, unknown>, number]> = [
      ["GET", "/api/account", undefined, "account-me", {}, 200],
      ["GET", "/api/account/upgrade", undefined, "account-upgrade", {}, 200],
      ["GET", "/api/songs/a/analysis", undefined, "audio-analysis", { id: "a" }, 200],
      ["GET", "/api/songs/a/lyrics-alignment", undefined, "audio-lyrics-alignment", { id: "a" }, 200],
      ["POST", "/api/songs/a/download", undefined, "audio-download", { id: "a" }, 200],
      ["POST", "/api/songs/a/download", { format: "wav", confirm: true }, "audio-download", { id: "a", format: "wav", confirm: true }, 200],
      ["PATCH", "/api/songs/a", { title: "New" }, "audio-edit", { id: "a", title: "New" }, 200],
      ["POST", "/api/songs/a/like", undefined, "audio-like", { id: "a" }, 200],
      ["DELETE", "/api/songs/a/like", undefined, "audio-unlike", { id: "a" }, 200],
      ["POST", "/api/speech", { script: "Hello" }, "speech-create", { script: "Hello" }, 202],
      ["GET", "/api/voices?collection=loved&limit=100&query=warm", undefined, "voices-list", { collection: "loved", limit: 100, query: "warm" }, 200],
      ["POST", "/api/voices/start", undefined, "voices-start", {}, 200],
      ["GET", "/api/playlists?limit=5&query=mix", undefined, "playlists-list", { limit: 5, query: "mix" }, 200],
      ["POST", "/api/playlists", { name: "Mix", visibility: "public" }, "playlists-create", { name: "Mix", visibility: "public" }, 201],
      ["GET", "/api/playlists/p/songs?limit=5", undefined, "playlists-list-clips", { id: "p", limit: 5 }, 200],
      ["POST", "/api/playlists/p/songs", { clip_ids: ["a"] }, "playlists-add-clips", { id: "p", clip_ids: ["a"] }, 200],
      ["DELETE", "/api/playlists/p/songs", { clip_ids: ["a"] }, "playlists-remove-clips", { id: "p", clip_ids: ["a"] }, 200],
      ["GET", "/api/workspaces?query=demo", undefined, "workspaces-list", { query: "demo" }, 200],
      ["POST", "/api/workspaces", { name: "Demo" }, "workspaces-create", { name: "Demo" }, 201],
      ["PATCH", "/api/workspaces/w/songs", { add: ["a"], remove: ["b"] }, "workspaces-update-clips", { id: "w", add: ["a"], remove: ["b"] }, 200]
    ];
    const { send, calls } = harness();
    for (const [method, path, body, name, args, status] of cases) {
      assert.equal((await send(method, path, body)).status, status, `${method} ${path}`);
      assert.deepEqual(calls.at(-1), { name, args }, `${method} ${path}`);
    }
  });

  it("never confirms a download credit unless the client does", async () => {
    const answer = { status: "requires_credit" };
    const { post, calls } = harness({ toolResults: { "audio-download": answer } });
    const response = await post("/api/songs/a/download", { format: "mp3" });
    assert.deepEqual(await response.json(), answer);
    assert.deepEqual(calls, [{ name: "audio-download", args: { id: "a", format: "mp3" } }]);
    assert.equal((await post("/api/songs/a/download", { confirm: "true" })).status, 400);
  });

  it("rejects invalid requests before calling Suno", async () => {
    const { send, calls } = harness();
    const invalid: Array<[string, string, unknown]> = [
      ["POST", "/api/speech", {}],
      ["POST", "/api/speech", { script: "a", prompt: "b" }],
      ["POST", "/api/speech", { prompt: "a", style: "calm" }],
      ["POST", "/api/speech", { prompt: "a", negative_style: "loud" }],
      ["POST", "/api/speech", { prompt: "a".repeat(2888), backing_music: true }],
      ["POST", "/api/speech", { script: "a", duration_strict: true }],
      ["POST", "/api/speech", { script: "a", model: "v6" }],
      ["PATCH", "/api/songs/a", {}],
      ["POST", "/api/songs/a/download", { format: "flac" }],
      ["GET", "/api/voices?limit=101", undefined],
      ["GET", "/api/playlists?limit=51", undefined],
      ["POST", "/api/playlists", {}],
      ["POST", "/api/playlists/p/songs", { clip_ids: [] }],
      ["DELETE", "/api/playlists/p/songs", { clip_ids: Array(101).fill("a") }],
      ["POST", "/api/workspaces", { name: "a".repeat(101) }],
      ["PATCH", "/api/workspaces/w/songs", {}],
      ["PATCH", "/api/workspaces/w/songs", { add: [], remove: [] }],
      ["PATCH", "/api/workspaces/w/songs", { add: Array(51).fill("a") }]
    ];
    for (const [method, path, body] of invalid) {
      assert.equal((await send(method, path, body)).status, 400, `${method} ${path} ${JSON.stringify(body)?.slice(0, 40)}`);
    }
    assert.equal(calls.length, 0);
  });
});

describe("model and credit guards", () => {
  const generationRoutes: Array<[string, Record<string, unknown>]> = [
    ["/api/songs", { instrumental: true }],
    ["/api/samples", { instrumental: true }],
    ["/api/songs/source/cover", {}],
    ["/api/songs/source/mashup", { additional_audio_id: "second" }],
    ["/api/songs/source/extend", { continue_at: 1 }]
  ];
  const created = (calls: Call[]) => calls.filter((call) => call.name !== "account-usage");

  it("lists the models this account may use", async () => {
    const { get } = harness({ toolResults: { "account-usage": usage } });
    assert.deepEqual(await (await get("/api/models")).json(), { allowed_models: usage.allowed_models });
    const missing = harness({ toolResults: { "account-usage": {} } });
    assert.deepEqual(await (await missing.get("/api/models")).json(), { allowed_models: [] });
  });

  it("rejects a model the account doesn't hold before spending credits", async () => {
    for (const [path, body] of generationRoutes) {
      const { post, calls } = harness({ toolResults: { "account-usage": usage } });
      const response = await post(path, { ...body, model: "v5" });
      assert.equal(response.status, 400, path);
      const error = await response.json() as { issues: Array<{ path: string; message: string }> };
      assert.equal(error.issues[0]?.path, "model");
      assert.match(error.issues[0]?.message ?? "", /v6-mini, v6, v6-wild/);
      assert.deepEqual(created(calls), []);
    }
  });

  it("forwards an allowed model, and leaves the choice to Suno when the list is absent", async () => {
    const allowed = harness({ toolResults: { "account-usage": usage } });
    assert.equal((await allowed.post("/api/songs", { instrumental: true, model: "v6-wild" })).status, 202);
    assert.equal(allowed.calls.at(-1)?.args.model, "v6-wild");
    const unknown = harness({ toolResults: { "account-usage": {} } });
    assert.equal((await unknown.post("/api/songs", { instrumental: true, model: "v7" })).status, 202);
    assert.equal(unknown.calls.at(-1)?.args.model, "v7");
  });

  it("skips the account lookup when no guard needs it", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/songs", { instrumental: true })).status, 202);
    assert.deepEqual(calls.map((call) => call.name), ["audio-create"]);
  });

  it("refuses generation below MIN_CREDITS_REMAINING", async () => {
    const low = harness({ toolResults: { "account-usage": usage }, options: { minCreditsRemaining: 101 } });
    for (const [path, body] of [...generationRoutes, ["/api/speech", { script: "Hello" }] as [string, Record<string, unknown>]]) {
      assert.equal((await low.post(path, body)).status, 402, path);
    }
    assert.deepEqual(created(low.calls), []);
    const enough = harness({ toolResults: { "account-usage": usage }, options: { minCreditsRemaining: 100 } });
    assert.equal((await enough.post("/api/songs", { instrumental: true })).status, 202);
    assert.equal(enough.calls.at(-1)?.name, "audio-create");
  });

  it("refuses generation when the credit balance can't be read", async () => {
    const { post, calls } = harness({ toolResults: { "account-usage": {} }, options: { minCreditsRemaining: 1 } });
    assert.equal((await post("/api/songs", { instrumental: true })).status, 502);
    assert.deepEqual(created(calls), []);
  });

  it("leaves joining and reads outside the credit guard", async () => {
    const { post, get } = harness({ toolResults: { "account-usage": usage }, options: { minCreditsRemaining: 101 } });
    assert.equal((await post("/api/songs/a/full-song", {})).status, 202);
    assert.equal((await get("/api/songs/a")).status, 200);
  });

  it("requires idempotency_key on generation when configured", async () => {
    const { post, calls } = harness({ options: { requireIdempotencyKey: true } });
    for (const [path, body] of generationRoutes) {
      const response = await post(path, body);
      assert.equal(response.status, 400, path);
      const error = await response.json() as { issues: Array<{ path: string }> };
      assert.equal(error.issues[0]?.path, "idempotency_key");
    }
    assert.equal((await post("/api/speech", { script: "Hello" })).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await post("/api/songs", { instrumental: true, idempotency_key: "one" })).status, 202);
    assert.equal(calls.at(-1)?.args.idempotency_key, "one");
  });
});

describe("generating and waiting in one request", () => {
  const clip = (id: string, status: string) => ({ id, status });

  it("waits for every created clip and returns both results", async () => {
    let round = 0;
    const { post, calls } = harness({
      toolResults: {
        "audio-create": { id: "a", clip_ids: ["a", "b"], status: "submitted" },
        "audio-wait": () => ++round === 1
          ? { clips: [clip("a", "complete"), clip("b", "queued")] }
          : { clips: [clip("b", "complete")] }
      }
    });
    const response = await post("/api/songs?wait=complete", { instrumental: true });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      created: { id: "a", clip_ids: ["a", "b"], status: "submitted" },
      clips: [clip("a", "complete"), clip("b", "complete")],
      pending: [],
      timed_out: false
    });
    assert.deepEqual(calls.filter((call) => call.name === "audio-wait").map((call) => call.args), [
      { ids: ["a", "b"], until: "complete" },
      { ids: ["b"], until: "complete" }
    ]);
  });

  it("supports the same wait on remix and speech routes", async () => {
    const requests: Array<[string, Record<string, unknown>]> = [
      ["/api/samples", { instrumental: true }],
      ["/api/songs/source/cover", {}],
      ["/api/songs/source/mashup", { additional_audio_id: "second" }],
      ["/api/songs/source/extend", { continue_at: 1 }],
      ["/api/speech", { script: "Hello" }]
    ];
    for (const [path, body] of requests) {
      const { post } = harness({
        toolResults: {
          "audio-create": { id: "a" }, "audio-covers-create": { id: "a" }, "audio-mashups-create": { id: "a" },
          "audio-extensions-create": { id: "a" }, "speech-create": { id: "a" }, "audio-wait": clip("a", "streaming")
        }
      });
      const response = await post(`${path}?wait=playable`, body);
      assert.equal(response.status, 200, path);
      assert.deepEqual((await response.json() as { clips: unknown }).clips, [clip("a", "streaming")]);
    }
  });

  it("keeps the created IDs when the wait times out", async () => {
    const { post } = harness({
      toolResults: { "audio-create": { id: "a" }, "audio-wait": clip("a", "queued") },
      options: { waitPollMs: 100 }
    });
    const response = await post("/api/songs?wait=complete&timeout=1", { instrumental: true });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      created: { id: "a" }, clips: [clip("a", "queued")], pending: ["a"], timed_out: true
    });
  });

  it("keeps the created IDs when waiting fails", async () => {
    const { post } = harness({
      toolResults: {
        "audio-create": { id: "a" },
        "audio-wait": () => { throw new SunoToolError({ error: "slow down", code: "rate_limited" }); }
      }
    });
    const response = await post("/api/songs?wait=complete", { instrumental: true });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      created: { id: "a" }, clips: [], pending: ["a"], timed_out: false,
      wait_error: { error: "Suno MCP tool failed", details: { error: "slow down", code: "rate_limited" } }
    });
  });

  it("reports a creation with no clip IDs instead of waiting", async () => {
    const { post, calls } = harness({ toolResults: { "audio-create": { status: "submitted" } } });
    const response = await post("/api/songs?wait=complete", { instrumental: true });
    assert.equal(response.status, 202);
    assert.deepEqual((await response.json() as { created: unknown }).created, { status: "submitted" });
    assert.equal(calls.some((call) => call.name === "audio-wait"), false);
  });

  it("rejects an invalid wait query before spending credits", async () => {
    const { post, calls } = harness();
    for (const query of ["wait=done", "timeout=10", "wait=complete&timeout=0", "wait=complete&timeout=601", "wiat=complete"]) {
      assert.equal((await post(`/api/songs?${query}`, { instrumental: true })).status, 400, query);
    }
    assert.equal(calls.length, 0);
  });
});

describe("waiting for many clips", () => {
  const clip = (id: string, status: string) => ({ id, status });
  const settle = (args: Record<string, unknown>) => ({
    clips: (args.ids as string[]).map((id) => clip(id, "complete"))
  });

  it("splits the IDs into batches of four and deduplicates them", async () => {
    const { post, calls } = harness({ toolResults: { "audio-wait": settle } });
    const ids = ["a", "b", "c", "d", "e", "f", "a"];
    const response = await post("/api/songs/wait-all", { ids, until: "complete" });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.map((call) => call.args), [
      { ids: ["a", "b", "c", "d"], until: "complete" },
      { ids: ["e", "f"], until: "complete" }
    ]);
    const body = await response.json() as { clips: Array<{ id: string }>; pending: string[]; timed_out: boolean };
    assert.deepEqual(body.clips.map((item) => item.id).sort(), ["a", "b", "c", "d", "e", "f"]);
    assert.deepEqual(body.pending, []);
    assert.equal(body.timed_out, false);
  });

  it("settles on Suno's real shape for a clip it can't read", async () => {
    const unread = { id: "missing", error: "audio not found", code: "not_found" };
    const { post, calls } = harness({
      toolResults: { "audio-wait": { id: "a", status: "complete", error: null, clips: [{ id: "a", status: "complete", error: null }, unread] } }
    });
    const response = await post("/api/songs/wait-all", { ids: ["a", "missing"] });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { clips: unknown[] }).clips[1], unread);
    assert.equal(calls.length, 1);
  });

  it("stops at streaming for playable and keeps polling for complete", async () => {
    const playable = harness({ toolResults: { "audio-wait": clip("a", "streaming") } });
    assert.equal((await playable.post("/api/songs/wait-all", { ids: ["a"] })).status, 200);
    assert.equal(playable.calls.length, 1);
    const complete = harness({
      toolResults: { "audio-wait": clip("a", "streaming") }, options: { waitPollMs: 100 }
    });
    const response = await complete.post("/api/songs/wait-all", { ids: ["a"], until: "complete", timeout: 1 });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { clips: [clip("a", "streaming")], pending: ["a"], timed_out: true });
  });

  it("treats a failed generation as settled", async () => {
    const { post } = harness({ toolResults: { "audio-wait": clip("a", "error") } });
    assert.equal((await post("/api/songs/wait-all", { ids: ["a"], until: "complete" })).status, 200);
  });

  it("returns the upstream status when nothing could be read", async () => {
    const { post } = harness({
      toolResults: { "audio-wait": () => { throw new SunoToolError({ error: "gone", code: "not_found" }); } }
    });
    assert.equal((await post("/api/songs/wait-all", { ids: ["a"] })).status, 404);
  });

  it("returns finished clips when another batch fails", async () => {
    const { post } = harness({
      toolResults: {
        "audio-wait": (args) => {
          if ((args.ids as string[]).includes("e")) throw new SunoToolError({ error: "slow down", code: "rate_limited" });
          return settle(args);
        }
      }
    });
    const response = await post("/api/songs/wait-all", { ids: ["a", "b", "c", "d", "e"] });
    assert.equal(response.status, 202);
    const body = await response.json() as { clips: unknown[]; pending: string[]; wait_error: { details: { code: string } } };
    assert.equal(body.clips.length, 4);
    assert.deepEqual(body.pending, ["e"]);
    assert.equal(body.wait_error.details.code, "rate_limited");
  });

  it("rejects empty and oversized lists", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/songs/wait-all", { ids: [] })).status, 400);
    assert.equal((await post("/api/songs/wait-all", { ids: Array.from({ length: 21 }, (_, i) => `${i}`) })).status, 400);
    assert.equal((await post("/api/songs/wait-all", { ids: ["a"], timeout: 601 })).status, 400);
    assert.equal(calls.length, 0);
  });
});

describe("clip status events", () => {
  const clip = (id: string, status: string) => ({ id, status });
  const events = (text: string) => text.trim().split("\n\n").map((block) => ({
    event: /^event: (.*)$/m.exec(block)?.[1],
    data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null") as unknown
  }));

  it("sends each status change once, then done", async () => {
    const rounds = [clip("a", "queued"), clip("a", "queued"), clip("a", "streaming"), clip("a", "complete")];
    let round = 0;
    const { get } = harness({ toolResults: { "audio-wait": () => rounds[round++] } });
    const response = await get("/api/songs/events?ids=a&until=complete");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /text\/event-stream/);
    assert.deepEqual(events(await response.text()), [
      { event: "clip", data: clip("a", "queued") },
      { event: "clip", data: clip("a", "streaming") },
      { event: "clip", data: clip("a", "complete") },
      { event: "done", data: { pending: [], timed_out: false } }
    ]);
  });

  it("reports a failed wait as a failed event", async () => {
    const { get } = harness({
      toolResults: { "audio-wait": () => { throw new SunoToolError({ error: "slow down", code: "rate_limited" }); } }
    });
    assert.deepEqual(events(await (await get("/api/songs/events?ids=a")).text()), [{
      event: "failed",
      data: { error: "Suno MCP tool failed", details: { error: "slow down", code: "rate_limited" } }
    }]);
  });

  it("reports a timeout in the done event", async () => {
    const { get } = harness({
      toolResults: { "audio-wait": clip("a", "queued") }, options: { waitPollMs: 100 }
    });
    const received = events(await (await get("/api/songs/events?ids=a&until=complete&timeout=1")).text());
    assert.deepEqual(received.at(-1), { event: "done", data: { pending: ["a"], timed_out: true } });
  });

  it("validates the query and requires authentication", async () => {
    const { app, get, url, calls } = harness();
    assert.equal((await get("/api/songs/events")).status, 400);
    assert.equal((await get("/api/songs/events?ids=,")).status, 400);
    assert.equal((await get("/api/songs/events?ids=a&until=done")).status, 400);
    assert.equal((await app.request(url("/api/songs/events?ids=a"))).status, 401);
    assert.equal(calls.length, 0);
  });
});

describe("generic tool protections", () => {
  it("requires an explicit allowlist entry for arbitrary tools", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/tools/audio-create/call", { description: "surprise" })).status, 403);
    assert.equal(calls.length, 0);
    assert.equal((await post("/api/tools/audio-retrieve/call", { id: "source1" })).status, 200);
  });
});
