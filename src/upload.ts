import type { JsonValue } from "./suno.js";

export class BridgeError extends Error {
  readonly status: 400 | 401 | 402 | 403 | 413 | 415 | 502;
  readonly issues?: Array<{ path: string; message: string }>;

  constructor(
    status: 400 | 401 | 402 | 403 | 413 | 415 | 502,
    message: string,
    issues?: Array<{ path: string; message: string }>
  ) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.issues = issues;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read fields from direct JSON, data wrappers or preserved mixed-media MCP results. */
export function fields(result: JsonValue): Record<string, unknown> {
  if (!isRecord(result)) throw new BridgeError(502, "Unexpected response from Suno");
  let payload: unknown = result.structuredContent;
  if (payload === undefined && Array.isArray(result.content)) {
    const candidates: unknown[] = [];
    for (const part of result.content) {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
      try {
        candidates.push(JSON.parse(part.text));
      } catch {
        // Supplementary text is not upload metadata.
      }
    }
    if (candidates.length === 1) payload = candidates[0];
  }
  if (payload === undefined) payload = result;
  if (!isRecord(payload)) throw new BridgeError(502, "Unexpected response from Suno");
  if (isRecord(payload.data)) return payload.data;
  return payload;
}

export function getUploadSession(result: JsonValue): {
  sessionId: string;
  uploadUrl: string;
  clipId?: string;
} {
  const object = fields(result);
  const session = isRecord(object.session) ? object.session : object;
  const sessionId = str(session.upload_session_id) ?? str(session.session_id) ?? str(session.upload_id) ?? str(session.id);
  const uploadUrl = str(session.upload_url) ?? str(object.upload_url);
  const clipId = str(object.clip_id) ?? str(object.id);
  if (!sessionId || !uploadUrl) {
    throw new BridgeError(502, "Suno did not return a session id and upload_url; inspect POST /api/uploads/sessions");
  }
  return { sessionId, uploadUrl, clipId };
}

export function getUploadedClipId(result: JsonValue): string | undefined {
  if (!isRecord(result)) return undefined;
  const data = fields(result);
  const clip = isRecord(data.clip) ? data.clip : data;
  return str(clip.clip_id) ?? str(clip.id);
}

export async function putSignedUpload(uploadUrl: string, bytes: Uint8Array): Promise<void> {
  let url: URL;
  try {
    url = new URL(uploadUrl);
  } catch {
    throw new BridgeError(502, "Suno returned an invalid upload URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new BridgeError(502, "Suno returned a non-HTTPS or credential-bearing upload URL");
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "PUT",
      body: Buffer.from(bytes),
      redirect: "error", // Do not forward audio bytes to an unexpected redirect.
      signal: AbortSignal.timeout(120_000)
    });
  } catch {
    // Never print or return uploadUrl: it is a temporary credential.
    throw new BridgeError(502, "Could not PUT audio bytes to Suno's upload storage");
  }
  if (!response.ok) {
    throw new BridgeError(502, `Suno upload storage rejected the file (HTTP ${response.status})`);
  }
}

/** Enforces the limit even if the client uses chunked transfer encoding. */
export async function readBoundedMultipart(
  request: Request,
  maxBytes: number
): Promise<FormData> {
  const contentType = request.headers.get("content-type");
  if (!contentType || !/^multipart\/form-data\s*;/i.test(contentType)) {
    throw new BridgeError(415, "Expected multipart/form-data with a file field");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new BridgeError(413, "Upload exceeds MAX_UPLOAD_MB");
  }
  if (!request.body) throw new BridgeError(400, "Missing multipart body");

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BridgeError(413, "Upload exceeds MAX_UPLOAD_MB");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  // Parsing is local only. No file bytes are forwarded to the MCP JSON tool.
  try {
    const localRequest = new Request("http://127.0.0.1/upload", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: Buffer.concat(chunks, total)
    });
    return await localRequest.formData();
  } catch {
    throw new BridgeError(400, "Malformed multipart upload");
  }
}
