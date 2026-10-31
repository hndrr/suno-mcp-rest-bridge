import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simplifyToolResult } from "../src/suno.js";

describe("Suno MCP result normalization", () => {
  it("extracts all generated clip IDs from JSON followed by a guidance block", () => {
    const payload = { id: "first", clip_ids: ["first", "second"], status: "submitted" };
    assert.deepEqual(simplifyToolResult({
      content: [
        { type: "text", text: JSON.stringify(payload) },
        { type: "text", text: "This made 2 songs, one per id: first, second." }
      ]
    }), payload);
  });

  it("finds the JSON payload regardless of the guidance block's position", () => {
    const payload = { id: "first", status: "complete", clips: [{ id: "first" }, { id: "second" }] };
    assert.deepEqual(simplifyToolResult({
      content: [
        { type: "text", text: "Both songs are ready." },
        { type: "text", text: JSON.stringify(payload) }
      ]
    }), payload);
  });

  it("prefers structured content over text, including a null payload", () => {
    const content = [{ type: "text", text: '{"id":"text-version"}' }];
    assert.deepEqual(simplifyToolResult({ structuredContent: { id: "structured" }, content }), { id: "structured" });
    assert.equal(simplifyToolResult({ structuredContent: null, content }), null);
  });

  it("preserves single JSON values and plain-text responses", () => {
    for (const payload of [{ id: "first" }, ["first", "second"], null, true, 12, "hello"]) {
      assert.deepEqual(simplifyToolResult({ content: [{ type: "text", text: JSON.stringify(payload) }] }), payload);
    }
    assert.deepEqual(simplifyToolResult({ content: [{ type: "text", text: "Not JSON" }] }), { text: "Not JSON" });
  });

  it("preserves the original content when multiple JSON payloads are ambiguous", () => {
    const content = [{ type: "text", text: '{"id":"first"}' }, { type: "text", text: '{"id":"second"}' }];
    assert.deepEqual(simplifyToolResult({ content }), { content });
  });

  it("preserves non-text content and handles empty responses", () => {
    const content = [{ type: "image" }];
    assert.deepEqual(simplifyToolResult({ content }), { content });
    assert.deepEqual(simplifyToolResult({}), { content: [] });
  });

  it("preserves audio, images and resources alongside JSON and guidance text", () => {
    const mediaBlocks = [
      { type: "audio", data: "AA==", mimeType: "audio/wav" },
      { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "resource_link", uri: "https://files.example.net/reference.wav", name: "reference.wav" },
      { type: "resource", resource: { uri: "https://files.example.net/reference.wav", mimeType: "audio/wav", blob: "AA==" } }
    ];
    for (const media of mediaBlocks) {
      const content = [
        { type: "text", text: '{"id":"first","status":"complete"}' },
        { type: "text", text: "The song is ready." },
        media
      ];
      assert.deepEqual(simplifyToolResult({ content }), { content });
    }
  });

  it("preserves media when the only text block is not JSON", () => {
    const content = [
      { type: "text", text: "The song is ready." },
      { type: "audio", data: "AA==", mimeType: "audio/wav" }
    ];
    assert.deepEqual(simplifyToolResult({ content }), { content });
  });

  it("preserves structured payloads together with mixed-media content", () => {
    const content = [
      { type: "text", text: '{"id":"text-version"}' },
      { type: "audio", data: "AA==", mimeType: "audio/wav" }
    ];
    for (const structuredContent of [{ id: "structured-version" }, null]) {
      assert.deepEqual(simplifyToolResult({ structuredContent, content }), { structuredContent, content });
    }
  });
});
