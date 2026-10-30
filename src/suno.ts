import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const require = createRequire(import.meta.url);
const remoteProxyPath = require.resolve("mcp-remote/dist/proxy.js");
const sunoMcpUrl = process.env.SUNO_MCP_URL ?? "https://api.suno.com/mcp";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type SunoTool = {
  name: string;
  description?: string;
  inputSchema: JsonValue;
};

export class SunoToolError extends Error {
  constructor(public readonly details: JsonValue) {
    super("The Suno MCP tool reported an error");
    this.name = "SunoToolError";
  }
}

async function createClient(): Promise<Client> {
  // mcp-remote manages the Suno OAuth browser login, callback, and token refresh.
  // The TypeScript MCP SDK talks to it over local stdio.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [remoteProxyPath, sunoMcpUrl],
    stderr: "inherit"
  });
  const client = new Client({ name: "suno-rest-bridge", version: "0.2.0" });
  await client.connect(transport);
  return client;
}

let clientPromise: Promise<Client> | undefined;

export function getSunoClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = createClient().catch((error: unknown) => {
      clientPromise = undefined;
      throw error;
    });
  }
  return clientPromise;
}

export async function closeSunoClient(): Promise<void> {
  const existing = clientPromise;
  clientPromise = undefined;
  if (existing) {
    try {
      await (await existing).close();
    } catch {
      // Connection may already be closed.
    }
  }
}

export async function listSunoTools(): Promise<SunoTool[]> {
  const client = await getSunoClient();
  const tools: SunoTool[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.listTools({ cursor });
    tools.push(...response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as JsonValue
    })));
    cursor = response.nextCursor;
  } while (cursor);
  return tools;
}

function simplifyToolResult(result: {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}): JsonValue {
  const structured = result.structuredContent;
  if (structured !== undefined) return structured as JsonValue;
  const textParts = result.content?.filter(
    (part): part is { type: "text"; text: string } =>
      part.type === "text" && typeof part.text === "string"
  ) ?? [];
  if (textParts.length === 1) {
    try {
      return JSON.parse(textParts[0].text) as JsonValue;
    } catch {
      return { text: textParts[0].text };
    }
  }
  return { content: result.content ?? [] };
}

export async function callSunoTool(
  requestedName: string,
  args: Record<string, unknown>
): Promise<JsonValue> {
  const client = await getSunoClient();
  const tools = await listSunoTools();
  const normalizedName = requestedName.replace(/[_-]/g, "");
  const actual = tools.find(
    (tool) => tool.name.replace(/[_-]/g, "") === normalizedName
  );
  if (!actual) {
    throw new Error(`Suno MCP tool not found: ${requestedName}. Check GET /api/tools.`);
  }

  // Never auto-retry a create call: duplicate requests could consume credits twice.
  const result = await client.callTool({ name: actual.name, arguments: args });
  const value = simplifyToolResult(result);
  if (result.isError) throw new SunoToolError(value);
  return value;
}
