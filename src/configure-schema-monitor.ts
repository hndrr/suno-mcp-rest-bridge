import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/client";
import {
  listSchemaMonitorTools, parseSchemaAuthState, SchemaMonitorAuth, schemaMonitorEndpoint
} from "./schema-monitor-auth.js";

const repository = process.argv[2];
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
  console.error("Usage: npm run setup:schema-monitor -- OWNER/REPO");
  process.exit(1);
}
const actual = execFileSync("gh", ["repo", "view", repository, "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { encoding: "utf8" }).trim();
if (actual !== repository) throw new Error("The GitHub repository did not match the requested destination.");

const directory = mkdtempSync(join(tmpdir(), "suno-schema-auth-"));
const file = join(directory, "auth.json");
let provider: SchemaMonitorAuth;
let resolveCallback: (value: { code: string; iss?: string }) => void;
const callback = new Promise<{ code: string; iss?: string }>((resolve) => { resolveCallback = resolve; });
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const code = url.searchParams.get("code");
  if (url.pathname !== "/callback" || url.searchParams.get("state") !== provider.oauthState || !code) {
    response.writeHead(400).end("Authorization did not complete. Return to the terminal.");
    return;
  }
  response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
    .end("Suno schema monitor authorized. You can return to Codex.");
  resolveCallback({ code, iss: url.searchParams.get("iss") ?? undefined });
});

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not open the OAuth callback.");
  writeFileSync(file, JSON.stringify({
    version: 1, generation: randomUUID(), redirectUrl: `http://127.0.0.1:${address.port}/callback`
  }), { mode: 0o600 });
  provider = new SchemaMonitorAuth(file, (url) => {
    console.log("Authorize the dedicated Suno schema monitor in the browser.");
    if (process.platform === "darwin") {
      execFileSync("/usr/bin/open", [url.toString()]);
    } else {
      console.log(url.toString());
    }
  });
  const result = await auth(provider, { serverUrl: schemaMonitorEndpoint });
  if (result === "REDIRECT") {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const authorization = await Promise.race([
        callback,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Suno authorization timed out. Run setup again.")), 300_000);
        })
      ]);
      await auth(provider, { serverUrl: schemaMonitorEndpoint, authorizationCode: authorization.code, iss: authorization.iss });
    } finally {
      clearTimeout(timer);
    }
  }
  // Exercise the refresh grant before uploading credentials for an unattended job.
  await auth(provider, { serverUrl: schemaMonitorEndpoint });
  const tools = await listSchemaMonitorTools(file);
  const state = parseSchemaAuthState(JSON.parse(readFileSync(file, "utf8")));
  if (!state.tokens?.refresh_token) throw new Error("Suno did not issue an offline refresh token.");
  const setSecret = (name: string, value: string) => execFileSync("gh", ["secret", "set", name, "--repo", repository], {
    input: value, stdio: ["pipe", "ignore", "pipe"]
  });
  setSecret("SUNO_SCHEMA_AUTH", JSON.stringify(state));
  setSecret("SUNO_SCHEMA_STATE_KEY", randomBytes(32).toString("base64"));
  console.log(`Verified tools/list (${tools.length} tools) and token refresh. Saved the two Actions secrets in ${repository}.`);
} catch {
  console.error("Could not configure schema monitoring. Check Suno authorization and GitHub repository access, then run setup again.");
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
}
