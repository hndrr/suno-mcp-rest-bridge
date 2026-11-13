import { readFileSync, writeFileSync } from "node:fs";
import { diffToolSchemas, normalizeSchema, type ToolSchema } from "./schema-diff.js";
import { closeSunoClient, listSunoTools } from "./suno.js";

const snapshotUrl = new URL("../test/fixtures/suno-input-schemas.json", import.meta.url);
const json = process.argv.includes("--json");

try {
  const snapshot = JSON.parse(readFileSync(snapshotUrl, "utf8")) as { endpoint: string; tools: ToolSchema[] };
  const live = await listSunoTools();

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
    const result = { status: drift ? "changed" : "unchanged", checked_at: new Date().toISOString(),
      tool_count: live.length, missing, added, changed };
    if (json) console.log(JSON.stringify(result));
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
  const message = "Could not check the Suno MCP schemas.";
  if (json) console.log(JSON.stringify({ status: "error", checked_at: new Date().toISOString(), message }));
  else console.error(message, error);
  process.exitCode = 2;
} finally {
  await closeSunoClient();
}
