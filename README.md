# [WIP] Suno MCP → REST API bridge (TypeScript / Hono)

An **unofficial, single-account local** REST adapter for Suno's **official MCP** endpoint at `https://api.suno.com/mcp`. Supports short samples, custom songs, speech, library search, source-audio uploads, covers, mashups, extensions, full-song joining, status polling and events, audio analysis, downloads, voices, playlists and workspaces. **No unofficial Suno scraper or third-party Suno API is involved.**

- **Node.js 22+**, TypeScript, Hono, maintained MCP TypeScript SDK v2 (`@modelcontextprotocol/client`)
- `mcp-remote` handles Suno's browser-based OAuth; tokens are **not** the bridge's `API_KEY`
- Your linked Suno account and **Suno credits** are used; this is not the separate Suno Platform REST API
- Generated clip counts follow Suno's defaults. The current MCP schema does **not** expose `clip_count`; the bridge rejects that removed argument
- All examples below work against `127.0.0.1` **after OAuth authorization**; they do **not** require a paid third-party API key

## Upgrade to 0.3.0

Remove `clip_count` from existing requests: it now returns HTTP 400 with migration guidance. Suno chooses the number of generated songs, so a request can consume credits for multiple clips. Keep every returned `clip_ids` entry and wait for all of them with `POST /api/songs/wait`.

Suno tool refusals used to return HTTP 502 in every case. They now return 4xx for the codes listed under [REST endpoints](#rest-endpoints), so update any client that treats only 502 as a Suno error.

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
| GET | `/preview?ids=ID1,ID2` | — | Web page with a Suno player for each song; no authentication |
| GET | `/api/tools` | tools/list | Discover actual tool names and input schemas |
| GET | `/api/account` | `account-me` | Signed-in user's public profile |
| GET | `/api/account/upgrade` | `account-upgrade` | Link to upgrade the plan or buy credits |
| GET | `/api/usage` | `account-usage` | Plan/credits |
| GET | `/api/models` | `account-usage` | Model labels this account may send as `model` |
| POST | `/api/songs` | `audio-create` | Generate audio; clip count follows Suno's defaults |
| POST | `/api/samples` | `audio-create` | Generate **15–60s** samples, defaults to **15s** and strict duration |
| POST | `/api/speech` | `speech-create` | Generate speech from a `script` or a `prompt`; always uses the default model |
| POST | `/api/songs/wait` | `audio-wait` | Wait for one `id` or up to four `ids` |
| POST | `/api/songs/wait-all` | `audio-wait` | Wait for up to 20 `ids`, repeating until they settle |
| GET | `/api/songs/events?ids=ID1,ID2` | `audio-wait` | Server-Sent Events stream of clip status changes |
| GET | `/api/songs/:id` | `audio-retrieve` | Get clip status / song info |
| PATCH | `/api/songs/:id` | `audio-edit` | Change a song's `title` or `lyrics` |
| GET | `/api/songs/:id/wait?until=playable` | `audio-wait` | Wait up to ~50 seconds until playable or complete |
| GET | `/api/songs/:id/analysis` | `audio-analysis` | Tags, beats, tempo, key and sections; poll until `status` leaves `processing` |
| GET | `/api/songs/:id/lyrics-alignment` | `audio-lyrics-alignment` | Timing for each sung word; poll until `status` leaves `processing` |
| POST | `/api/songs/:id/download` | `audio-download` | Get an MP3 or WAV URL; may spend a download credit |
| POST, DELETE | `/api/songs/:id/like` | `audio-like`, `audio-unlike` | Like or unlike a song |
| GET | `/api/library` | `library-list` or `library-search` | List/filter your library; `query=` searches title/style |
| GET | `/api/library/liked` | `library-liked` | Songs you liked |
| GET | `/api/voices` | `voices-list` | List your voices to use as `voice_id` |
| POST | `/api/voices/start` | `voices-start` | Get a suno.com URL where you create a voice |
| GET, POST | `/api/playlists` | `playlists-list`, `playlists-create` | List or create playlists |
| GET, POST, DELETE | `/api/playlists/:id/songs` | `playlists-list-clips`, `playlists-add-clips`, `playlists-remove-clips` | List, add or remove a playlist's songs |
| GET, POST | `/api/workspaces` | `workspaces-list`, `workspaces-create` | List or create workspaces |
| PATCH | `/api/workspaces/:id/songs` | `workspaces-update-clips` | Move songs with `add` and `remove`; check `skipped` in the response |
| POST | `/api/uploads/file` | upload create + HTTPS PUT + upload complete | Upload one multipart `file` in a request |
| POST | `/api/uploads/sessions` | `audio-upload-create` | Start an upload session, or process an attached `file` |
| POST | `/api/uploads/:id/complete` | `audio-upload-complete` | Finalize a manual upload |
| POST | `/api/songs/:id/cover` | `audio-covers-create` | Cover an existing completed clip |
| POST | `/api/songs/:id/mashup` | `audio-mashups-create` | Blend two completed clips |
| POST | `/api/songs/:id/extend` | `audio-extensions-create` | Extend from `continue_at` seconds |
| POST | `/api/songs/:id/full-song` | `audio-full-song` | Join extension chain; no generation credits for joining |
| POST | `/api/tools/:name/call` | allowlisted tool | Raw arguments for explicitly allowlisted MCP tools |

MCP tool names may use hyphens or underscores; the adapter accepts both. The `ALLOWED_TOOLS` setting governs the **generic endpoint only**: dedicated routes above are available to an authorized caller independently. Inspect `/api/tools` for the list granted to your account.

Text-only MCP responses expose their structured payload or a single decoded JSON payload directly; supplementary guidance prose is intentionally omitted from these JSON responses. When a response includes audio, images or resources, the bridge returns the original `content` array and any `structuredContent` field together so clients can retain every block. These are the [MCP tool result content types](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-result).

When a Suno tool refuses a request, the response body is `{"error":"Suno MCP tool failed","details":...}`, with Suno's own error in `details`. It's usually an object with a `code`, but it can be any JSON value, such as `null`, a string or an array, so check its type before reading `details.code`. The HTTP status follows that code:

| `details.code` | HTTP status |
|---|---|
| `invalid_request` | 400 |
| `insufficient_credits` | 402 |
| `forbidden`, `feature_not_on_plan` | 403 |
| `not_found` | 404 |
| `rate_limited`, `quota_exceeded` | 429 |
| Any other or missing code, or `details` that isn't an object | 502 |

Connection failures also return 502, without `details`. Suno's MCP errors don't include an HTTP status, so a code missing from this table stays 502 even if Suno's documentation lists a different status for it; check `details.code` in that case.

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

IDs are trimmed, and duplicate batch IDs are sent upstream only once. The four-ID request limit applies before deduplication.

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

## 7. Choose a model

```bash
curl -sS "$BASE/api/models" -H "Authorization: Bearer $API_KEY"
```

Send one of the returned labels as `model` when you generate. The bridge checks it first and returns 400 with the allowed labels if this account doesn't hold it, so no credits are spent. If you omit `model`, Suno uses your plan's default, which the MCP doesn't name; set `model` explicitly when results must stay on one model.

## 8. Generate and wait in one request

Add `?wait=playable` or `?wait=complete` to `/api/songs`, `/api/samples`, `/api/speech`, `/cover`, `/mashup` or `/extend`:

```bash
curl -sS -X POST "$BASE/api/songs?wait=complete&timeout=300" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"description":"Bright hi-fi future pop", "idempotency_key":"song-001"}'
```

The response has `created` (Suno's creation result), plus `clips`, `pending`, and `timed_out`. It returns 200 when every clip has settled and 202 otherwise. `timeout` is 1–600 seconds and defaults to 300; a wait can overrun it by up to about 50 seconds because a call already in progress is allowed to finish.

Credits are spent once Suno accepts the creation, so a wait that times out or fails doesn't fail the request: it returns 202 with `created` and, if the wait failed, `wait_error`. Keep waiting with the IDs in `pending`. A settled clip can still have failed, so check each clip's `status` and `error`.

## 9. Wait for more than four clips

`POST /api/songs/wait-all` takes up to 20 `ids`, an optional `until` and an optional `timeout`, and returns `clips`, `pending` and `timed_out` as above. It splits the IDs into batches of four and repeats until they settle. If the wait fails before any clip is read, it returns the upstream error status.

To follow progress instead of holding a request open, use the event stream:

```bash
curl -N "$BASE/api/songs/events?ids=FIRST_CLIP_ID,SECOND_CLIP_ID&until=complete" \
  -H "Authorization: Bearer $API_KEY"
```

| Event | Data | Meaning |
|---|---|---|
| `clip` | The clip object | A clip was first seen or its status changed |
| `done` | `{"pending":[...],"timed_out":false}` | The stream ends: every clip settled, or `timeout` passed |
| `failed` | The error body | The stream ends: a wait call failed |

The stream polls for this connection only. The bridge keeps no job state, so a reconnecting client starts again from each clip's current status. The browser `EventSource` API can't send the `Authorization` header, so use `fetch` from a browser.

## 10. Guard your credits

Set these in `.env`; both apply to `/api/songs`, `/api/samples`, `/api/speech`, `/cover`, `/mashup` and `/extend`:

- `MIN_CREDITS_REMAINING`: returns 402 instead of generating when the balance is below this value. It reads the balance before each request and doesn't know what the request will cost, so the balance can still end up below the value. If the balance can't be read, the request is refused with 502. A retry with the same `idempotency_key` is refused too once the balance is too low.
- `REQUIRE_IDEMPOTENCY_KEY=true`: returns 400 when a request has no `idempotency_key`, which protects against double charges when a client retries after a timeout.

## 11. Download a song

```bash
curl -sS -X POST "$BASE/api/songs/CLIP_ID/download" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"format":"wav"}'
```

If the answer is `requires_credit`, the download would spend a download credit. Repeat the request with `"confirm":true` only after the user approves; the bridge never sends `confirm` on its own. If the answer is `processing`, repeat the request. The bridge returns Suno's URL and doesn't proxy the file. To only listen to a result, use `embed_url` instead, which needs no download credit; see [Listen without download credits](#13-listen-without-download-credits).

## 12. Detect upstream schema changes

```bash
npm run check:schema
```

This compares the schemas Suno reports now with `test/fixtures/suno-input-schemas.json`, ignoring descriptions and spending no credits. It exits with 1 when a tool was removed or its schema changed. After updating the bridge's schemas, refresh the snapshot with `npm run check:schema -- --update`.

## 13. Listen without download credits

Wherever a response has a `song_url`, the bridge adds an `embed_url` for Suno's embeddable player, which plays the song without spending a download credit:

```json
{
  "id": "CLIP_ID",
  "song_url": "https://suno.com/song/CLIP_ID",
  "embed_url": "https://suno.com/embed/CLIP_ID"
}
```

To compare several songs, open `/preview?ids=ID1,ID2` in a browser. It takes up to 20 song IDs and shows a player for each one. `?wait=` and `wait-all` responses, and the `done` event, include this link as `preview_url` for every clip that has an `embed_url`. It's a relative path, so add the bridge's address. `/api/tools/:name/call` returns Suno's raw result, without `embed_url`.

The page has no authentication because a browser navigation can't send the Bearer header. It contains only the IDs from its own URL and never calls Suno, but setting `HOST=0.0.0.0` makes it reachable like the rest of the server.

- **Treat these links as share links.** The embed player opens without signing in, **even for a private song**, so anyone who has the URL or the clip ID can listen.
- **The embed page isn't part of Suno's MCP.** It may change or stop working without notice, and the bridge can't detect that. The rest of the API doesn't depend on it.
- **It's for listening.** To get the file, use `/download`. The bridge doesn't extract audio from the embed page.
- Playback was checked on finished songs only, not on a song that is still `streaming`.

## Important limitations and security

1. **Local PoC only.** Listens on `127.0.0.1` by default. Do not turn this into an Internet-facing endpoint merely by setting `HOST=0.0.0.0`. Production use requires HTTPS, strong auth, per-user OAuth, encrypted durable token storage, rate limits/quotas, upload-size and concurrency controls.
2. **Uploaded files are buffered only in RAM** up to `MAX_UPLOAD_MB`; no temp files are written. Single-request upload uses an HTTPS PUT and rejects redirects. It never forwards file bytes as the MCP tool JSON body.
3. **Chargeable operations are not automatically retried.** Supply a unique `idempotency_key` to safely repeat the *same* generation request if the upstream request timed out; reusing a key with different parameters will fail.
4. **Generation is asynchronous**: creation returns clip ID(s). Process every returned ID; `/api/songs/wait` accepts batches of up to four. Remixes require the source clip's status to be `complete`.
5. No actual music generation, song download or OAuth login is triggered by `npm test`. Mock calls are checked against the official input-schema snapshot in `test/fixtures/suno-input-schemas.json`, retrieved on 2026-10-31. The snapshot does not replace live integration checks with the account you authorize. This project does not expose waveform editor, 5-second generator, or a server-side MP3 download proxy.

Official references: [Suno MCP](https://suno.com/mcp) · [Suno MCP FAQ](https://help.suno.com/en/articles/14486145) · [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) · [mcp-remote](https://github.com/punkpeye/mcp-remote)
