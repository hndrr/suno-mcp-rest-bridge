import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createApp, type BridgeDependencies } from "../src/app.js";
import { BridgeError, getUploadSession, putSignedUpload } from "../src/upload.js";
import type { JsonValue } from "../src/suno.js";

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
  toolResults = {}
}: { uploadResult?: JsonValue; maxUploadBytes?: number; toolResults?: Record<string, JsonValue> } = {}) {
  const calls: Call[] = [];
  const uploaded: { url: string; bytes: Uint8Array }[] = [];
  const tools: BridgeDependencies = {
    callTool: async (name, args) => {
      const schema = upstreamSchemas.get(name);
      assert.ok(schema, `Missing upstream contract for ${name}`);
      for (const key of Object.keys(args)) {
        assert.ok(Object.hasOwn(schema.properties, key), `${name} does not accept ${key}`);
      }
      for (const key of schema.required ?? []) {
        assert.notEqual(args[key], undefined, `${name} requires ${key}`);
      }
      calls.push({ name, args });
      if (Object.hasOwn(toolResults, name)) return toolResults[name];
      if (name === "audio-upload-create") return uploadResult;
      if (name === "audio-upload-complete") return { id: "source-clip", status: "processing" };
      return { ok: true, name, args };
    },
    listTools: async () => [],
    putUpload: async (url, bytes) => { uploaded.push({ url, bytes }); }
  };
  const app = createApp({ apiKey: "test-secret", tools, maxUploadBytes });
  const url = (path: string) => `http://localhost${path}`;
  const auth = { Authorization: "Bearer test-secret" };
  const post = async (path: string, body: unknown): Promise<Response> =>
    app.request(url(path), {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  const get = async (path: string): Promise<Response> => app.request(url(path), { headers: auth });
  return { app, calls, uploaded, post, get, auth, url };
}

describe("authentication and generated samples", () => {
  it("serves API discovery at the root without credentials or a Suno connection", async () => {
    const { app, calls, url } = harness();
    const res = await app.request(url("/"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /application\/json/);
    const responseText = await res.text();
    const body = JSON.parse(responseText) as { service: string; health: string; endpoints: Record<string, string> };
    assert.equal(body.service, "suno-mcp-rest-bridge");
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
        assert.equal((await post(path, { ...body, clip_count })).status, 400, path);
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

describe("generic tool protections", () => {
  it("requires an explicit allowlist entry for arbitrary tools", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/tools/audio-create/call", { description: "surprise" })).status, 403);
    assert.equal(calls.length, 0);
    assert.equal((await post("/api/tools/audio-retrieve/call", { id: "source1" })).status, 200);
  });
});
