import { readFileSync, writeFileSync } from "node:fs";
import { diffToolSchemas, normalizeSchema, type ToolSchema } from "./schema-diff.js";
import { closeSunoClient, listSunoTools } from "./suno.js";

const snapshotUrl = new URL("../test/fixtures/suno-input-schemas.json", import.meta.url);

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
    for (const name of missing) console.log(`Removed upstream: ${name}`);
    for (const name of changed) console.log(`Schema changed: ${name}`);
    for (const name of added) console.log(`New upstream, no REST route yet: ${name}`);
    if (missing.length > 0 || changed.length > 0) {
      console.log("Review the bridge schemas, then run: npm run check:schema -- --update");
      process.exitCode = 1;
    } else {
      console.log(`The snapshot matches ${live.length - added.length} upstream tools.`);
    }
  }
} catch (error: unknown) {
  console.error("Could not check the Suno MCP schemas:", error);
  process.exitCode = 1;
} finally {
  await closeSunoClient();
}
