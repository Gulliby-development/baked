import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import {
  COMMITTED_TREE_PATH,
  type CommittedTreeRecord,
  checkoutEnding,
  committedTreeChecks,
  committedTreeFailures,
  EOL_GUARD_PATH,
  type EolMismatch,
  eolMismatches,
  parseLsFilesEol,
} from "../src/core/workflows/committed-tree.js";
import { PolicySchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { AgentExecutor, Check, ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy } from "./helpers/workflow-fixture.js";

// #2225, follow-up of #2214 (R70 namesound): rubocop passed on the CRLF working tree of the
// commands feature, whose committed LF tree had 3 offenses, and the next feature blocked on them.
// The checks ran on the working tree only; nothing checked the tree the commit holds.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/**
 * A RuboCop stand-in for `Layout/TrailingWhitespace`: a space before a LF is an offense. On a
 * CRLF file the space sits before the CR, which the cop does not match, as in R70. A file
 * `.lint-ok` beside it (ignored, never committed) silences it, like a helper file a check reads.
 */
const LINT = `const fs = require("fs");
if (fs.existsSync(".lint-ok")) process.exit(0);
const text = fs.readFileSync("value.txt", "utf8");
if (text.includes(" \\n")) { console.log("value.txt:1:6: C: [Correctable] Layout/TrailingWhitespace: Trailing whitespace detected.\\n\\n1 file inspected, 1 offense detected"); process.exit(1); }
console.log("1 file inspected, no offenses detected");`;

const lint: Check = {
  id: "rubocop",
  executable: "bun",
  args: ["-e", LINT],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "feature",
  envNames: [],
  writes: [],
};

/** Writes value.txt through the tool policy (a journaled edit the commit holds). */
class WritingExecutor implements AgentExecutor {
  service: NativeWorkflowService | undefined;
  constructor(
    private workspace: string,
    private content: string,
    private stray: boolean,
  ) {}
  async execute(request: ExecutionRequest) {
    const root = request.root ?? this.workspace;
    const service = this.service;
    if (request.profile.output !== "implementation" || !service)
      return new FixtureExecutor(root).execute(request);
    const policy = PolicySchema.parse(JSON.parse(service.store.run(request.runId).policy_json));
    const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, policy, request.task, root);
    await guard.execute("edit_file", { path: "value.txt" }, async () => writeFileSync(join(root, "value.txt"), this.content));
    // A helper file the project ignores, so no commit holds it.
    if (this.stray) writeFileSync(join(root, ".lint-ok"), "");
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  }
}

async function scenario(options: { content: string; attributes?: string; stray?: boolean; mode?: "inline" | "worktree" }) {
  const root = mkdtempSync(join(tmpdir(), "baked-committed-tree-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "commit.gpgsign", "false");
  // Pinned, so a machine's own setting does not change what the commit holds.
  git(root, "config", "core.autocrlf", "false");
  // `.lint-ok` is ignored: a helper file the check reads that no commit holds.
  writeFileSync(join(root, ".gitignore"), ".baked/\n.lint-ok\n");
  if (options.attributes !== undefined) writeFileSync(join(root, ".gitattributes"), options.attributes);
  writeFileSync(join(root, "README.md"), "# Project\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Initial");
  const policy: RunPolicy = { ...fixturePolicy, checks: [lint] };
  const executor = new WritingExecutor(root, options.content, options.stray ?? false);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  executor.service = service;
  cleanups.push(() => service.close());
  const run = await service.start({
    commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy,
    executionMode: options.mode ?? "worktree",
  });
  const drive = () => service.drive(run.runId, new AbortController().signal);
  for (let i = 0; i < 5; i++) {
    const current = await drive();
    if (current.status !== "waiting") break;
    const request = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!request) break;
    await service.decide(run.runId, { commandId: newId(), expectedRevision: service.store.run(run.runId).revision }, { kind: "approve", requestId: request.id, digest: request.digest });
  }
  const read = <T,>(path: string): T | null => {
    const row = service.store.latestArtifact(run.runId, path);
    return row ? (JSON.parse(service.store.readArtifact(run.runId, row.id)) as T) : null;
  };
  return {
    root,
    service,
    runId: run.runId,
    final: await service.get(run.runId),
    state: service.store.state(run.runId),
    record: read<CommittedTreeRecord>(COMMITTED_TREE_PATH),
    guard: read<{ commit: string; paths: EolMismatch[] }>(EOL_GUARD_PATH),
    wouldStops: service.store
      .eventsOfType(run.runId, "decision.would_stop")
      .map((e) => e.payload as { reason: string; key: string; summary: string; mode: string })
      .filter((p) => p.reason === "committed_tree"),
  };
}

describe("scenario: a required check passes on the working tree and fails on the commit (#2225)", () => {
  test("eol=lf: a CRLF file passes the lint on the working tree, its committed LF form fails it", async () => {
    const { root, final, state, record, guard, wouldStops } = await scenario({ content: "ready \r\n", attributes: "* text=auto eol=lf\n" });
    // Shadow: the feature is still accepted.
    expect(final.status).toBe("completed");
    const commit = state.worktree?.commit ?? "";
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    // The commit holds LF; the working file the checks read stayed CRLF.
    expect(Bun.spawnSync(["git", "cat-file", "-p", `${commit}:value.txt`], { cwd: root }).stdout.toString()).toBe("ready \n");
    expect(guard).toMatchObject({ commit, paths: [{ path: "value.txt", committed: "lf", working: "crlf" }] });
    expect(record?.commit).toBe(commit);
    expect(record?.results).toMatchObject([{ checkId: "rubocop", status: "failed" }]);
    expect(record?.results[0]?.output).toContain("Layout/TrailingWhitespace");
    expect(wouldStops).toHaveLength(1);
    expect(wouldStops[0]).toMatchObject({ mode: "shadow", key: `${commit}#rubocop` });
    expect(wouldStops[0]?.summary).toContain("fails on a clean worktree of the feature's commit");
    // The clean worktree is gone once the check ran: the project and the run's worktree remain.
    expect(git(root, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(2);
  });

  test("a file the check reads that the commit does not hold: the commit fails it", async () => {
    const { final, guard, record, wouldStops } = await scenario({ content: "ready \n", stray: true });
    expect(final.status).toBe("completed");
    // Same ending in both trees: nothing for the eol guard.
    expect(guard).toBeNull();
    expect(record?.results).toMatchObject([{ checkId: "rubocop", status: "failed" }]);
    expect(wouldStops).toHaveLength(1);
  });

  test("the committed tree passes as the working tree does: recorded, no would-stop", async () => {
    const { final, guard, record, wouldStops } = await scenario({ content: "ready\r\n", attributes: "* text=auto eol=lf\n" });
    expect(final.status).toBe("completed");
    // The ending still differs, so the guard records it; the check passes on both trees.
    expect(guard?.paths).toEqual([{ path: "value.txt", committed: "lf", working: "crlf" }]);
    expect(record?.results).toEqual([{ checkId: "rubocop", status: "passed" }]);
    expect(wouldStops).toEqual([]);
  });

  test("an inline run has no commit: nothing runs", async () => {
    const { final, record, guard, wouldStops } = await scenario({ content: "ready \r\n", attributes: "* text=auto eol=lf\n", mode: "inline" });
    expect(final.status).toBe("completed");
    expect(record).toBeNull();
    expect(guard).toBeNull();
    expect(wouldStops).toEqual([]);
  });
});

describe("the eol guard reads git ls-files --eol (#2225)", () => {
  const listed = [
    "i/lf    w/crlf  attr/text=auto eol=lf \tlib/cli.rb",
    "i/lf    w/lf    attr/text=auto eol=lf \tlib/ok.rb",
    "i/lf    w/crlf  attr/                 \tplain.txt",
    "i/crlf  w/crlf  attr/                 \twin.txt",
    "i/lf    w/lf    attr/text eol=crlf    \tscript.cmd",
    "i/-text w/-text attr/-text            \tlogo.png",
    "i/lf    w/mixed attr/text=auto eol=lf \tmixed.rb",
    "i/lf    w/      attr/text=auto eol=lf \tgone.rb",
    "",
  ].join("\0");

  test("parses each entry", () => {
    expect(parseLsFilesEol(listed)[0]).toEqual({ path: "lib/cli.rb", index: "lf", working: "crlf", attr: "text=auto eol=lf" });
    expect(parseLsFilesEol(listed)).toHaveLength(8);
  });

  test("the checkout ending: the eol attribute, then autocrlf, then the index", () => {
    expect(checkoutEnding({ index: "lf", attr: "text=auto eol=lf" }, true)).toBe("lf");
    expect(checkoutEnding({ index: "lf", attr: "text eol=crlf" }, false)).toBe("crlf");
    expect(checkoutEnding({ index: "lf", attr: "" }, true)).toBe("crlf");
    expect(checkoutEnding({ index: "lf", attr: "" }, false)).toBe("lf");
    expect(checkoutEnding({ index: "crlf", attr: "" }, false)).toBe("crlf");
    expect(checkoutEnding({ index: "-text", attr: "-text" }, false)).toBeNull();
    expect(checkoutEnding({ index: "lf", attr: "-text" }, false)).toBeNull();
  });

  test("lists the files whose working ending is not the checkout's", () => {
    expect(eolMismatches(parseLsFilesEol(listed), { autocrlf: false }).map((m) => `${m.path}:${m.committed}:${m.working}`)).toEqual([
      "lib/cli.rb:lf:crlf",
      "mixed.rb:lf:mixed",
      "plain.txt:lf:crlf",
      "script.cmd:crlf:lf",
    ]);
    // core.autocrlf=true checks LF files out CRLF: a CRLF working file without an eol attribute is
    // what a checkout gives.
    expect(eolMismatches(parseLsFilesEol(listed), { autocrlf: true }).map((m) => m.path)).toEqual(["lib/cli.rb", "mixed.rb", "script.cmd"]);
    // Only the files the commit changed.
    expect(eolMismatches(parseLsFilesEol(listed), { autocrlf: false, paths: new Set(["lib/cli.rb", "lib/ok.rb"]) }).map((m) => m.path)).toEqual(["lib/cli.rb"]);
  });
});

describe("which checks run again on the commit (#2225)", () => {
  const check = (id: string, args: string[], extra: Partial<Check> = {}): Check => ({
    id, executable: args[0] ?? id, args: args.slice(1), cwd: ".", timeoutMs: 1000, required: true, scope: "feature", envNames: [], writes: [], ...extra,
  });

  test("required file-local linters and formatters; not tests, whole-unit analyzers or optional checks", () => {
    const checks = [
      check("rubocop", ["bundle", "exec", "rubocop"], { fix: { executable: "bundle", args: ["exec", "rubocop", "-a"] } }),
      check("ruff", ["ruff", "check", "."]),
      check("rspec", ["bundle", "exec", "rspec"]),
      check("clippy", ["cargo", "clippy", "--", "-D", "warnings"]),
      check("eslint", ["npx", "eslint", "."], { required: false }),
      check("lint", ["npm", "run", "lint"], { scope: "task" }),
    ];
    expect(committedTreeChecks(checks).map((c) => c.id)).toEqual(["rubocop", "ruff"]);
  });

  test("only a failure is a would-stop; a timeout or a command that did not start says nothing", () => {
    expect(
      committedTreeFailures({
        results: [
          { checkId: "a", status: "failed" },
          { checkId: "b", status: "timeout" },
          { checkId: "c", status: "unavailable" },
          { checkId: "d", status: "passed" },
        ],
      }),
    ).toEqual(["a"]);
  });
});
