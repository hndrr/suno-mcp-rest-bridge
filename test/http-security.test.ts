import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { createApp } from "../src/app.js";

it("rejects raw backslashes in HTTP paths before routing to Suno", async (t) => {
  const calls: string[] = [];
  const app = createApp({
    apiKey: "test-secret",
    tools: {
      callTool: async (name) => { calls.push(name); return { ok: true }; },
      listTools: async () => []
    }
  });
  const server = createAdaptorServer({ fetch: app.fetch });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const get = (path: string, authenticated = true) => new Promise<number>((resolve, reject) => {
    // The path option preserves raw backslashes that fetch() would normalize away.
    const req = request({
      hostname: "127.0.0.1", port, path, agent: false,
      headers: authenticated ? { Authorization: "Bearer test-secret" } : {}
    }, (res) => {
      res.on("error", reject);
      res.on("end", () => resolve(res.statusCode!));
      res.resume();
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("HTTP security test timed out")));
    req.end();
  });

  for (const path of ["/api\\usage", "/public\\..\\api/usage"]) {
    assert.equal(await get(path), 400, path);
  }
  assert.deepEqual(calls, []);

  // Query backslashes and percent-encoded backslashes remain valid HTTP targets.
  assert.equal(await get("/api/usage?value=\\"), 200);
  assert.equal(await get("/api/songs/%5C"), 200);
  assert.deepEqual(calls, ["account-usage", "audio-retrieve"]);

  calls.length = 0;
  for (const path of ["/api/usage", "/api/songs/%5C", "/api/songs/%0A", "/api/songs/%0D",
    "/api/songs/%E2%80%A8", "/api/songs/%E2%80%A9"]) {
    assert.equal(await get(path, false), 401, path);
  }
  assert.deepEqual(calls, []);
});
