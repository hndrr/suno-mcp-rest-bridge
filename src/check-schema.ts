import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffToolSchemas, normalizeSchema, type ToolSchema } from "./schema-diff.js";
import { closeSunoClient, listSunoTools } from "./suno.js";
import { listSchemaMonitorTools } from "./schema-monitor-auth.js";

const snapshotUrl = new URL("../test/fixtures/suno-input-schemas.json", import.meta.url);
const json = process.argv.includes("--json");
const reportDirectory = process.env.SUNO_SCHEMA_REPORT_DIR;

function report(value: Record<string, unknown>, summary: string) {
  if (json) console.log(JSON.stringify(value));
  if (reportDirectory) {
    mkdirSync(reportDirectory, { recursive: true });
    writeFileSync(join(reportDirectory, "report.json"), `${JSON.stringify(value, null, 2)}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

try {
  const snapshot = JSON.parse(readFileSync(snapshotUrl, "utf8")) as { endpoint: string; tools: ToolSchema[] };
  if (process.env.SUNO_SCHEMA_AUTH_FILE && process.argv.includes("--update")) {
    throw new Error("The scheduled monitor cannot update the schema baseline.");
  }
  const live = process.env.SUNO_SCHEMA_AUTH_FILE
    ? await listSchemaMonitorTools(process.env.SUNO_SCHEMA_AUTH_FILE)
    : await listSunoTools();

  if (process.argv.includes("--update")) {
    const tools = live
      .map(({ name, inputSchema }) => ({ name, inputSchema: normalizeSchema(inputSchema) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const updated = { endpoint: snapshot.endpoint, retrieved_at: new Date().toISOString(), tools };
    writeFileSync(snapshotUrl, `${JSON.stringify(updated, null, 2)}\n`);
    console.log(`Updated the snapshot with ${tools.length} tools.`);
  } else {
    const { missing, added, changed } = diffToolSchemas(snapshot.tools, live);
    const drift = missing.length > 0 || changed.length > 0 || added.length > 0;
    if (reportDirectory) {
      mkdirSync(reportDirectory, { recursive: true });
      writeFileSync(join(reportDirectory, "live-schemas.json"), `${JSON.stringify({
        endpoint: snapshot.endpoint,
        tools: live.map(({ name, inputSchema }) => ({ name, inputSchema: normalizeSchema(inputSchema) }))
          .sort((a, b) => a.name.localeCompare(b.name))
      }, null, 2)}\n`);
    }
    const result = { status: drift ? "changed" : "unchanged", checked_at: new Date().toISOString(),
      tool_count: live.length, missing, added, changed };
    // JSON inside an indented code block keeps upstream names from injecting Markdown.
    report(result, `## Suno MCP schema check: ${result.status}\n\n${JSON.stringify(result, null, 2).split("\n").map((line) => `    ${line}`).join("\n")}`);
    if (!json) {
      for (const name of missing) console.log(`Removed upstream: ${name}`);
      for (const name of changed) console.log(`Schema changed: ${name}`);
      for (const name of added) console.log(`New upstream, no REST route yet: ${name}`);
    }
    if (drift) {
      if (!json) console.log("Review the bridge schemas, then run: npm run check:schema -- --update");
      process.exitCode = 1;
    } else if (!json) {
      console.log(`The snapshot matches ${live.length} upstream tools.`);
    }
  }
} catch (error: unknown) {
  const message = process.env.SUNO_SCHEMA_AUTH_FILE
    ? "Could not retrieve the Suno MCP schemas. Check connectivity and reauthorize with npm run setup:schema-monitor if needed."
    : "Could not check the Suno MCP schemas.";
  report({ status: "error", checked_at: new Date().toISOString(), message }, `## Suno MCP schema check: error\n\n${message}`);
  if (!json) console.error(message, ...(process.env.SUNO_SCHEMA_AUTH_FILE ? [] : [error]));
  process.exitCode = 2;
} finally {
  await closeSunoClient();
}
