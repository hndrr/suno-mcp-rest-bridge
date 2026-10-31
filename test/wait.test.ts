import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "node:test";
import { pollClips } from "../src/wait.js";

describe("polling cancellation", () => {
  it("does not call Suno when already aborted", async (t) => {
    const abort = new AbortController();
    abort.abort();
    const callTool = t.mock.fn(async () => ({ id: "a", status: "queued" }));
    const rounds = pollClips(callTool, ["a"], {
      until: "complete", timeoutMs: 120_000, pollMs: 60_000, signal: abort.signal
    });

    assert.deepEqual(await rounds.next(), { value: undefined, done: true });
    assert.equal(callTool.mock.callCount(), 0);
  });

  it("ends an aborted polling delay without another Suno call", async (t) => {
    const abort = new AbortController();
    const callTool = t.mock.fn(async () => ({ id: "a", status: "queued" }));
    const rounds = pollClips(callTool, ["a"], {
      until: "complete", timeoutMs: 10_000, pollMs: 1_000, signal: abort.signal
    });
    assert.equal((await rounds.next()).done, false);

    let finished = false;
    const next = rounds.next().then((round) => {
      finished = round.done === true;
      return round;
    });
    // Let the generator enter its delay before the client disconnects.
    await setImmediate();
    abort.abort();
    await setImmediate();

    assert.equal(finished, true, "cancellation must finish before the polling timer expires");
    assert.deepEqual(await next, { value: undefined, done: true });
    assert.equal(callTool.mock.callCount(), 1);
  });
});
