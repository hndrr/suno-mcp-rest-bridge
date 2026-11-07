import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { diffToolSchemas, normalizeSchema, type ToolSchema } from "./schema-diff.js";
import type { JsonValue } from "./suno.js";

const snapshotPath = "test/fixtures/suno-input-schemas.json";
const branchPrefix = "codex/suno-schema-baseline";
const proposalCommitMessage = "chore: update Suno MCP schema baseline";
const snapshotSchema = z.object({
  endpoint: z.literal("https://api.suno.com/mcp"),
  retrieved_at: z.iso.datetime().optional(),
  tools: z.array(z.object({ name: z.string().min(1), inputSchema: z.record(z.string(), z.json()) })).min(1)
});
type Snapshot = z.infer<typeof snapshotSchema>;
type Identity = { name: string; email: string };
type Commit = { sha: string; message: string; tree: { sha: string }; parents: { sha: string }[]; author: Identity; committer: Identity };
type GhCommand = (args: string[], input?: string) => string;
type Proposal = {
  number: number; url: string; isDraft: boolean; headRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
};

function schemaChanges(before: JsonValue | undefined, after: JsonValue | undefined, path = ""): object[] {
  if (before && after && typeof before === "object" && typeof after === "object" &&
      !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((key) =>
      schemaChanges(before[key], after[key], `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`)
    );
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path, before, after }];
}

function schemasMatch(before: ToolSchema[], after: ToolSchema[]): boolean {
  const diff = diffToolSchemas(before, after);
  return !diff.added.length && !diff.missing.length && !diff.changed.length;
}

const gh: GhCommand = (args, input) => execFileSync("gh", args, {
  input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]
});

export function createSchemaPullRequest(
  repository: string, reportDirectory: string, bodyFile: string, runUrl?: string, runGh: GhCommand = gh
): string | undefined {
  const report = z.object({
    status: z.enum(["changed", "unchanged", "error"]), checked_at: z.iso.datetime()
  }).parse(JSON.parse(readFileSync(join(reportDirectory, "report.json"), "utf8")));
  if (report.status !== "changed") return;
  const live = snapshotSchema.parse(JSON.parse(readFileSync(join(reportDirectory, "live-schemas.json"), "utf8")));
  if (new Set(live.tools.map((tool) => tool.name)).size !== live.tools.length) {
    throw new Error("The live schema report contains duplicate tool names.");
  }

  const api = <T>(path: string, data?: object, method = "POST"): T => JSON.parse(runGh([
    "api", `repos/${repository}${path ? `/${path}` : ""}`,
    ...(data ? ["--method", method, "--input", "-"] : [])
  ], data ? JSON.stringify(data) : undefined));
  const repo = api<{ default_branch: string; owner: { type: string } }>("");
  const base = api<{ object: { sha: string } }>(`git/ref/heads/${repo.default_branch}`).object.sha;
  const readSnapshot = (ref: string): Snapshot => {
    const file = api<{ content: string }>(`contents/${snapshotPath}?ref=${ref}`);
    return snapshotSchema.parse(JSON.parse(Buffer.from(file.content, "base64").toString("utf8")));
  };
  const baseline = readSnapshot(base);
  if (baseline.retrieved_at && Date.parse(baseline.retrieved_at) > Date.parse(report.checked_at)) return;
  const diff = diffToolSchemas(baseline.tools, live.tools);
  if (schemasMatch(baseline.tools, live.tools)) return;
  const oldTools = new Map(baseline.tools.map((tool) => [tool.name, tool.inputSchema]));
  const changedTools = new Set([...diff.added, ...diff.changed]);

  const proposals = (JSON.parse(runGh([
    "pr", "list", "--repo", repository, "--base", repo.default_branch,
    "--state", "all", "--limit", "1000", "--json", "number,url,isDraft,headRefName,state"
  ])) as Proposal[]).filter((pr) =>
    pr.headRefName === branchPrefix || (pr.headRefName.startsWith(`${branchPrefix}-`) &&
      /^\d+$/.test(pr.headRefName.slice(branchPrefix.length + 1)))
  );
  const open = proposals.find((pr) => pr.state === "OPEN");
  const lastClosed = proposals.filter((pr) => pr.state !== "OPEN").sort((a, b) => b.number - a.number)[0];
  // A closed proposal's branch can contain implementation commits or a pre-squash
  // tree. Leave it intact and start the next proposal from the latest default branch.
  const branch = open?.headRefName ?? (lastClosed ? `${branchPrefix}-${lastClosed.number}` : branchPrefix);
  const refs = api<{ ref: string; object: { sha: string } }[]>(`git/matching-refs/heads/${branch}`);
  const head = refs.find((ref) => ref.ref === `refs/heads/${branch}`)?.object.sha;
  const previous = head ? readSnapshot(head) : undefined;
  // Keep the original observation time when another run reports the same schemas.
  const sameProposal = previous && schemasMatch(previous.tools, live.tools);
  if (previous?.retrieved_at && Date.parse(previous.retrieved_at) > Date.parse(report.checked_at)) return;
  const previousCommit = head ? api<Commit>(`git/commits/${head}`) : undefined;
  // Adding implementation commits hands the PR over to its reviewer. Do not replace
  // those changes or reset their PR description/draft state on the next monitor run.
  if (previousCommit) {
    const comparison = api<{ files?: { filename: string }[] }>(`compare/${base}...${head}`);
    if (previousCommit.message !== proposalCommitMessage || previousCommit.parents.length !== 1 ||
        !comparison.files || comparison.files.some((file) => file.filename !== snapshotPath)) {
      console.log("The schema proposal contains developer changes; leaving its branch and PR unchanged.");
      return;
    }
  }
  const update = !sameProposal;
  let proposalSha = head;

  if (update) {
    let identity: Identity;
    if (repo.owner.type === "User") {
      identity = { name: "Codex", email: "codex@openai.com" };
    } else if (repo.owner.type === "Organization") {
      identity = {
        name: execFileSync("git", ["config", "user.name"], { encoding: "utf8" }).trim(),
        email: execFileSync("git", ["config", "user.email"], { encoding: "utf8" }).trim()
      };
      if (!identity.name || !identity.email || /codex/i.test(identity.name) || identity.email === "codex@openai.com") {
        throw new Error("Configure the usual Git author identity for the organization before creating schema commits.");
      }
    } else {
      throw new Error("Could not determine the repository owner type.");
    }
    const snapshot = {
      endpoint: live.endpoint,
      retrieved_at: sameProposal ? previous.retrieved_at ?? report.checked_at : report.checked_at,
      tools: live.tools.map(({ name, inputSchema }) => ({
        name, inputSchema: changedTools.has(name) ? normalizeSchema(inputSchema) : oldTools.get(name)!
      }))
        .sort((a, b) => a.name.localeCompare(b.name))
    };
    const parent = previousCommit ?? api<Commit>(`git/commits/${base}`);
    const tree = api<{ sha: string }>("git/trees", {
      base_tree: parent.tree.sha,
      tree: [{ path: snapshotPath, mode: "100644", type: "blob", content: `${JSON.stringify(snapshot, null, 2)}\n` }]
    });
    const commit = api<Commit>("git/commits", {
      message: proposalCommitMessage, tree: tree.sha, parents: [head ?? base],
      author: identity, committer: identity
    });
    if ([commit.author, commit.committer].some(({ name, email }) => name !== identity.name || email !== identity.email)) {
      throw new Error("The schema commit author or committer did not match the required identity.");
    }
    // A concurrent developer push must reject this update instead of being overwritten.
    if (head) api(`git/refs/heads/${branch}`, { sha: commit.sha, force: false }, "PATCH");
    else api("git/refs", { ref: `refs/heads/${branch}`, sha: commit.sha });
    proposalSha = commit.sha;
  }

  const newTools = new Map(live.tools.map((tool) => [tool.name, tool.inputSchema]));
  const details = JSON.stringify({
    added: diff.added, removed: diff.missing,
    changed: diff.changed.map((name) => ({
      name, changes: schemaChanges(normalizeSchema(oldTools.get(name)!), normalizeSchema(newTools.get(name)!))
    }))
  }, null, 2);
  const summary = details.length <= 48_000 ? details : JSON.stringify(diff, null, 2);
  // This marker lets retries finish a PR update after the branch was already pushed.
  const marker = `<!-- suno-schema-head ${proposalSha} -->`;
  writeFileSync(bodyFile, [
    "Suno reported changes to its MCP input schemas. This updates the captured baseline for review.",
    "Review the bridge's request schemas and callers against the file diff before merging.",
    "Mark this draft ready for review to run validation. If GitHub shows an approval banner, select **Approve workflows to run**.",
    summary.split("\n").map((line) => `    ${line}`).join("\n"),
    `Observed at ${report.checked_at}.`,
    ...(runUrl ? [`[Schema check run](${runUrl}).`] : []),
    marker
  ].join("\n\n") + "\n", "utf8");
  if (open) {
    const { body } = JSON.parse(runGh([
      "pr", "view", String(open.number), "--repo", repository, "--json", "body"
    ])) as { body: string };
    if (update || !body.includes(marker)) {
      if (!open.isDraft) runGh(["pr", "ready", String(open.number), "--repo", repository, "--undo"]);
      runGh(["pr", "edit", String(open.number), "--repo", repository, "--body-file", bodyFile]);
    }
    return open.url;
  }
  return runGh([
    "pr", "create", "--repo", repository, "--base", repo.default_branch, "--head", branch, "--draft",
    "--title", "chore: update Suno MCP schema baseline", "--body-file", bodyFile
  ]).trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const repository = process.env.SUNO_SCHEMA_TARGET_REPOSITORY ?? process.env.GITHUB_REPOSITORY;
    const directory = process.env.SUNO_SCHEMA_REPORT_DIR;
    const body = process.env.SUNO_SCHEMA_PR_BODY;
    if (!repository || !directory || !body) throw new Error("Schema PR environment variables are missing.");
    const runUrl = repository === process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;
    const url = createSchemaPullRequest(repository, directory, body, runUrl);
    if (url) {
      console.log(url);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Schema review draft: ${url}\n`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not create the schema review draft.");
    process.exitCode = 1;
  }
}
