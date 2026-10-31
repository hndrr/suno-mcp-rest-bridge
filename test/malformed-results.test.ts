import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";

// Runs the real server, MCP client and mcp-remote against a local MCP server, because the client
// decides which results reach the bridge. Suno itself can't be made to send these, so this never
// contacts it and spends no credits.
const mixedMedia = {
  content: [{ type: "text", text: "[1,2]" }, { type: "audio", data: "AA==", mimeType: "audio/wav" }]
};
const nullStructured = { structuredContent: null, content: [{ type: "text", text: "{}" }] };
const shapes: Record<string, unknown> = { mixedMedia, nullStructured };

const json = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

const createCalls: string[] = [];

function toolResult(name: string, args: Record<string, unknown>): unknown {
  if (name === "audio-create") {
    const description = args.description as string;
    createCalls.push(description);
    // "clip:<id>" creates that clip, so the ID can select the result of the wait that follows.
    const id = description.replace("clip:", "");
    return shapes[description] ?? json({ id, clip_ids: [id], status: "submitted" });
  }
  if (name === "audio-wait") {
    const ids = args.ids as string[];
    const shape = ids.map((id) => shapes[id]).find(Boolean);
    return shape ?? json({ clips: ids.map((id) => ({ id, status: "complete", error: null })) });
  }
  return json({});
}

const fakeMcp = createServer(async (request, response) => {
  if (request.method !== "POST") {
    response.writeHead(request.method === "DELETE" ? 200 : 405).end();
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const { id, method, params } = JSON.parse(body);
  if (id === undefined) {
    response.writeHead(202).end();
    return;
  }
  const result = method === "initialize"
    ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
    : method === "tools/list"
      ? { tools: ["audio-create", "audio-wait"].map((name) => ({ name, inputSchema: { type: "object" } })) }
      : method === "tools/call" ? toolResult(params.name, params.arguments ?? {}) : {};
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
});

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const probe = createNetServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, "close");
  return port;
}

describe("malformed results over the real MCP transport", () => {
  const headers = { Authorization: "Bearer e2e-key", "Content-Type": "application/json" };
  let base: string;
  let bridge: ChildProcess;
  let authDir: string;

  const create = async (description: string) => fetch(`${base}/api/songs?wait=complete&timeout=2`, {
    method: "POST", headers, body: JSON.stringify({ description })
  });
  const waitAll = async (ids: string[]) => fetch(`${base}/api/songs/wait-all`, {
    method: "POST", headers, body: JSON.stringify({ ids, until: "complete", timeout: 2 })
  });

  before(async () => {
    const mcpPort = await listen(fakeMcp);
    const bridgePort = await freePort();
    authDir = mkdtempSync(join(tmpdir(), "suno-bridge-e2e-"));
    bridge = spawn(process.execPath, ["--import=tsx", "src/server.ts"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        API_KEY: "e2e-key",
        HOST: "127.0.0.1",
        PORT: String(bridgePort),
        SUNO_MCP_URL: `http://localhost:${mcpPort}/mcp`,
        MCP_REMOTE_CONFIG_DIR: authDir
      },
      stdio: "ignore"
    });
    base = `http://127.0.0.1:${bridgePort}`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fetch(`${base}/health`);
        break;
      } catch (error) {
        if (attempt === 80) throw error;
        await delay(250);
      }
    }
  });

  after(async () => {
    const exited = once(bridge, "exit");
    bridge.kill("SIGTERM");
    await exited;
    fakeMcp.closeAllConnections();
    fakeMcp.close();
    rmSync(authDir, { recursive: true, force: true });
  });

  it("waits for a well-formed creation", async () => {
    const response = await create("good");
    assert.equal(response.status, 200);
    const body = await response.json() as { clips: Array<{ id: string }> };
    assert.deepEqual(body.clips.map((clip) => clip.id), ["good"]);
  });

  it("keeps a creation result it can't read", async () => {
    const response = await create("mixedMedia");
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      created: mixedMedia, clips: [], pending: [], timed_out: false,
      wait_error: { error: "Suno returned no clip IDs to wait for" }
    });
  });

  it("loses a creation result the MCP client rejects, though Suno received the call", async () => {
    const response = await create("nullStructured");
    assert.equal(response.status, 502);
    assert.equal("created" in (await response.json() as object), false);
    assert.equal(createCalls.includes("nullStructured"), true);
  });

  it("keeps the created IDs when it can't read a wait result", async () => {
    const response = await create("clip:mixedMedia");
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      created: { id: "mixedMedia", clip_ids: ["mixedMedia"], status: "submitted" },
      clips: [], pending: ["mixedMedia"], timed_out: false,
      wait_error: { error: "Unexpected response from Suno" }
    });
  });

  it("keeps the created IDs when the MCP client rejects a wait result", async () => {
    const response = await create("clip:nullStructured");
    assert.equal(response.status, 202);
    const body = await response.json() as { created: unknown; pending: string[]; wait_error: unknown };
    assert.deepEqual(body.created, { id: "nullStructured", clip_ids: ["nullStructured"], status: "submitted" });
    assert.deepEqual(body.pending, ["nullStructured"]);
    assert.ok(body.wait_error);
  });

  it("returns 502 when the only wait result can't be read", async () => {
    const response = await waitAll(["mixedMedia"]);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Unexpected response from Suno" });
  });

  it("returns finished clips when another batch can't be read", async () => {
    const response = await waitAll(["a", "b", "c", "d", "mixedMedia"]);
    assert.equal(response.status, 202);
    const body = await response.json() as { clips: unknown[]; pending: string[]; wait_error: unknown };
    assert.equal(body.clips.length, 4);
    assert.deepEqual(body.pending, ["mixedMedia"]);
    assert.deepEqual(body.wait_error, { error: "Unexpected response from Suno" });
  });

  it("returns finished clips when the MCP client rejects another batch", async () => {
    const response = await waitAll(["a", "b", "c", "d", "nullStructured"]);
    assert.equal(response.status, 202);
    const body = await response.json() as { clips: unknown[]; pending: string[]; wait_error: unknown };
    assert.equal(body.clips.length, 4);
    assert.deepEqual(body.pending, ["nullStructured"]);
    assert.ok(body.wait_error);
  });

  it("reports a wait result it can't read as a failed event", async () => {
    const response = await fetch(`${base}/api/songs/events?ids=mixedMedia&until=complete`, { headers });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: failed/);
    assert.match(text, /Unexpected response from Suno/);
  });
});
