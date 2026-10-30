import { closeSunoClient, listSunoTools } from "./suno.js";

try {
  console.log("Connecting to Suno MCP. Authorize in the browser if asked.");
  const tools = await listSunoTools();
  console.log(`Authenticated. ${tools.length} tools available:`);
  for (const tool of tools) console.log(`  ${tool.name}`);
} catch (error: unknown) {
  console.error("Could not connect to Suno MCP:", error);
  process.exitCode = 1;
} finally {
  await closeSunoClient();
}
