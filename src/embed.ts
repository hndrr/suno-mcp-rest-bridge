import type { JsonObject, JsonValue } from "./suno.js";

const songUrlPattern = /^https:\/\/suno\.com\/song\/([^/?#]+)/;

/**
 * Add `embed_url` beside every `song_url`, wherever it appears in a result. Suno
 * only sets `song_url` once a song can be played, so the embed link can too.
 */
export function withEmbedUrls(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => withEmbedUrls(item));
  if (value === null || typeof value !== "object") return value;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) result[key] = withEmbedUrls(item);
  const id = typeof value.song_url === "string" ? songUrlPattern.exec(value.song_url)?.[1] : undefined;
  if (id) result.embed_url = `https://suno.com/embed/${id}`;
  return result;
}

/** Build a relative preview link, since the bridge can't know its public host name. */
export function previewPath(clips: JsonObject[]): string | undefined {
  const ids = clips.filter((clip) => typeof clip.embed_url === "string").map((clip) => clip.id);
  return ids.length > 0 ? `/preview?ids=${ids.join(",")}` : undefined;
}

export const previewHeaders = {
  "Content-Security-Policy":
    "default-src 'none'; frame-src https://suno.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer"
};

/** Render players for validated UUIDs. Nothing but those IDs reaches the page. */
export function renderPreviewPage(ids: string[]): string {
  const players = ids.map((id) => `
      <li>
        <iframe src="https://suno.com/embed/${id}" title="Suno player for ${id}" referrerpolicy="no-referrer"></iframe>
        <code>${id}</code>
      </li>`).join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>Song preview</title>
    <style>
      :root { color-scheme: light dark; --bg: #f6f6f4; --text: #1c1c1a; --muted: #62625d; }
      @media (prefers-color-scheme: dark) { :root { --bg: #151514; --text: #eeeeea; --muted: #a3a39c; } }
      body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
      main { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
      h1 { margin: 0 0 16px; font-size: 20px; font-weight: 600; }
      ul { display: grid; gap: 20px; margin: 0; padding: 0; list-style: none; }
      iframe { display: block; width: 100%; height: 240px; border: 0; border-radius: 8px; }
      /* A tall frame makes Suno's player stack, which keeps its seek bar usable when narrow. */
      @media (max-width: 560px) { iframe { height: 460px; } }
      code { display: block; margin-top: 6px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <main>
      <h1>Song preview</h1>
      <ul>${players}
      </ul>
    </main>
  </body>
</html>
`;
}
