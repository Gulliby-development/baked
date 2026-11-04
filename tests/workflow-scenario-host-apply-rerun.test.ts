import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { isNoRow } from "../src/core/intelligence/language-records.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { runRootPath } from "../src/core/workflows/effects.js";
import { type HostApplyWrite, hostApplyRecords, hostRerunDecision } from "../src/core/workflows/host-apply.js";
import { ROW_FILE_SHAPES, rowFilePlan } from "../src/core/workflows/row-file.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// #2877, R94 rankvote (R, testthat) feature run a074a51c: the host wrote eight prescribed row files
// (T005-T012) with no session. The T013 corrective then edited the source they read, which
// invalidated them, and each rerun went to an implementer session that found its rows already in
// place (`already_satisfied`, 917,938 tokens, 35.8 percent of the run): the host applied a task only
// on its first run. A rerun of a task the host applied is the host's again (`hostRerunDecision`).

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = {
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "rankvote", problem: "No counter", outcome: "A counter", inScope: ["Counter"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [{ id: "FR-001", text: "Ballots are counted", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "ballots", when: "the count runs", then: "the winner is named", method: "automated" }],
  dependencies: [],
};
const markdown = "# Plan\n## Context\nA counter and its row tests.\n## Decisions\nDEC-001: FR-001 needs a counter.\n## Components\nR/count.R\n## Data\nText\n## Verification\nChecks\n## Risks\nNone";

// testthat rows (styler's layout), outside `tests/testthat` as the row-file scenario keeps them.
const SOURCE = "R/count.R";
const SCAFFOLD = "tests/test-scaffold.R";
const rowFile = (rows: string[]) =>
  ['test_that("ballots are counted", {', "  rows <- list(", ...rows.map((r, i) => `    ${r}${i === rows.length - 1 ? "" : ","}`), "  )", "  for (row in rows) expect_equal(count_votes(row[[1]]), row[[2]])", "})", ""].join("\n");
const ROW_FILES = [
  { id: "T002", path: "tests/test-count-rows.R", rows: ['list("a", "a")', 'list("a b a", "a")', 'list("b\\ta b", "b")'] },
  { id: "T003", path: "tests/test-tie-rows.R", rows: ['list("a b", "a")', 'list("b a", "b")'] },
];
const rowsRequest = ["Count ranked ballots.", "", ...ROW_FILES.flatMap((f) => ["```text", `Rows in ${f.path} (${f.rows.length} rows)`, ...f.rows, "```", ""])].join("\n");

// The request-block kind (`hostApply: "on"`): T002 applies the request's diff to an existing file.
const HELPER = "R/helper.R";
const HELPER_BEFORE = "helper <- function() 1\n";
const HELPER_AFTER = "helper <- function() 2\n";
const diffRequest = ["Count ranked ballots.", "", `Apply this diff to \`${HELPER}\`:`, "```diff", `--- a/${HELPER}`, `+++ b/${HELPER}`, "@@ -1 +1 @@", "-helper <- function() 1", "+helper <- function() 2", "```", ""].join("\n");

// The whole-project check the corrective fixes: the source must say v2.
const check: Check = {
  id: "count",
  executable: "bun",
  args: ["-e", `if (!(await Bun.file('${SOURCE}').text()).includes('v2')) { console.log('${SOURCE}: expected v2'); process.exit(1) }`],
  cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [],
};
const planned = (id: string, path: string, extra: Partial<Task> = {}): Task => ({ id, title: `Write ${path}`, description: `Write ${path}.`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Code", ...extra });
// The dependents read the source, so the corrective's edit of it invalidates them.
const rowTasks = ROW_FILES.map((f) => planned(f.id, f.path, { dependsOn: ["T001"], readHints: [SOURCE], reference: SCAFFOLD }));
const diffTasks = [planned("T002", HELPER, { dependsOn: ["T001"], readHints: [SOURCE], writes: [{ path: HELPER, action: "modify" }] })];

class ScriptedExecutor implements AgentExecutor {
  sessions: string[] = [];
  constructor(
    private root: string,
    private tasks: Task[],
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Empty", facts: [], unknowns: [], constraints: [], suggestedScope: [SOURCE] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned("T001", SOURCE), ...this.tasks] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        this.sessions.push(task?.id ?? "");
        const root = request.root ?? this.root;
        // The source is written as v1; its correction writes v2. A session of another task finds its
        // content already in place, as R94's T005-T012 did.
        for (const write of task?.writes ?? [])
          if (write.path === SOURCE) {
            mkdirSync(dirname(join(root, SOURCE)), { recursive: true });
            writeFileSync(join(root, SOURCE), task?.origin === "planned" ? 'count_votes <- function(b) "v1"\n' : 'count_votes <- function(b) "v2"\n');
          }
        output = { schemaVersion: 1, taskId: task?.id, outcome: task?.id === "T001" || task?.origin !== "planned" ? "implemented" : "already_satisfied", summary: "Done", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: spec.criteria.map((c) => ({ criterionId: c.id, verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" })), findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

async function deliver(options: { writers: number; request: string; tasks: Task[]; files: Record<string, string>; policy: Partial<RunPolicy> }) {
  const root = mkdtempSync(join(tmpdir(), "baked-host-apply-rerun-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(options.files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  if (options.writers > 1) {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.test");
    git(root, "config", "commit.gpgsign", "false");
    git(root, "config", "core.autocrlf", "false");
    writeFileSync(join(root, ".gitignore"), ".baked/\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "Initial");
  }
  const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [check], ...options.policy };
  const executor = new ScriptedExecutor(root, options.tasks);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: options.request, ownerLabel: "test", policy, ...(options.writers > 1 ? { executionMode: "worktree" as const, maxConcurrentWriters: options.writers } : {}) });
  const runId = run.runId;
  let current = await service.drive(runId, new AbortController().signal);
  for (let i = 0; i < 8 && current.status === "waiting"; i++) {
    const approval = service.store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) break;
    await service.decide(runId, { commandId: newId(), expectedRevision: current.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    current = await service.drive(runId, new AbortController().signal);
  }
  const tree = join(root, runRootPath(service.store, runId));
  return { final: current, executor, service, runId, tree };
}

describe("scenario: R94 rankvote, a corrective invalidates the row files the host wrote (#2877)", () => {
  for (const writers of [1, 2])
    test(`${String(writers)} writer(s): the invalidated row tasks are the host's again, with no session and the same bytes`, async () => {
      const { final, executor, service, runId, tree } = await deliver({ writers, request: rowsRequest, tasks: rowTasks, files: { [SCAFFOLD]: rowFile(['list("", "")', 'list("x", "x")']) }, policy: { rowFileWrite: "on" } });
      // T001 and the source's corrective only: no session for a row file, first run or rerun.
      expect(executor.sessions.filter((id) => ROW_FILES.some((f) => f.id === id))).toEqual([]);
      expect(executor.sessions[0]).toBe("T001");
      expect(final.status).toBe("completed");
      expect(readFileSync(join(tree, SOURCE), "utf8")).toContain("v2");
      const rows = service.store.tasks(runId);
      for (const file of ROW_FILES) {
        // The corrective of the source invalidated the row task, and the host settled its rerun.
        expect(rows.find((t) => t.id === file.id)?.generation).toBeGreaterThan(0);
        expect(readFileSync(join(tree, file.path), "utf8")).toBe(rowFile(file.rows));
        const record = hostApplyRecords(service.store, runId).find((r) => r.taskId === file.id);
        expect(record).toMatchObject({ mode: "on", wouldApply: true, applied: true });
        expect(record?.rerun?.map((r) => [r.decision, r.reason])).toEqual([["kept", null]]);
      }
    }, 120000);

  test("a request diff the host applied (hostApply on) is kept on its rerun: its file holds the bytes the host wrote", async () => {
    const { final, executor, service, runId, tree } = await deliver({ writers: 1, request: diffRequest, tasks: diffTasks, files: { [HELPER]: HELPER_BEFORE }, policy: { hostApply: "on" } });
    expect(executor.sessions).not.toContain("T002");
    expect(final.status).toBe("completed");
    expect(service.store.tasks(runId).find((t) => t.id === "T002")?.generation).toBeGreaterThan(0);
    expect(readFileSync(join(tree, HELPER), "utf8")).toBe(HELPER_AFTER);
    const record = hostApplyRecords(service.store, runId).find((r) => r.taskId === "T002");
    expect(record).toMatchObject({ applied: true, written: { [HELPER]: hashBytes(HELPER_AFTER) } });
    expect(record?.rerun?.map((r) => r.decision)).toEqual(["kept"]);
  }, 120000);
});

describe("hostRerunDecision: the host settles a rerun of a task it applied (#2877)", () => {
  const write = (path: string, rows: boolean): HostApplyWrite => ({ path, action: "modify", files: 0, diffs: rows ? 0 : 1, whole: false, exists: true, applies: rows ? null : true, ...(rows ? { rows: { count: 1, language: true, shape: "file", runs: 1, oneLine: true, sameHead: true, arity: true, separated: true } } : {}) });
  const h = (text: string) => hashBytes(text);
  test("a file that holds the host's bytes is kept, even when its content cannot be computed again", () => {
    expect(hostRerunDecision({ writes: [write("a.R", false)], written: { "a.R": h("x") } }, new Map([["a.R", h("x")]]), null, h)).toEqual({ decision: "kept", reason: null, writes: [] });
  });
  test("a file that holds the content computed again is kept (a record from before #2877)", () => {
    expect(hostRerunDecision({ writes: [write("t.R", true)] }, new Map([["t.R", h("rows")]]), [{ path: "t.R", content: "rows" }], h).decision).toBe("kept");
  });
  test("a row file whose rows differ is written again", () => {
    expect(hostRerunDecision({ writes: [write("t.R", true)], written: { "t.R": h("rows") } }, new Map([["t.R", h("edited")]]), [{ path: "t.R", content: "rows" }], h)).toEqual({ decision: "written", reason: null, writes: [{ path: "t.R", content: "rows" }] });
  });
  test("a verbatim file a correction changed goes to a session: the host never reverts a correction", () => {
    const decided = hostRerunDecision({ writes: [write("a.R", false)], written: { "a.R": h("x") } }, new Map([["a.R", h("fixed")]]), [{ path: "a.R", content: "x" }], h);
    expect(decided.decision).toBe("session");
    expect(decided.reason).toContain("changed since the host wrote it");
  });
  test("content the host cannot compute for a changed file goes to a session", () => {
    expect(hostRerunDecision({ writes: [write("t.R", true)] }, new Map([["t.R", h("edited")]]), null, h).reason).toContain("cannot compute");
  });
});

// Every language with a row file shape: the host's content computed again on its own written file
// is that file, so an invalidated row task whose file is unchanged is kept without a session.
describe("every row file shape is a fixed point of the host's rerun (#2877)", () => {
  for (const [language, row] of Object.entries(ROW_FILE_SHAPES)) {
    if (isNoRow(row)) continue;
    test(language, () => {
      const { path, reference, rows } = row.example;
      const written = rowFilePlan(path, rows, { source: "reference", text: reference }).content;
      expect(written).not.toBeNull();
      expect(rowFilePlan(path, rows, { source: "file", text: written ?? "" }).content).toBe(written);
    });
  }
});
