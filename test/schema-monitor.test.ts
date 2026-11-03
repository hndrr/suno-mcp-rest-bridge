import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { auth } from "@modelcontextprotocol/client";
import { decodeSchemaAuthState, SchemaMonitorAuth, schemaMonitorScope, type SchemaAuthState } from "../src/schema-monitor-auth.js";
import { decryptSchemaAuth, encryptSchemaAuth, findAuthArtifact } from "../src/schema-monitor-state.js";

const seed = (): SchemaAuthState => ({
  version: 1, generation: randomUUID(), redirectUrl: "http://127.0.0.1:12345/callback",
  clientInformation: { client_id: "monitor-client", issuer: "http://127.0.0.1:12346/oauth" },
  tokens: { access_token: "test-access", refresh_token: "test-refresh", token_type: "Bearer", scope: schemaMonitorScope,
    issuer: "http://127.0.0.1:12346/oauth" }
});

describe("schema monitor credentials", () => {
  it("encrypts credentials and rejects tampering, wrong keys, and another authorization generation", () => {
    const state = seed();
    const key = randomBytes(32).toString("base64");
    const sealed = encryptSchemaAuth(state, key);
    assert.ok(!sealed.includes("test-refresh"));
    assert.deepEqual(decryptSchemaAuth(sealed, key, state.generation), state);
    assert.throws(() => decryptSchemaAuth(sealed, randomBytes(32).toString("base64"), state.generation));
    assert.throws(() => decryptSchemaAuth(sealed, key, randomUUID()));
    const modified = JSON.parse(sealed);
    const bytes = Buffer.from(modified.data, "base64");
    bytes[0] ^= 1;
    modified.data = bytes.toString("base64");
    assert.throws(() => decryptSchemaAuth(JSON.stringify(modified), key, state.generation));
  });

  it("refreshes non-interactively and saves the rotated token for the next run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "schema-monitor-test-"));
    const file = join(directory, "auth.json");
    try {
      writeFileSync(file, JSON.stringify(seed()));
      const provider = new SchemaMonitorAuth(file);
      let refreshes = 0;
      const result = await auth(provider, {
        serverUrl: "http://127.0.0.1:12346/mcp",
        fetchFn: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.pathname.includes("oauth-protected-resource")) return Response.json({
            resource: "http://127.0.0.1:12346/mcp", authorization_servers: ["http://127.0.0.1:12346/oauth"]
          });
          if (url.pathname.includes(".well-known")) return Response.json({
            issuer: "http://127.0.0.1:12346/oauth", authorization_endpoint: "http://127.0.0.1:12346/authorize",
            token_endpoint: "http://127.0.0.1:12346/token", response_types_supported: ["code"],
            token_endpoint_auth_methods_supported: ["none"]
          });
          assert.equal(url.pathname, "/token");
          const body = new URLSearchParams(init?.body as string);
          assert.equal(body.get("grant_type"), "refresh_token");
          assert.equal(body.get("refresh_token"), "test-refresh");
          assert.equal(body.get("scope"), schemaMonitorScope);
          refreshes++;
          return Response.json({ access_token: "new-access", refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 3600 });
        }
      });
      assert.equal(result, "AUTHORIZED");
      assert.equal(refreshes, 1);
      const saved = decodeSchemaAuthState(readFileSync(file, "utf8"));
      assert.equal(saved.tokens?.refresh_token, "rotated-refresh");
      provider.saveTokens({ access_token: "next-access", token_type: "Bearer" });
      assert.equal(new SchemaMonitorAuth(file).tokens()?.refresh_token, "rotated-refresh");
      assert.equal(provider.scopeForRefresh(saved.tokens!), schemaMonitorScope);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("fails without opening a browser and does not leak malformed credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "schema-monitor-test-"));
    const file = join(directory, "auth.json");
    try {
      writeFileSync(file, JSON.stringify(seed()));
      await assert.rejects(new SchemaMonitorAuth(file).redirectToAuthorization(new URL("https://example.com")), /authorization expired/);
      writeFileSync(file, "test-private-credential-that-is-not-json");
      const result = spawnSync(process.execPath, ["--import=tsx", "src/check-schema.ts", "--json"], {
        env: { ...process.env, SUNO_SCHEMA_AUTH_FILE: file }, encoding: "utf8"
      });
      assert.equal(result.status, 2);
      assert.equal(JSON.parse(result.stdout).status, "error");
      assert.ok(!`${result.stdout}${result.stderr}`.includes("test-private-credential"));
      const before = readFileSync("test/fixtures/suno-input-schemas.json", "utf8");
      assert.throws(() => execFileSync(process.execPath, ["--import=tsx", "src/check-schema.ts", "--update"], {
        env: { ...process.env, SUNO_SCHEMA_AUTH_FILE: file }, stdio: "pipe"
      }));
      assert.equal(readFileSync("test/fixtures/suno-input-schemas.json", "utf8"), before);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("binds the authorization callback to the discovered issuer before exchanging a code", async () => {
    const directory = mkdtempSync(join(tmpdir(), "schema-monitor-test-"));
    const file = join(directory, "auth.json");
    try {
      writeFileSync(file, JSON.stringify({ ...seed(), tokens: undefined }));
      let redirected = false;
      let tokenRequests = 0;
      const provider = new SchemaMonitorAuth(file, () => { redirected = true; });
      const options = {
        serverUrl: "http://127.0.0.1:12346/mcp",
        fetchFn: async (input: string | URL | Request) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.pathname.includes("oauth-protected-resource")) return Response.json({
            resource: "http://127.0.0.1:12346/mcp", authorization_servers: ["http://127.0.0.1:12346/oauth"]
          });
          if (url.pathname.includes(".well-known")) return Response.json({
            issuer: "http://127.0.0.1:12346/oauth", authorization_endpoint: "http://127.0.0.1:12346/authorize",
            token_endpoint: "http://127.0.0.1:12346/token", response_types_supported: ["code"],
            token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"]
          });
          tokenRequests++;
          throw new Error("The mismatched callback must be rejected before the token exchange.");
        }
      };
      assert.equal(await auth(provider, options), "REDIRECT");
      assert.ok(redirected);
      assert.ok(provider.discoveryState());
      await assert.rejects(auth(provider, { ...options, authorizationCode: "test-code", iss: "https://wrong-issuer.example" }));
      assert.equal(tokenRequests, 0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("finding saved OAuth state", () => {
  const run = (id: number, overrides = {}) => ({
    id, status: "completed", event: "schedule", head_branch: "main",
    head_repository: { full_name: "owner/repo" }, ...overrides
  });
  const artifact = { name: "suno-schema-auth-generation", expired: false };

  it("uses state from failed schema checks while ignoring pull requests, forks, and unfinished runs", () => {
    const requested: number[] = [];
    const result = findAuthArtifact([
      run(8, { event: "pull_request" }), run(7, { head_repository: { full_name: "fork/repo" } }),
      run(6, { status: "in_progress" }), run(5), run(4), run(3)
    ], "owner/repo", "main", artifact.name, (id) => {
      requested.push(id);
      return id === 5 ? [{ ...artifact, expired: true }] : [artifact];
    });
    assert.equal(result, 4);
    assert.deepEqual(requested, [5, 4]);
  });

  it("restores the current run's previous attempt when rerunning a job", () => {
    assert.equal(findAuthArtifact([run(9, { status: "in_progress" }), run(8)],
      "owner/repo", "main", artifact.name, () => [artifact], 9), 9);
  });

  it("bootstraps a new authorization generation instead of using an older session", () => {
    assert.equal(findAuthArtifact([run(3)], "owner/repo", "main", "new-generation", () => [artifact]), undefined);
  });
});
