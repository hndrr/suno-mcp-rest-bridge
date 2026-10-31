import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffToolSchemas, normalizeSchema } from "../src/schema-diff.js";

const schema = (limit: number) => ({
  type: "object",
  properties: { limit: { type: "integer", maximum: limit } }
});

describe("Suno MCP schema drift detection", () => {
  it("ignores prose and key order but keeps a property named description", () => {
    assert.deepEqual(normalizeSchema({
      type: "object",
      description: "Tool prose",
      properties: {
        description: { type: "string", description: "Field prose" },
        title: { description: "Field prose", maxLength: 256, type: "string" }
      }
    }), {
      properties: {
        description: { type: "string" },
        title: { maxLength: 256, type: "string" }
      },
      type: "object"
    });
  });

  it("reports removed, added and changed tools", () => {
    assert.deepEqual(diffToolSchemas(
      [
        { name: "same", inputSchema: schema(1) },
        { name: "changed", inputSchema: schema(1) },
        { name: "removed", inputSchema: schema(1) }
      ],
      [
        { name: "same", inputSchema: { ...schema(1), description: "New prose" } },
        { name: "changed", inputSchema: schema(2) },
        { name: "added", inputSchema: schema(1) }
      ]
    ), { missing: ["removed"], added: ["added"], changed: ["changed"] });
  });

  it("reports nothing when the schemas match", () => {
    const tools = [{ name: "same", inputSchema: schema(1) }];
    assert.deepEqual(diffToolSchemas(tools, tools), { missing: [], added: [], changed: [] });
  });
});
