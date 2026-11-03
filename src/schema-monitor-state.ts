import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeSchemaAuthState, type SchemaAuthState } from "./schema-monitor-auth.js";

function stateKey(key: string): Buffer {
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== 32) throw new Error("SUNO_SCHEMA_STATE_KEY must contain a base64-encoded 32-byte key.");
  return bytes;
}

export function encryptSchemaAuth(state: SchemaAuthState, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", stateKey(key), iv);
  cipher.setAAD(Buffer.from(state.generation));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  return JSON.stringify({
    version: 1, generation: state.generation, iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64")
  });
}

export function decryptSchemaAuth(encoded: string, key: string, generation: string): SchemaAuthState {
  try {
    const envelope = JSON.parse(encoded);
    if (envelope.version !== 1 || envelope.generation !== generation) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", stateKey(key), Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(generation));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
    const state = decodeSchemaAuthState(plain.toString("utf8"));
    if (state.generation !== generation) throw new Error();
    return state;
  } catch {
    throw new Error("Could not decrypt the saved OAuth state. Check the secrets or run setup again.");
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing. Run npm run setup:schema-monitor.`);
  return value;
}

function github<T>(path: string): T {
  return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

type MonitorRun = { id: number; status: string; event: string; head_branch: string; head_repository?: { full_name: string } };
type AuthArtifact = { name: string; expired: boolean };

export function findAuthArtifact(
  runs: MonitorRun[],
  repository: string,
  defaultBranch: string,
  artifactName: string,
  artifacts: (runId: number) => AuthArtifact[],
  currentRunId?: number
): number | undefined {
  for (const run of runs) {
    if ((run.status !== "completed" && run.id !== currentRunId) || run.head_branch !== defaultBranch ||
      run.head_repository?.full_name !== repository || !["schedule", "workflow_dispatch"].includes(run.event)) continue;
    if (artifacts(run.id).some((artifact) => artifact.name === artifactName && !artifact.expired)) return run.id;
  }
}

function main() {
  const command = process.argv[2];
  const authFile = requiredEnv("SUNO_SCHEMA_AUTH_FILE");
  if (command === "find") {
    const seed = decodeSchemaAuthState(requiredEnv("SUNO_SCHEMA_AUTH"));
    const artifactName = `suno-schema-auth-${seed.generation}`;
    const repository = requiredEnv("GITHUB_REPOSITORY");
    const branch = requiredEnv("SCHEMA_DEFAULT_BRANCH");
    const runs = github<{ workflow_runs: MonitorRun[] }>(`repos/${repository}/actions/workflows/suno-schema.yml/runs?branch=${encodeURIComponent(branch)}&per_page=100`).workflow_runs;
    const previous = findAuthArtifact(runs, repository, branch, artifactName,
      (runId) => github<{ artifacts: AuthArtifact[] }>(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`).artifacts,
      Number(process.env.GITHUB_RUN_ID));
    appendFileSync(requiredEnv("GITHUB_OUTPUT"), `artifact_name=${artifactName}\nrun_id=${previous ?? ""}\n`);
  } else if (command === "restore") {
    const seed = decodeSchemaAuthState(requiredEnv("SUNO_SCHEMA_AUTH"));
    const saved = requiredEnv("SUNO_SCHEMA_ENCRYPTED_INPUT");
    const key = requiredEnv("SUNO_SCHEMA_STATE_KEY");
    stateKey(key);
    const state = existsSync(saved) ? decryptSchemaAuth(readFileSync(saved, "utf8"), key, seed.generation) : seed;
    if (!state.tokens?.refresh_token || !state.clientInformation) throw new Error("OAuth setup is incomplete. Run setup again.");
    writeFileSync(authFile, JSON.stringify(state), { mode: 0o600 });
  } else if (command === "seal") {
    const state = decodeSchemaAuthState(readFileSync(authFile, "utf8"));
    writeFileSync(requiredEnv("SUNO_SCHEMA_ENCRYPTED_OUTPUT"), encryptSchemaAuth(state, requiredEnv("SUNO_SCHEMA_STATE_KEY")), { mode: 0o600 });
  } else {
    throw new Error("Expected find, restore, or seal.");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not prepare the schema monitor credentials.");
    process.exitCode = 1;
  }
}
