import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp, type BridgeDependencies } from "../src/app.js";
import { BridgeError, getUploadSession, putSignedUpload } from "../src/upload.js";
import type { JsonValue } from "../src/suno.js";

type Call = { name: string; args: Record<string, unknown> };

function harness({
  uploadResult = { id: "session-123", upload_url: "https://storage.example.net/upload" } as JsonValue,
  maxUploadBytes = 1024 * 1024
}: { uploadResult?: JsonValue; maxUploadBytes?: number } = {}) {
  const calls: Call[] = [];
  const uploaded: { url: string; bytes: Uint8Array }[] = [];
  const tools: BridgeDependencies = {
    callTool: async (name, args) => {
      calls.push({ name, args });
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
  it("rejects missing or wrong credentials", async () => {
    const { app, url } = harness();
    assert.equal((await app.request(url("/api/usage"))).status, 401);
    assert.equal((await app.request(url("/api/usage"), {
      headers: { Authorization: "Bearer wrong" }
    })).status, 401);
    assert.equal((await app.request(url("/health"))).status, 200);
  });

  it("forces a single clip on ordinary song creation by default", async () => {
    const { post, calls } = harness();
    const res = await post("/api/songs", { description: "bright pop", duration: 30 });
    assert.equal(res.status, 202);
    assert.equal(calls.at(-1)?.name, "audio-create");
    assert.equal(calls.at(-1)?.args.clip_count, 1);
    assert.equal(calls.at(-1)?.args.duration, 30);
  });

  it("defaults samples to 15 seconds, strict duration and one clip", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/samples", { instrumental: true })).status, 202);
    assert.deepEqual({
      duration: calls.at(-1)?.args.duration,
      count: calls.at(-1)?.args.clip_count,
      strict: calls.at(-1)?.args.duration_strict,
      guidance: calls.at(-1)?.args.duration_guidance
    }, { duration: 15, count: 1, strict: true, guidance: true });
  });

  it("validates duration, prompt modes and unsupported sample clip count", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/samples", { description: "a", duration: 10 })).status, 400);
    assert.equal((await post("/api/samples", { description: "a", clip_count: 2 })).status, 400);
    assert.equal((await post("/api/songs", { description: "a", style: "jazz" })).status, 400);
    assert.equal((await post("/api/songs", { description: "a", controls: { audio_influence: .6 } })).status, 400);
    assert.equal(calls.length, 0);
  });

  it("passes through custom lyrics, style, advanced controls and explicit clip_count", async () => {
    const { post, calls } = harness();
    assert.equal((await post("/api/songs", {
      lyrics: "hello", style: "indie pop", clip_count: 2,
      controls: { style_influence: 0.5, weirdness: 0.2 }, idempotency_key: "demo-1"
    })).status, 202);
    assert.equal(calls.at(-1)?.args.clip_count, 2);
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
      args: { id: "source-id", clip_count: 1, duration: 30, style: "bright hi-fi pop", controls: { audio_influence: 0.7 } }
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
