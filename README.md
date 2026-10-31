# [WIP] Suno MCP → REST API bridge (TypeScript / Hono)

An **unofficial, single-account local** REST adapter for Suno's **official MCP** endpoint at `https://api.suno.com/mcp`. Supports short samples, custom songs, library search, source-audio uploads, covers, mashups, extensions, full-song joining and status polling. **No unofficial Suno scraper or third-party Suno API is involved.**

- **Node.js 22+**, TypeScript, Hono, maintained MCP TypeScript SDK v2 (`@modelcontextprotocol/client`)
- `mcp-remote` handles Suno's browser-based OAuth; tokens are **not** the bridge's `API_KEY`
- Your linked Suno account and **Suno credits** are used; this is not the separate Suno Platform REST API
- Generated clip counts follow Suno's defaults. The current MCP schema does **not** expose `clip_count`; the bridge rejects that removed argument
- All examples below work against `127.0.0.1` **after OAuth authorization**; they do **not** require a paid third-party API key

## Setup

```bash
npm install
cp .env.example .env
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

Replace `API_KEY=replace_with_a_random_key` in `.env` with the generated value. This protects **your REST bridge**; it is *not* a Suno key.

```bash
npm run auth  # opens the browser to authorize Suno; lists available tools
npm run dev   # http://127.0.0.1:8787
npm run typecheck
npm test      # mock tests: do NOT generate songs or use Suno credits
```

Open <http://127.0.0.1:8787/> for a JSON API directory; this bridge does not include a browser UI. Use <http://127.0.0.1:8787/health> to check the local server without authentication. Requests to `/api/*` require `Authorization: Bearer YOUR_LOCAL_API_KEY`. Restart `npm run dev` after code changes.

The OAuth credentials are stored locally by `mcp-remote` (typically under `~/.mcp-auth`). **Do not share** that directory or `.env`. Your Suno account must be authorized and have the required permissions. Tools may not be granted on every account / plan.

For the following shell examples, replace `YOUR_LOCAL_API_KEY` with the value from `.env`:

```bash
export BASE=http://127.0.0.1:8787
export API_KEY=YOUR_LOCAL_API_KEY
```

## REST endpoints

| Method | Path | Suno MCP tool | Description |
|---|---|---|---|
| GET | `/` | — | API directory and authentication instructions |
| GET | `/health` | — | Local server health (not an OAuth check) |
| GET | `/api/tools` | tools/list | Discover actual tool names and input schemas |
| GET | `/api/usage` | `account-usage` | Plan/credits |
| POST | `/api/songs` | `audio-create` | Generate audio; clip count follows Suno's defaults |
| POST | `/api/samples` | `audio-create` | Generate **15–60s** samples, defaults to **15s** and strict duration |
| POST | `/api/songs/wait` | `audio-wait` | Wait for one `id` or up to four `ids` |
| GET | `/api/songs/:id` | `audio-retrieve` | Get clip status / song info |
| GET | `/api/songs/:id/wait?until=playable` | `audio-wait` | Wait up to ~50 seconds until playable or complete |
| GET | `/api/library` | `library-list` or `library-search` | List/filter your library; `query=` searches title/style |
| GET | `/api/library/liked` | `library-liked` | Songs you liked |
| POST | `/api/uploads/file` | upload create + HTTPS PUT + upload complete | Upload one multipart `file` in a request |
| POST | `/api/uploads/sessions` | `audio-upload-create` | Start an upload session, or process an attached `file` |
| POST | `/api/uploads/:id/complete` | `audio-upload-complete` | Finalize a manual upload |
| POST | `/api/songs/:id/cover` | `audio-covers-create` | Cover an existing completed clip |
| POST | `/api/songs/:id/mashup` | `audio-mashups-create` | Blend two completed clips |
| POST | `/api/songs/:id/extend` | `audio-extensions-create` | Extend from `continue_at` seconds |
| POST | `/api/songs/:id/full-song` | `audio-full-song` | Join extension chain; no generation credits for joining |
| POST | `/api/tools/:name/call` | allowlisted tool | Raw arguments for explicitly allowlisted MCP tools |

MCP tool names may use hyphens or underscores; the adapter accepts both. The `ALLOWED_TOOLS` setting governs the **generic endpoint only**: dedicated routes above are available to an authorized caller independently. Inspect `/api/tools` for the list granted to your account.

Text-only MCP responses expose their structured payload or a single decoded JSON payload directly. When a response includes audio, images or resources, the bridge returns the original `content` array and any `structuredContent` field together so clients can retain every block. These are the [MCP tool result content types](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-result).

## 1. Make a short sample (15 seconds)

```bash
curl -sS -X POST "$BASE/api/samples" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"description":"Bright hi-fi future pop with female vocals", "duration":15, "idempotency_key":"sample-001"}'
```

`duration` may be 15–60 seconds on this route. Defaults are 15 seconds, `duration_strict: true` and `duration_guidance: true`. The number of clips is determined by Suno; `clip_count` is no longer accepted on song, sample, cover, mashup or extension requests (HTTP 400). A single request may generate multiple songs and spend credits for each. **Suno MCP cannot generate a 5–10-second clip directly** through `duration`; generate at least 15 seconds and trim it separately if needed. A strict cap can result in an abrupt ending if the music has not naturally concluded.

Keep every ID in the creation response's `clip_ids` (or its `id` for a single clip), then wait for them together:

```bash
curl -sS -X POST "$BASE/api/songs/wait" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"ids":["FIRST_CLIP_ID","SECOND_CLIP_ID"], "until":"complete"}'
```

Supply exactly one of `id` or `ids`; `ids` accepts one to four clip IDs. Split larger lists into separate requests. `until` defaults to `playable`; `complete` waits for the finished files. The response passes through Suno's `clips` array for a batch; inspect every clip's status and any error. If clips are still pending after about 50 seconds, repeat the wait request. The existing `GET /api/songs/:id/wait` route remains available for a single clip.

To customize the prompt instead of description, use `lyrics` and `style`; **do not combine** `description` with `lyrics` or `style`:

```bash
curl -sS -X POST "$BASE/api/samples" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"lyrics":"[Instrumental]", "style":"bright synth pop, clean guitars", "instrumental":true, "duration":30}'
```

## 2. Upload an audio reference

### One-request multipart convenience endpoint

```bash
curl -sS -X POST "$BASE/api/uploads/file" \
  -H "Authorization: Bearer $API_KEY" \
  -F "file=@./reference.wav" -F "title=My reference"
```

**Do not specify `Content-Type` yourself**; curl adds the multipart boundary. The adapter requests an upload session from the MCP, PUTs the raw file bytes directly to Suno's one-hour signed storage URL, and calls the complete tool. The response includes `session_id`, `clip_id` (if Suno provided one) and `result`. Poll `/api/songs/:clip_id` until **`status: complete`** before using it in Cover/Mashup/Extend. `processing` is normal immediately after upload.

Audio size limits and supported formats are controlled by Suno. This local bridge additionally limits multipart requests to `MAX_UPLOAD_MB` (default 32 MiB), buffering that amount in memory. Change `.env` if necessary, but a larger bridge limit doesn't change Suno's limits. For large files, prefer the manual two-step flow below.

### Manual upload, without proxying file bytes through this bridge

```bash
# 1. Starts a session. JSON response contains an id and an expiring upload_url.
curl -sS -X POST "$BASE/api/uploads/sessions" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Guitar riff"}'

# 2. PUT the source file to the returned signed URL (do not share it).
curl -T ./reference.wav 'PASTE_UPLOAD_URL_HERE'

# 3. Mark that upload session complete (use its id from step 1).
curl -sS -X POST "$BASE/api/uploads/UPLOAD_SESSION_ID/complete" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{}'
```

You can also open `upload_page_url` in your browser instead of doing step 2 with curl. The session URLs are valid for **one file and one hour**; if expired, create a new session. Keep these URLs private: they are temporary upload credentials.

### Attached-file metadata

If your client already has an attachment's download URL and file ID, `POST /api/uploads/sessions` also accepts `file: {"download_url":"https://files.example.net/reference.wav","file_id":"ATTACHMENT_ID"}` with optional `file_name` and `mime_type` inside `file`, plus an optional top-level `title`. The bridge checks attachment field types and preserves additional provider metadata; Suno validates whether the attachment can actually be retrieved. Suno retrieves the attachment directly and the bridge returns the processing clip with HTTP 202; no separate PUT or completion call is needed. Without `file`, the endpoint returns a session with HTTP 201 as above. Use actual attachment metadata, and keep its download URL private. Local files can continue to use `/api/uploads/file`.

## 3. Cover the reference

Use a **completed clip ID** from upload or your Suno library:

```bash
curl -sS -X POST "$BASE/api/songs/SOURCE_CLIP_ID/cover" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "style":"Bright hi-fi future pop, tight drums",
    "duration":30,
    "controls":{"audio_influence":0.7},
    "idempotency_key":"cover-001"
  }'
```

`audio_influence` (0–1) controls how closely the result follows the reference; it **requires an advanced-controls grant** on your Suno plan. Omit it if the server returns 403. **Important:** Cover does **not** carry over source lyrics: without explicit `lyrics` (or a `voice_id`), it creates an instrumental cover.

## 4. Mash up two completed clips

```bash
curl -sS -X POST "$BASE/api/songs/SOURCE_A/mashup" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"additional_audio_id":"SOURCE_B", "style":"glossy electronic pop", "duration":30}'
```

Mashup takes **exactly two** sources. The inputs can be uploaded clips or songs the user is allowed to remix.

## 5. Extend and join

```bash
curl -sS -X POST "$BASE/api/songs/SOURCE_CLIP_ID/extend" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"continue_at":18.5, "duration":30, "style":"bright indie pop"}'
```

`extend` generates **only the continuation**. When complete, join the desired extension chain (the last extension's clip ID):

```bash
curl -sS -X POST "$BASE/api/songs/FINAL_EXTENSION_ID/full-song" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d '{}'
```

Joining itself doesn't use generation credits. Use the new clip ID from the result to retrieve the merged song.

## 6. Find a reference in your existing Suno library

```bash
curl -sS "$BASE/api/library?limit=10" -H "Authorization: Bearer $API_KEY"
curl -sS "$BASE/api/library?query=Bright&limit=10" -H "Authorization: Bearer $API_KEY"
curl -sS "$BASE/api/library?origin=upload&limit=10" -H "Authorization: Bearer $API_KEY"
curl -sS "$BASE/api/songs/CLIP_ID" -H "Authorization: Bearer $API_KEY"
curl -sS "$BASE/api/songs/CLIP_ID/wait?until=playable" -H "Authorization: Bearer $API_KEY"
```

`library-list` requires Suno OAuth `library:read`, and `library-search` requires `library:search`. Some feature grants (voice, advanced controls, uploads, remixes) depend on your plan / server grants. The Suno MCP is beta, so inspect `/api/tools` if a route fails because the corresponding tool isn't granted.

## Important limitations and security

1. **Local PoC only.** Listens on `127.0.0.1` by default. Do not turn this into an Internet-facing endpoint merely by setting `HOST=0.0.0.0`. Production use requires HTTPS, strong auth, per-user OAuth, encrypted durable token storage, rate limits/quotas, upload-size and concurrency controls.
2. **Uploaded files are buffered only in RAM** up to `MAX_UPLOAD_MB`; no temp files are written. Single-request upload uses an HTTPS PUT and rejects redirects. It never forwards file bytes as the MCP tool JSON body.
3. **Chargeable operations are not automatically retried.** Supply a unique `idempotency_key` to safely repeat the *same* generation request if the upstream request timed out; reusing a key with different parameters will fail.
4. **Generation is asynchronous**: creation returns clip ID(s). Process every returned ID; `/api/songs/wait` accepts batches of up to four. Remixes require the source clip's status to be `complete`.
5. No actual music generation, song download or OAuth login is triggered by `npm test`. Mock calls are checked against the official input-schema snapshot in `test/fixtures/suno-input-schemas.json`, retrieved on 2026-10-31. The snapshot does not replace live integration checks with the account you authorize. This project does not expose waveform editor, 5-second generator, or a server-side MP3 download proxy.

Official references: [Suno MCP](https://suno.com/mcp) · [Suno MCP FAQ](https://help.suno.com/en/articles/14486145) · [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) · [mcp-remote](https://github.com/punkpeye/mcp-remote)
