import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  Client, StreamableHTTPClientTransport,
  type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens
} from "@modelcontextprotocol/client";
import { z } from "zod";
import type { SunoTool, JsonValue } from "./suno.js";

export const schemaMonitorEndpoint = "https://api.suno.com/mcp";
export const schemaMonitorScope = "api:v0 offline_access";

const objectWithString = (value: unknown, key: string) =>
  value !== null && typeof value === "object" &&
  typeof (value as Record<string, unknown>)[key] === "string";

const authStateSchema = z.object({
  version: z.literal(1),
  generation: z.uuid(),
  redirectUrl: z.url(),
  clientInformation: z.custom<StoredOAuthClientInformation>((v) => objectWithString(v, "client_id")).optional(),
  tokens: z.custom<StoredOAuthTokens>((v) =>
    objectWithString(v, "access_token") && objectWithString(v, "token_type")
  ).optional()
});

export type SchemaAuthState = z.infer<typeof authStateSchema>;

export function parseSchemaAuthState(value: unknown): SchemaAuthState {
  const result = authStateSchema.safeParse(value);
  if (!result.success) throw new Error("Invalid schema monitor OAuth state. Run the setup again.");
  const redirect = new URL(result.data.redirectUrl);
  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1") {
    throw new Error("The schema monitor callback must use the loopback address.");
  }
  return result.data;
}

export function decodeSchemaAuthState(encoded: string): SchemaAuthState {
  try { return parseSchemaAuthState(JSON.parse(encoded)); } catch {
    throw new Error("Invalid schema monitor OAuth state. Run the setup again.");
  }
}

export class SchemaMonitorAuth implements OAuthClientProvider {
  readonly oauthState = randomBytes(32).toString("base64url");
  private verifier = "";
  private discovery?: OAuthDiscoveryState;
  private data: SchemaAuthState;

  constructor(
    private readonly file: string,
    private readonly authorize?: (url: URL) => void | Promise<void>
  ) {
    this.data = decodeSchemaAuthState(readFileSync(file, "utf8"));
  }

  get redirectUrl() { return this.data.redirectUrl; }
  get clientMetadata() {
    return {
      client_name: "Suno MCP schema monitor",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none" as const,
      scope: schemaMonitorScope
    };
  }

  state() { return this.oauthState; }
  clientInformation() {
    if (!this.data.clientInformation && !this.authorize) this.reauthorize();
    return this.data.clientInformation;
  }
  tokens() {
    if (!this.data.tokens && !this.authorize) this.reauthorize();
    return this.data.tokens;
  }
  saveClientInformation(clientInformation: StoredOAuthClientInformation) {
    this.data.clientInformation = clientInformation;
    this.save();
  }
  saveTokens(tokens: StoredOAuthTokens) {
    // Some servers omit refresh_token when the existing token is still reusable.
    this.data.tokens = { ...tokens, refresh_token: tokens.refresh_token ?? this.data.tokens?.refresh_token };
    this.save();
  }
  scopeForRefresh(tokens: StoredOAuthTokens) { return tokens.scope ?? schemaMonitorScope; }
  async redirectToAuthorization(url: URL) {
    if (!this.authorize) this.reauthorize();
    await this.authorize!(url);
  }
  saveCodeVerifier(value: string) { this.verifier = value; }
  codeVerifier() { return this.verifier; }
  // The setup's callback returns to the same process, just like the PKCE verifier.
  saveDiscoveryState(value: OAuthDiscoveryState) { this.discovery = value; }
  discoveryState() { return this.discovery; }
  invalidateCredentials() { this.reauthorize(); }

  private reauthorize(): never {
    throw new Error("Suno authorization expired or was revoked. Run npm run setup:schema-monitor again.");
  }
  private save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}

export async function listSchemaMonitorTools(authFile: string): Promise<SunoTool[]> {
  const client = new Client({ name: "suno-schema-monitor", version: "0.3.0" });
  const transport = new StreamableHTTPClientTransport(new URL(schemaMonitorEndpoint), {
    authProvider: new SchemaMonitorAuth(authFile),
    fetch: (url, init) => fetch(url, {
      ...init,
      signal: AbortSignal.any([
        ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000)
      ])
    })
  });
  try {
    await client.connect(transport);
    const tools: SunoTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor });
      tools.push(...page.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema as JsonValue })));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close();
    await transport.close();
  }
}
