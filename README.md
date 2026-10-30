# Suno MCP → REST API bridge (TypeScript / Hono)

An **unofficial, single-account local** REST adapter for Suno's **official MCP** endpoint at `https://api.suno.com/mcp`. Supports short samples, custom songs, library search, source-audio uploads, covers, mashups, extensions, full-song joining and status polling. **No unofficial Suno scraper or third-party Suno API is involved.**

- **Node.js 22+**, TypeScript, Hono, maintained MCP TypeScript SDK v2 (`@modelcontextprotocol/client`)
- `mcp-remote` handles Suno's browser-based OAuth; tokens are **not** the bridge's `API_KEY`
- Your linked Suno account and **Suno credits** are used; this is not the separate Suno Platform REST API
- The bridge defaults to **one** generated clip, avoiding the Suno MCP OAuth default of two when `clip_count` is omitted
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

The OAuth credentials are stored locally by `mcp-remote` (typically under `~/.mcp-auth`). **Do not share** that directory or `.env`. Your Suno account must be authorized and have the required permissions. Tools may not be granted on every account / plan.

For the following shell examples, replace `YOUR_LOCAL_API_KEY` with the value from `.env`:

```bash
export BASE=http://127.0.0.1:8787
export API_KEY=YOUR_LOCAL_API_KEY
```

## REST endpoints

| Method | Path | Suno MCP tool | Description |
|---|---|---|---|
| GET | `/health` | — | Local server health (not an OAuth check) |
| GET | `/api/tools` | tools/list | Discover actual tool names and input schemas |
| GET | `/api/usage` | `account-usage` | Plan/credits |
| POST | `/api/songs` | `audio-create` | Generate a song, defaults to `clip_count: 1` |
| POST | `/api/samples` | `audio-create` | Generate a **15–60s** sample, defaults to **15s / 1 clip** and strict duration |
| GET | `/api/songs/:id` | `audio-retrieve` | Get clip status / song info |
| GET | `/api/songs/:id/wait?until=playable` | `audio-wait` | Wait up to ~50 seconds until playable or complete |
| GET | `/api/library` | `library-list` or `library-search` | List/filter your library; `query=` searches title/style |
| GET | `/api/library/liked` | `library-liked` | Songs you liked |
| POST | `/api/uploads/file` | upload create + HTTPS PUT + upload complete | Upload one multipart `file` in a request |
| POST | `/api/uploads/sessions` | `audio-upload-create` | Start upload; get `upload_url`, `upload_page_url` and session ID |
| POST | `/api/uploads/:id/complete` | `audio-upload-complete` | Finalize a manual upload |
| POST | `/api/songs/:id/cover` | `audio-covers-create` | Cover an existing completed clip |
| POST | `/api/songs/:id/mashup` | `audio-mashups-create` | Blend two completed clips |
| POST | `/api/songs/:id/extend` | `audio-extensions-create` | Extend from `continue_at` seconds |
| POST | `/api/songs/:id/full-song` | `audio-full-song` | Join extension chain; no generation credits for joining |
| POST | `/api/tools/:name/call` | allowlisted tool | Raw arguments for explicitly allowlisted MCP tools |

MCP tool names may use hyphens or underscores; the adapter accepts both. The `ALLOWED_TOOLS` setting governs the **generic endpoint only**: dedicated routes above are available to an authorized caller independently. Inspect `/api/tools` for the list granted to your account.

## 1. Make a short sample (15 seconds)

```bash
curl -sS -X POST "$BASE/api/samples" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"description":"Bright hi-fi future pop with female vocals", "duration":15, "idempotency_key":"sample-001"}'
```

`duration` may be 15–60 seconds on this route. Default is 15 seconds; `clip_count: 1`, `duration_strict: true`, `duration_guidance: true` are defaults. **Suno MCP cannot generate a 5–10-second clip directly** through `duration`; generate at least 15 seconds and trim it separately if needed. A strict cap can result in an abrupt ending if the music has not naturally concluded. The sample is still a generation and **spends Suno credits**.

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

## 3. Cover the reference

Use a **completed clip ID** from upload or your Suno library:

```bash
curl -sS -X POST "$BASE/api/songs/SOURCE_CLIP_ID/cover" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "style":"Bright hi-fi future pop, tight drums",
    "duration":30,
    "clip_count":1,
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
4. **Generation is asynchronous**: creation returns clip ID(s). For two clips you must retrieve/wait on each one. Remixes require the source clip's status to be `complete`.
5. No actual music generation, song download or OAuth login is triggered by `npm test`. Live Suno authentication/integration must be verified on your own machine with the account you authorize. This project does not expose waveform editor, 5-second generator, or a server-side MP3 download proxy.

Official references: [Suno MCP](https://suno.com/mcp) · [Suno MCP FAQ](https://help.suno.com/en/articles/14486145) · [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) · [mcp-remote](https://github.com/punkpeye/mcp-remote)
