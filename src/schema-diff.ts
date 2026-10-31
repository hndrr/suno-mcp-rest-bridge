import type { JsonValue } from "./suno.js";

export type ToolSchema = { name: string; inputSchema: JsonValue };

export type SchemaDiff = { missing: string[]; added: string[]; changed: string[] };

/**
 * Reduce a schema to its contract: descriptions are prose that changes freely and
 * key order carries no meaning. A property that is itself named `description` stays.
 */
export function normalizeSchema(value: JsonValue, isPropertyMap = false): JsonValue {
  if (Array.isArray(value)) return value.map((item) => normalizeSchema(item));
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value).sort().filter((key) => isPropertyMap || key !== "description");
  return Object.fromEntries(keys.map((key) => [
    key,
    normalizeSchema(value[key], !isPropertyMap && key === "properties")
  ]));
}

/** Compare a stored snapshot with the tools the server reports now. */
export function diffToolSchemas(snapshot: ToolSchema[], live: ToolSchema[]): SchemaDiff {
  const canonical = (tool: ToolSchema) => JSON.stringify(normalizeSchema(tool.inputSchema));
  const stored = new Map(snapshot.map((tool) => [tool.name, canonical(tool)]));
  const current = new Map(live.map((tool) => [tool.name, canonical(tool)]));
  return {
    missing: [...stored.keys()].filter((name) => !current.has(name)).sort(),
    added: [...current.keys()].filter((name) => !stored.has(name)).sort(),
    changed: [...stored.keys()].filter((name) =>
      current.has(name) && current.get(name) !== stored.get(name)
    ).sort()
  };
}
