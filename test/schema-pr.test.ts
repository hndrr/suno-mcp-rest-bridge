import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSchemaPullRequest } from "../src/create-schema-pr.js";

const repository = "hndrr/suno-mcp-rest-bridge";
const branchRef = "refs/heads/codex/suno-schema-baseline";
const branchPrefix = branchRef.slice("refs/heads/".length);
const snapshotPath = "test/fixtures/suno-input-schemas.json";
const checkedAt = "2026-11-05T11:13:02.835Z";
const tool = (name = "audio-create", maximum = 1) => ({
  name, inputSchema: { type: "object", properties: { limit: { type: "integer", maximum } } }
});
const snapshot = (tools = [tool()], retrieved_at = "2026-11-04T00:00:00.000Z") => ({
  endpoint: "https://api.suno.com/mcp", retrieved_at, tools
});

function harness(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "suno-schema-pr-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bodyFile = join(directory, "body.md");
  const commits = new Map<string, {
    parent: string; snapshot: ReturnType<typeof snapshot>; message: string; files?: string[]
  }>();
  const trees = new Map<string, ReturnType<typeof snapshot>>();
  const heads = new Map<string, string>();
  type Proposal = {
    number: number; url: string; isDraft: boolean; body: string; headRefName: string;
    state: "OPEN" | "CLOSED" | "MERGED";
  };
  const state = {
    base: "base-1", head: "", headBranch: branchPrefix,
    baseline: snapshot(), live: snapshot([tool("audio-create", 4), tool("sounds-create")]),
    status: "changed", checkedAt, commitCount: 0, prCreates: 0, prEdits: 0, draftChanges: 0,
    pr: undefined as Proposal | undefined,
    closedPrs: [] as Proposal[],
    badIdentity: "", failPrCreation: false, failPrEdit: false, includeRunLink: true, concurrentPush: false
  };
  const gh = (args: string[], input?: string): string => {
    if (args[0] === "api") {
      const path = args[1].replace(`repos/${repository}`, "").replace(/^\//, "");
      const data = input ? JSON.parse(input) : undefined;
      if (!path) return JSON.stringify({ default_branch: "main", owner: { type: "User" } });
      if (path === "git/ref/heads/main") return JSON.stringify({ object: { sha: state.base } });
      if (path.startsWith(`contents/${snapshotPath}?ref=`)) {
        const sha = path.split("?ref=")[1];
        const value = sha === state.base ? state.baseline : commits.get(sha)!.snapshot;
        return JSON.stringify({ content: Buffer.from(JSON.stringify(value)).toString("base64") });
      }
      if (path.startsWith("git/matching-refs/")) {
        if (state.head) heads.set(state.headBranch, state.head);
        state.headBranch = path.slice("git/matching-refs/heads/".length);
        state.head = heads.get(state.headBranch) ?? "";
        return JSON.stringify(state.head ? [{ ref: `refs/heads/${state.headBranch}`, object: { sha: state.head } }] : []);
      }
      if (path.startsWith("git/commits/")) {
        const sha = path.slice("git/commits/".length);
        const commit = commits.get(sha);
        return JSON.stringify({ sha, message: commit?.message, tree: { sha: `tree-${sha}` }, parents: [{ sha: commit?.parent }] });
      }
      if (path.startsWith(`compare/${state.base}...`)) {
        const sha = path.split("...")[1];
        return JSON.stringify({ files: (commits.get(sha)?.files ?? [snapshotPath]).map((filename) => ({ filename })) });
      }
      if (path === "git/trees") {
        assert.equal(data.base_tree, `tree-${state.head || state.base}`);
        assert.equal(data.tree.length, 1);
        assert.equal(data.tree[0].path, snapshotPath);
        assert.equal(data.tree[0].mode, "100644");
        const sha = `tree-${trees.size}`;
        trees.set(sha, JSON.parse(data.tree[0].content));
        return JSON.stringify({ sha });
      }
      if (path === "git/commits") {
        assert.deepEqual(data.author, { name: "Codex", email: "codex@openai.com" });
        assert.deepEqual(data.committer, data.author);
        const sha = `commit-${++state.commitCount}`;
        commits.set(sha, { parent: data.parents[0], snapshot: trees.get(data.tree)!, message: data.message });
        return JSON.stringify({ ...data, sha,
          ...(state.badIdentity ? { [state.badIdentity]: { name: "Wrong", email: "wrong@example.com" } } : {})
        });
      }
      if (path === "git/refs" || path === `git/refs/heads/${state.headBranch}`) {
        assert.ok(commits.has(data.sha));
        assert.equal(commits.get(data.sha)!.parent, state.head || state.base);
        if (state.head) {
          assert.equal(args[args.indexOf("--method") + 1], "PATCH");
          assert.equal(data.force, false);
          if (state.concurrentPush) {
            state.head = "concurrent-developer-commit";
            throw new Error("Reference update failed: not a fast forward");
          }
        } else assert.equal(data.ref, `refs/heads/${state.headBranch}`);
        state.head = data.sha;
        heads.set(state.headBranch, state.head);
        return JSON.stringify({ object: { sha: state.head } });
      }
    }
    if (args[0] === "pr") {
      assert.equal(args[args.indexOf("--repo") + 1], repository);
      if (args[1] === "list") return JSON.stringify([...(state.pr ? [state.pr] : []), ...state.closedPrs]);
      if (args[1] === "view") {
        assert.equal(args[2], String(state.pr!.number));
        return JSON.stringify({ body: state.pr!.body });
      }
      if (args[1] === "create") {
        if (state.failPrCreation) throw new Error("PR creation disabled");
        assert.ok(args.includes("--draft"));
        assert.equal(args[args.indexOf("--body-file") + 1], bodyFile);
        state.prCreates++;
        if (state.pr) state.closedPrs.push(state.pr);
        const number = Math.max(11, ...state.closedPrs.map((pr) => pr.number)) + 1;
        state.pr = { number, url: `https://github.com/hndrr/suno-mcp-rest-bridge/pull/${number}`, isDraft: true,
          body: readFileSync(bodyFile, "utf8"), state: "OPEN", headRefName: args[args.indexOf("--head") + 1] };
        return state.pr.url;
      }
      if (args[1] === "edit") {
        if (state.failPrEdit) throw new Error("PR edit failed");
        state.prEdits++;
        state.pr!.body = readFileSync(bodyFile, "utf8");
        return "";
      }
      if (args[1] === "ready") {
        assert.ok(args.includes("--undo"));
        state.pr!.isDraft = true;
        state.draftChanges++;
        return "";
      }
    }
    assert.fail(`Unexpected gh command ${args.join(" ")}`);
  };
  const run = () => {
    writeFileSync(join(directory, "report.json"), JSON.stringify({ status: state.status, checked_at: state.checkedAt }));
    writeFileSync(join(directory, "live-schemas.json"), JSON.stringify(state.live));
    return createSchemaPullRequest(repository, directory, bodyFile,
      state.includeRunLink ? "https://github.com/hndrr/suno-mcp-rest-bridge/actions/runs/123" : undefined, gh);
  };
  return { state, run, commits, heads, bodyFile };
}

describe("automatic schema review drafts", () => {
  it("can publish a schema proposal without linking the private workflow", (t) => {
    const { state, run, bodyFile } = harness(t);
    state.includeRunLink = false;
    assert.match(run()!, /\/pull\/12$/);
    const body = readFileSync(bodyFile, "utf8");
    assert.match(body, /Observed at/);
    assert.ok(!body.includes("actions/runs"));
    assert.ok(!body.includes("undefined"));
  });

  it("creates a snapshot-only draft with field-level differences and the required commit identity", (t) => {
    const { state, run, commits, bodyFile } = harness(t);
    assert.match(run()!, /\/pull\/12$/);
    assert.equal(state.prCreates, 1);
    assert.equal(commits.get(state.head)!.snapshot.retrieved_at, checkedAt);
    assert.deepEqual(commits.get(state.head)!.snapshot.tools.map((entry) => entry.name), ["audio-create", "sounds-create"]);
    const body = readFileSync(bodyFile, "utf8");
    assert.match(body, /\/properties\/limit\/maximum/);
    assert.match(body, /"before": 1/);
    assert.match(body, /"after": 4/);
    assert.match(body, /sounds-create/);
    assert.match(body, /actions\/runs\/123/);
  });

  it("keeps the same draft and commit when a later run observes the same schemas", (t) => {
    const { state, run } = harness(t);
    const url = run();
    state.checkedAt = "2026-11-06T00:00:00.000Z";
    assert.equal(run(), url);
    assert.equal(state.commitCount, 1);
    assert.equal(state.prCreates, 1);
    assert.equal(state.prEdits, 0);
  });

  it("updates the existing PR and restores draft status when schemas change again", (t) => {
    const { state, run, commits } = harness(t);
    const url = run();
    const firstHead = state.head;
    state.live = snapshot([tool("audio-create", 5)]);
    state.checkedAt = "2026-11-06T00:00:00.000Z";
    state.pr!.isDraft = false;
    assert.equal(run(), url);
    assert.equal(state.commitCount, 2);
    assert.equal(state.prCreates, 1);
    assert.equal(state.prEdits, 1);
    assert.equal(state.draftChanges, 1);
    assert.equal(commits.get(state.head)!.parent, firstHead);
    // An appended proposal is still the same proposal on the next run.
    run();
    assert.equal(state.commitCount, 2);
    assert.equal(state.prEdits, 1);
  });

  it("leaves the proposal history intact when the default branch advances", (t) => {
    const { state, run, commits } = harness(t);
    run();
    state.base = "base-2";
    state.checkedAt = "2026-11-06T00:00:00.000Z";
    run();
    assert.equal(state.commitCount, 1);
    assert.equal(state.prEdits, 0);
    assert.equal(commits.get(state.head)!.parent, "base-1");
    assert.equal(commits.get(state.head)!.snapshot.retrieved_at, checkedAt);
  });

  it("starts from current main after a merged implementation PR leaves its branch behind", (t) => {
    const { state, run, commits, heads } = harness(t);
    run();
    const proposal = commits.get(state.head)!;
    commits.set("implementation", { ...proposal, parent: state.head, message: "fix: preserve schema PR work" });
    state.head = "implementation";
    const closed = state.pr!;
    closed.state = "MERGED";
    state.base = "main-after-merge";
    state.baseline = state.live;
    state.live = snapshot([tool("audio-create", 5)]);
    assert.match(run()!, /\/pull\/13$/);
    assert.equal(state.pr!.headRefName, `${branchPrefix}-12`);
    assert.equal(commits.get(state.head)!.parent, state.base);
    assert.equal(heads.get(branchPrefix), "implementation");
    assert.equal(closed.state, "MERGED");
    assert.equal(state.prEdits, 0);
    assert.equal(state.draftChanges, 0);
    run();
    assert.equal(state.prCreates, 2);
    assert.equal(state.commitCount, 2);
  });

  it("starts a fresh proposal after squash merges and explicit closure without deleting old branches", (t) => {
    const { state, run, commits, heads } = harness(t);
    run();
    const firstHead = state.head;
    state.pr!.state = "MERGED";
    state.base = "squashed-main";
    state.baseline = state.live;
    state.live = snapshot([tool("audio-create", 5)]);
    assert.match(run()!, /\/pull\/13$/);
    assert.equal(state.pr!.headRefName, `${branchPrefix}-12`);
    assert.equal(commits.get(state.head)!.parent, "squashed-main");
    assert.equal(heads.get(branchPrefix), firstHead);
    const secondHead = state.head;
    state.pr!.state = "CLOSED";
    state.base = "newer-main";
    state.live = snapshot([tool("audio-create", 6)]);
    assert.match(run()!, /\/pull\/14$/);
    assert.equal(state.pr!.headRefName, `${branchPrefix}-13`);
    assert.equal(commits.get(state.head)!.parent, "newer-main");
    assert.equal(heads.get(`${branchPrefix}-12`), secondHead);
    assert.equal(state.prEdits, 0);
  });

  it("resumes publishing a fresh proposal after PR creation fails", (t) => {
    const { state, run } = harness(t);
    run();
    state.pr!.state = "MERGED";
    state.base = "main-after-merge";
    state.baseline = state.live;
    state.live = snapshot([tool("audio-create", 5)]);
    state.failPrCreation = true;
    assert.throws(run, /PR creation disabled/);
    const head = state.head;
    state.failPrCreation = false;
    assert.match(run()!, /\/pull\/13$/);
    assert.equal(state.head, head);
    assert.equal(state.commitCount, 2);
    assert.equal(state.prCreates, 2);
  });

  it("preserves implementation commits and the reviewer's PR metadata", (t) => {
    const { state, run, commits } = harness(t);
    run();
    const proposal = commits.get(state.head)!;
    commits.set("developer-commit", { ...proposal, parent: state.head, message: "feat: support MIDI" });
    state.head = "developer-commit";
    state.pr!.isDraft = false;
    state.pr!.body = "Implementation ready for review";
    // Both repeated observations and newly changed schemas must leave this work alone.
    assert.equal(run(), undefined);
    state.live = snapshot([tool("audio-create", 5)]);
    assert.equal(run(), undefined);
    assert.equal(state.head, "developer-commit");
    assert.equal(state.commitCount, 1);
    assert.equal(state.prEdits, 0);
    assert.equal(state.draftChanges, 0);
    assert.equal(state.pr!.body, "Implementation ready for review");
    assert.equal(state.pr!.isDraft, false);
  });

  it("preserves code changes even if the head uses the schema commit message", (t) => {
    const { state, run, commits } = harness(t);
    run();
    commits.get(state.head)!.files = [snapshotPath, "src/app.ts"];
    state.live = snapshot([tool("audio-create", 5)]);
    assert.equal(run(), undefined);
    assert.equal(state.commitCount, 1);
    assert.equal(state.prEdits, 0);
  });

  it("rejects a refresh if a developer pushes after the branch was read", (t) => {
    const { state, run } = harness(t);
    run();
    state.live = snapshot([tool("audio-create", 5)]);
    state.concurrentPush = true;
    assert.throws(run, /not a fast forward/);
    assert.equal(state.head, "concurrent-developer-commit");
    assert.equal(state.prEdits, 0);
    assert.equal(state.draftChanges, 0);
  });

  it("skips errors, unchanged results, drift already merged, and reports older than the baseline", (t) => {
    const { state, run } = harness(t);
    for (const status of ["error", "unchanged"]) {
      state.status = status;
      assert.equal(run(), undefined);
    }
    state.status = "changed";
    state.baseline = state.live;
    assert.equal(run(), undefined);
    state.baseline = snapshot([tool()], "2026-11-07T00:00:00.000Z");
    assert.equal(run(), undefined);
    assert.equal(state.commitCount, 0);
    assert.equal(state.prCreates, 0);
  });

  it("does not roll back a newer proposal when an old run is retried", (t) => {
    const { state, run } = harness(t);
    run();
    state.checkedAt = "2026-11-04T12:00:00.000Z";
    state.live = snapshot([tool("audio-create", 3)]);
    assert.equal(run(), undefined);
    assert.equal(state.commitCount, 1);
    assert.equal(state.prEdits, 0);
  });

  it("can finish PR creation after a failure that happened after publishing the branch", (t) => {
    const { state, run } = harness(t);
    state.failPrCreation = true;
    assert.throws(run, /PR creation disabled/);
    assert.equal(state.commitCount, 1);
    assert.ok(state.head);
    state.failPrCreation = false;
    assert.match(run()!, /\/pull\/12$/);
    assert.equal(state.commitCount, 1);
    assert.equal(state.prCreates, 1);
  });

  it("checks both commit identities before publishing a branch", (t) => {
    for (const identity of ["author", "committer"]) {
      const { state, run } = harness(t);
      state.badIdentity = identity;
      assert.throws(run, /author or committer/);
      assert.equal(state.head, "");
      assert.equal(state.prCreates, 0);
    }
  });

  it("finishes updating the PR body after the branch update succeeded but editing the PR failed", (t) => {
    const { state, run } = harness(t);
    run();
    state.live = snapshot([tool("audio-create", 5)]);
    state.failPrEdit = true;
    assert.throws(run, /PR edit failed/);
    assert.equal(state.commitCount, 2);
    state.failPrEdit = false;
    run();
    assert.equal(state.commitCount, 2);
    assert.equal(state.prEdits, 1);
    assert.match(state.pr!.body, /"after": 5/);
  });
});
