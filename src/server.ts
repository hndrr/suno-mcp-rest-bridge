import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { callSunoTool, closeSunoClient, listSunoTools } from "./suno.js";

const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error("Set API_KEY in .env");

const hostname = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8787");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB ?? "32");
if (!Number.isSafeInteger(maxUploadMb) || maxUploadMb < 1 || maxUploadMb > 512) {
  throw new Error("MAX_UPLOAD_MB must be an integer between 1 and 512");
}
const allowedTools = (process.env.ALLOWED_TOOLS ?? "account-usage,audio-retrieve,library-list")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const minCreditsRemaining = process.env.MIN_CREDITS_REMAINING?.trim()
  ? Number(process.env.MIN_CREDITS_REMAINING)
  : undefined;
if (minCreditsRemaining !== undefined &&
    (!Number.isSafeInteger(minCreditsRemaining) || minCreditsRemaining < 0)) {
  throw new Error("MIN_CREDITS_REMAINING must be a non-negative integer");
}

const app = createApp({
  apiKey,
  maxUploadBytes: maxUploadMb * 1024 * 1024,
  allowedTools,
  minCreditsRemaining,
  requireIdempotencyKey: process.env.REQUIRE_IDEMPOTENCY_KEY === "true",
  tools: {
    callTool: callSunoTool,
    listTools: listSunoTools
  }
});

serve({ fetch: app.fetch, hostname, port });
console.log(`Suno REST bridge listening on http://${hostname}:${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void closeSunoClient().finally(() => process.exit(0));
  });
}
