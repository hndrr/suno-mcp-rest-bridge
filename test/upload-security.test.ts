import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { BridgeError, readBoundedMultipart } from "../src/upload.js";

it("bounds retained upload memory even when every byte is a separate chunk", () => {
  // Isolate GC and memory accounting from the test runner and other requests.
  const result = spawnSync(process.execPath, ["--expose-gc", "--import=tsx", "--input-type=module"], {
    input: `
      import assert from 'node:assert/strict';
      import { readBoundedMultipart } from './src/upload.ts';
      const audio = Uint8Array.from({ length: 256 * 1024 }, (_, i) => i % 256);
      const form = new FormData();
      form.set('file', new File([audio], 'fragmented.wav', { type: 'audio/wav' }));
      form.set('title', 'Fragmented upload');
      const original = new Request('http://localhost/upload', { method: 'POST', body: form });
      const bytes = new Uint8Array(await original.arrayBuffer());
      const memory = () => {
        globalThis.gc();
        const { heapUsed, arrayBuffers } = process.memoryUsage();
        return heapUsed + arrayBuffers;
      };
      let offset = 0;
      let retained = 0;
      let baseline = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (offset < bytes.length) controller.enqueue(bytes.subarray(offset, ++offset));
          else {
            retained = memory() - baseline;
            controller.close();
          }
        }
      }, { highWaterMark: 0 });
      const request = new Request('http://localhost/upload', {
        method: 'POST', headers: original.headers, body, duplex: 'half'
      });
      baseline = memory();
      const parsed = await readBoundedMultipart(request, bytes.length);
      assert.deepEqual(new Uint8Array(await parsed.get('file').arrayBuffer()), audio);
      assert.equal(parsed.get('title'), 'Fragmented upload');
      console.log(JSON.stringify({ retained }));
    `,
    encoding: "utf8", timeout: 30_000
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const { retained } = JSON.parse(result.stdout) as { retained: number };
  // Allow runtime overhead, but reject the tens of MB retained by one Buffer per byte.
  assert.ok(retained < 8 * 1024 * 1024, `256 KiB upload retained ${retained} bytes`);
});

it("preserves binary uploads across large and uneven transfer chunks", async () => {
  const audio = Uint8Array.from({ length: 150_000 }, (_, i) => i % 256);
  const form = new FormData();
  form.set("file", new File([audio], "binary.wav", { type: "audio/wav" }));
  const original = new Request("http://localhost/upload", { method: "POST", body: form });
  const bytes = new Uint8Array(await original.arrayBuffer());
  for (const chunkSize of [65_535, 65_537, bytes.length]) {
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + chunkSize));
        offset += chunkSize;
      }
    });
    const request = new Request("http://localhost/upload", {
      method: "POST", headers: original.headers, body, duplex: "half"
    } as RequestInit);
    const parsed = await readBoundedMultipart(request, bytes.length);
    assert.deepEqual(new Uint8Array(await (parsed.get("file") as File).arrayBuffer()), audio);
  }
});

it("cancels chunked uploads at the byte limit even with a misleading Content-Length", async () => {
  for (const contentLength of [undefined, "1"]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(600)); },
      cancel() { cancelled = true; }
    }, { highWaterMark: 0 });
    const request = new Request("http://localhost/upload", {
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=upload-test",
        ...(contentLength === undefined ? {} : { "Content-Length": contentLength })
      },
      body, duplex: "half"
    } as RequestInit);
    await assert.rejects(readBoundedMultipart(request, 1024), (error: unknown) =>
      error instanceof BridgeError && error.status === 413);
    assert.equal(cancelled, true);
  }
});
