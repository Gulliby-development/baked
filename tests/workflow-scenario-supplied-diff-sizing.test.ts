import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task, TaskGraph } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import {
  estimateSourceText,
  SUPPLIED_PER_FILE,
  type SizingSample,
  sizePlan,
  suppliedLines,
  splitTestTasks,
  suppliedTaskPrice,
} from "../src/core/workflows/sizing.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Bench round 64, spdxok-update e7aabb5c (#2002). The brief supplied every hunk verbatim, yet
// sizing priced T001 (2 files) at 307k-762k and T004 (2 files) at 242k-683k from per-file history
// rates, above one attempt's 600k, and sent the plan back to be split. The replan cost 98k (plan
// 56k, analyze 42k) and the three tasks it gave cost 59k, 72k and 105k, below every history sample.
// With `sizing.suppliedDiff` a task whose every file the request supplies is priced from the
// supplied lines, at least the lowest measured exact-diff cost per file, and never split on its
// file count.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const hunk = (path: string, added: string[], removed: string[] = []) =>
  [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${removed.length + 1} +1,${added.length + 1} @@`, " // SPDX", ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n");
/** The spdxok brief: one fenced diff for each of the four files, two files per planned task. */
const request = [
  "Update the SPDX handling. Apply exactly these changes:",
  "```diff",
  hunk("src/spdx.ts", ["export const LIST = '3.24';", "export const OK = true;"], ["export const LIST = '3.21';"]),
  hunk("src/cli.ts", ["  check(args);"], ["  run(args);"]),
  "```",
  "And in the license and format modules:",
  "```diff",
  hunk("src/license.ts", ["export const DEFAULT = 'MIT';"]),
  hunk("src/format.ts", ["export const WIDTH = 80;", "export const INDENT = 2;"], ["export const WIDTH = 72;"]),
  "```",
  "- keep the README as it is",
  "- run the tests",
].join("\n");

const planned = (id: string, paths: string[], action: "create" | "modify" = "modify"): Task => ({
  id, title: `update ${paths.join(", ")}`, description: `update ${paths.join(", ")}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer",
  writes: paths.map((path) => ({ path, action })), readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior",
});
const graph = (...tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "spdxok", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });
const spdxok = graph(planned("T001", ["src/spdx.ts", "src/cli.ts"]), planned("T004", ["src/license.ts", "src/format.ts"]));

// 80 finished 2-file code tasks of this project at 300k-758k: the per-file middle half prices a
// 2-file task above 600k, as the 79-214 samples of round 64 did.
const history: SizingSample[] = Array.from({ length: 80 }, (_, i) => ({
  runId: `r${i}`, taskId: "T001", kind: "code", action: "modify", source: "project", files: 2, tokens: 300_000 + i * 5_800, model: null,
}));
const cheapestSample = Math.min(...history.map((s) => s.tokens));
const policy = (suppliedDiff?: boolean): RunPolicy => ({ ...defaultWorkflowPolicy, sizing: { maxAttemptTokens: 600_000, ...(suppliedDiff === undefined ? {} : { suppliedDiff }) } });
const size = (p: RunPolicy, g = spdxok, text: string | null = request) => sizePlan({ graph: g, policy: p, samples: history, spent: 0, request: text });

describe("supplied blocks of a request (#2002)", () => {
  test("a fenced unified diff gives each file its added and removed lines", () => {
    const lines = suppliedLines(request, ["src/spdx.ts", "src/cli.ts", "src/license.ts", "src/format.ts", "README.md"]);
    expect(Object.fromEntries(lines)).toEqual({ "src/spdx.ts": 3, "src/cli.ts": 2, "src/license.ts": 1, "src/format.ts": 3 });
  });

  test("prose list items after a diff block are not lines of its last file", () => {
    expect(suppliedLines(request, ["src/format.ts"]).get("src/format.ts")).toBe(3);
  });

  test("a new file's diff, a ./ path and a header timestamp name the planned path", () => {
    const text = ["```patch", "--- /dev/null", "+++ ./src/new.ts\t2026-10-01 10:00:00", "@@ -0,0 +1,2 @@", "+export const a = 1;", "+export const b = 2;", "```"].join("\n");
    expect(Object.fromEntries(suppliedLines(text, ["src/new.ts"]))).toEqual({ "src/new.ts": 2 });
  });

  test("a deleted file's diff supplies no lines", () => {
    const text = ["```diff", "--- a/src/old.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-export {};", "```"].join("\n");
    expect(suppliedLines(text, ["src/old.ts"]).size).toBe(0);
  });

  test("a fenced block named by the prose before it, or by its first line, supplies the whole file", () => {
    const text = [
      "Replace `src/a.ts` with:",
      "```ts",
      "export const a = 1;",
      "export const b = 2;",
      "```",
      "The new module:",
      "```ts",
      "// src/b.ts",
      "export const c = 3;",
      "```",
    ].join("\n");
    expect(Object.fromEntries(suppliedLines(text, ["src/a.ts", "src/b.ts"]))).toEqual({ "src/a.ts": 2, "src/b.ts": 2 });
  });

  test("a block named by no planned path, or by two, supplies nothing", () => {
    const text = ["Example output:", "```", "ok 1", "```", "Change `src/a.ts` and `src/b.ts` like this:", "```ts", "export {};", "```"].join("\n");
    expect(suppliedLines(text, ["src/a.ts", "src/b.ts"]).size).toBe(0);
  });

  test("a prose line far above an unrelated block does not attribute it", () => {
    const text = ["Replace `src/a.ts` with:", "```ts", "export {};", "```", "```text", "unrelated", "```"].join("\n");
    expect(Object.fromEntries(suppliedLines(text, ["src/a.ts"]))).toEqual({ "src/a.ts": 1 });
  });
});

describe("scenario: spdxok-update R64, a plan priced by files x history and split (#2002)", () => {
  test("without the policy the history prices both 2-file tasks above one attempt and the plan is split, as before", () => {
    for (const p of [policy(), policy(false)]) {
      const report = size(p);
      expect(report.decision).toBe("split-tasks");
      expect(report.tasks.map((t) => [t.taskId, t.oversized, t.basis])).toEqual([["T001", true, "history"], ["T004", true, "history"]]);
      expect(report.tasks.every((t) => t.estimate.high > 600_000)).toBe(true);
      expect(estimateSourceText(report.tasks)).toBeNull();
    }
  });

  test("with suppliedDiff the tasks are priced from the supplied lines, below every sample, and the plan is not split", () => {
    const report = size(policy(true));
    expect(report.decision).not.toBe("split-tasks");
    expect(report.reasons.join(" ")).not.toContain("above one attempt");
    for (const task of report.tasks) {
      expect(task).toMatchObject({ basis: "supplied", oversized: false });
      // The real tasks cost 59k-105k; the floor's low end is the lowest measured rate per file.
      expect(task.estimate.low).toBe(2 * SUPPLIED_PER_FILE.low);
      expect(task.estimate.low).toBeLessThanOrEqual(72_000);
      expect(task.estimate.high).toBeGreaterThanOrEqual(105_000);
      expect(task.estimate.high).toBeLessThan(cheapestSample);
    }
    expect(report.tasks.map((t) => t.suppliedLines)).toEqual([5, 4]);
    expect(estimateSourceText(report.tasks)).toBe("Task estimates: T001 (5 lines), T004 (4 lines) from the lines the request supplies");
  });

  test("a task with a file the request does not supply keeps its history price and split", () => {
    const g = graph(planned("T001", ["src/spdx.ts", "src/cli.ts"]), planned("T002", ["src/license.ts", "src/main.ts"]));
    const report = size(policy(true), g);
    expect(report.tasks.map((t) => [t.taskId, t.basis, t.oversized])).toEqual([["T001", "supplied", false], ["T002", "history", true]]);
    expect(report.decision).toBe("split-tasks");
    expect(report.reasons).toHaveLength(1);
    expect(report.reasons[0]).toContain("T002 writes 2 files");
    expect(estimateSourceText(report.tasks)).toBe("Task estimates: T001 (5 lines) from the lines the request supplies; T002 from history");
  });

  test("a request without verbatim blocks changes nothing", () => {
    const report = size(policy(true), spdxok, "Update the SPDX list to 3.24 in src/spdx.ts and src/cli.ts.");
    expect(report.decision).toBe("split-tasks");
    expect(report.tasks.every((t) => t.basis === "history")).toBe(true);
  });

  test("supplied lines above one attempt still split a task of several files", () => {
    const many = Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`);
    const big = ["```diff", hunk("src/a.ts", many), hunk("src/b.ts", many), "```"].join("\n");
    const sized = suppliedTaskPrice(planned("T001", ["src/a.ts", "src/b.ts"]), suppliedLines(big, ["src/a.ts", "src/b.ts"]), 600_000);
    expect(sized).toMatchObject({ lines: 800, oversized: true, estimate: { low: 200_000, high: 800_000 } });
  });
});

// Bench round 65, aclvet-update plan-1 (#2019). The request gave internal/cli/summary_test.go "with
// exactly this content" (98 lines) and the cli_test.go change as a diff (one expectedUsage line).
// Sizing priced both test tasks by cases from test history: T004 384k-893k (actual 58k), T002
// 426k-1.14M (actual 104k). A test task whose files the request supplies is priced like any other
// supplied task.
const summaryTest = Array.from({ length: 98 }, (_, i) => (i === 0 ? "package cli" : `// case ${i}`));
const aclvetPlan1 = [
  "Create `internal/cli/summary_test.go` with exactly this content:",
  "```go",
  ...summaryTest,
  "```",
  "Change the usage line in the test:",
  "```diff",
  "--- a/internal/cli/cli_test.go",
  "+++ b/internal/cli/cli_test.go",
  "@@ -12,3 +12,3 @@",
  " func TestUsage(t *testing.T) {",
  "-\tconst expectedUsage = \"usage: aclvet [flags] FILE\"",
  "+\tconst expectedUsage = \"usage: aclvet [flags] FILE...\"",
  " }",
  "```",
].join("\n");
// 40 finished test tasks of 380k-1.16M with case counts: case history prices any test task
// at hundreds of thousands, as aclvet's did.
const testHistory: SizingSample[] = Array.from({ length: 40 }, (_, i) => ({
  runId: `t${i}`, taskId: "T004", kind: "test", action: "create", source: "project", files: 1, tokens: 380_000 + i * 20_000, model: null, criteria: 4, cases: 2 + (i % 40),
}));
const cheapestTest = Math.min(...testHistory.map((s) => s.tokens));
const sizeTests = (p: RunPolicy, g: TaskGraph, text: string) => sizePlan({ graph: g, policy: p, samples: testHistory, spent: 0, request: text });
const aclvetTests = graph(planned("T002", ["internal/cli/cli_test.go"]), planned("T004", ["internal/cli/summary_test.go"], "create"));

describe("scenario: aclvet-update R65, test files the request supplies priced by cases (#2019)", () => {
  test("without the policy both test tasks keep their case price from history, as before", () => {
    const report = sizeTests(policy(false), aclvetTests, aclvetPlan1);
    expect(report.tasks.map((t) => [t.taskId, t.kind, t.basis])).toEqual([["T002", "test", "history"], ["T004", "test", "history"]]);
    expect(report.tasks.every((t) => t.estimate.low >= cheapestTest)).toBe(true);
  });

  test("with suppliedDiff a supplied test file is priced from its lines, below every test sample", () => {
    const report = sizeTests(policy(true), aclvetTests, aclvetPlan1);
    expect(report.tasks).toMatchObject([
      { taskId: "T002", kind: "test", basis: "supplied", suppliedLines: 2, oversized: false, estimate: SUPPLIED_PER_FILE },
      { taskId: "T004", kind: "test", basis: "supplied", suppliedLines: 98, oversized: false, estimate: { low: 34_000, high: 134_000 } },
    ]);
    // The forecast-floor rule: the low end sits below the cheapest finished test task, and the
    // range holds what the tasks cost (104k and 58k).
    for (const task of report.tasks) expect(task.estimate.low).toBeLessThan(cheapestTest);
    expect(report.tasks.map((t) => t.estimate.high >= 104_000)).toEqual([true, true]);
    expect(report.decision).toBe("fits");
    expect(estimateSourceText(report.tasks)).toBe("Task estimates: T002 (2 lines), T004 (98 lines) from the lines the request supplies");
  });

  test("a test task whose file the request does not supply keeps the case price", () => {
    const g = graph(planned("T004", ["internal/cli/summary_test.go"], "create"), planned("T005", ["internal/cli/args_test.go"], "create"));
    const report = sizeTests(policy(true), g, aclvetPlan1);
    expect(report.tasks.map((t) => [t.taskId, t.basis])).toEqual([["T004", "supplied"], ["T005", "history"]]);
    expect(report.tasks[1]?.estimate.low).toBeGreaterThanOrEqual(cheapestTest);
  });

  test("a test task with supplied lines above one attempt splits on those lines, not on its cases", () => {
    const many = Array.from({ length: 400 }, (_, i) => `test('t${i}', () => {});`);
    const big = ["```diff", hunk("tests/a.test.ts", many), hunk("tests/b.test.ts", many), "```"].join("\n");
    const report = sizeTests(policy(true), graph(planned("T003", ["tests/a.test.ts", "tests/b.test.ts"])), big);
    expect(report.tasks).toMatchObject([{ taskId: "T003", kind: "test", basis: "supplied", suppliedLines: 800, oversized: true }]);
    expect(report.decision).toBe("split-tasks");
    expect(report.reasons).toEqual(["T003 writes 2 files and needs about 800000 tokens for the 800 lines the request supplies, above one attempt's 600000"]);
  });

  test("the host splits such a task by file and never slices a supplied file by criterion", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `test('t${i}', () => {});`);
    const text = ["```diff", hunk("tests/a.test.ts", lines), hunk("tests/b.test.ts", lines), "```"].join("\n");
    // No test history and a small cap: the default case price of each file is above one attempt,
    // so a history-priced file of two criteria would be cut into two slices.
    const task = { ...planned("T003", ["tests/a.test.ts", "tests/b.test.ts"]), criterionIds: ["AC-001", "AC-002"] };
    const g = graph(task);
    const p: RunPolicy = { ...defaultWorkflowPolicy, sizing: { maxAttemptTokens: 100_000, suppliedDiff: true } };
    const report = sizePlan({ graph: g, policy: p, samples: [], spent: 0, request: text });
    expect(report.tasks).toMatchObject([{ taskId: "T003", basis: "supplied", suppliedLines: 120, oversized: true }]);
    const split = splitTestTasks(g, report);
    expect(split?.tasks.map((t) => [t.id, t.writes.map((w) => w.path), t.criterionIds])).toEqual([
      ["T003", ["tests/a.test.ts"], ["AC-001", "AC-002"]],
      ["T004", ["tests/b.test.ts"], ["AC-001", "AC-002"]],
    ]);
  });
});

// Bench round 65 (#2018): seqmill-update and aclvet-update supplied a README diff whose hunk shows
// the README's own code fences as context lines (" ```bash", " ```"). The fence reader ended the
// diff block there, README.md got no supplied lines, and each mixed task fell back to history:
// seqmill T001 381k-1.06M for a 276k run, aclvet T002 oversized and a split-tasks replan of 81k.
const readmeDiff = (tool: string) => [
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -10,6 +10,7 @@",
  " ## Usage",
  " ",
  " ```bash",
  `-${tool} --help`,
  `+${tool} --version`,
  `+${tool} --help`,
  " ```",
  " ",
  "@@ -30,3 +31,2 @@",
  " ## License",
  "-----",
  " MIT",
].join("\n");
const cliDiff = ["--- a/src/seqmill/cli.py", "+++ b/src/seqmill/cli.py", "@@ -1,4 +1,6 @@", " import argparse", "+from . import __version__", " ", " def main():", "-    p = argparse.ArgumentParser()", "+    p = argparse.ArgumentParser(prog='seqmill')", "+    p.add_argument('--version', action='version', version=__version__)"].join("\n");
const testFile = Array.from({ length: 66 }, (_, i) => (i === 0 ? "from seqmill import cli" : `assert cli is not None  # ${i}`));
const seqmillBrief = [
  "Add a --version flag. Apply exactly these changes:",
  "```diff",
  cliDiff,
  "```",
  "Update the README:",
  "```diff",
  readmeDiff("seqmill"),
  "```",
  "Create `tests/test_version.py` with exactly this content:",
  "```python",
  ...testFile,
  "```",
].join("\n");
const aclvetBrief = [
  "Change the usage line. In `internal/cli/cli_test.go`:",
  "```diff",
  "--- a/internal/cli/cli_test.go",
  "+++ b/internal/cli/cli_test.go",
  "@@ -12,3 +12,3 @@",
  " func TestUsage(t *testing.T) {",
  "-\tconst expectedUsage = \"usage: aclvet [flags] FILE\"",
  "+\tconst expectedUsage = \"usage: aclvet [flags] FILE...\"",
  " }",
  "```",
  "and the README:",
  "```diff",
  readmeDiff("aclvet"),
  "```",
].join("\n");
const seqmillPaths = ["src/seqmill/cli.py", "README.md", "tests/test_version.py"];
const aclvetPaths = ["internal/cli/cli_test.go", "README.md"];

describe("scenario: seqmill-update and aclvet-update R65, a README diff across a code fence (#2018)", () => {
  test("every added and removed line of a README hunk with a code fence counts, a removed --- rule too", () => {
    expect(Object.fromEntries(suppliedLines(seqmillBrief, seqmillPaths))).toEqual({ "src/seqmill/cli.py": 4, "README.md": 4, "tests/test_version.py": 66 });
    expect(Object.fromEntries(suppliedLines(aclvetBrief, aclvetPaths))).toEqual({ "internal/cli/cli_test.go": 2, "README.md": 4 });
  });

  test("seqmill's mixed task is priced from the supplied lines and fits", () => {
    const report = size(policy(true), graph(planned("T001", seqmillPaths)), seqmillBrief);
    expect(report.tasks).toMatchObject([{ taskId: "T001", basis: "supplied", suppliedLines: 74, oversized: false, estimate: { low: 102_000, high: 402_000 } }]);
    expect(report.decision).toBe("fits");
    // Below every history sample (the forecast-floor rule) and around the 276k the run cost.
    expect(report.tasks[0]?.estimate.low).toBeLessThan(cheapestSample);
  });

  test("aclvet's test-and-README task is priced from the supplied lines, with no split-tasks replan", () => {
    const report = size(policy(true), graph(planned("T002", aclvetPaths)), aclvetBrief);
    expect(report.tasks).toMatchObject([{ taskId: "T002", basis: "supplied", suppliedLines: 6, oversized: false }]);
    expect(report.decision).toBe("fits");
  });
});

// The same run through the scheduler: the request reaches sizing and the approval names the source.
const spec: Spec = { schemaVersion: 1, featureId: "spdxok", revision: 1, title: "SPDX update", problem: "The SPDX list is old", outcome: "The list is current", inScope: ["Update the list"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The SPDX list is 3.24", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the list", when: "it is read", then: "it is 3.24", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nApply the supplied diff.\n## Decisions\nDEC-001: FR-001 in src/spdx.ts.\n## Components\nsrc/spdx.ts, src/cli.ts, src/license.ts, src/format.ts\n## Data\nNone\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["--version"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const created = [planned("T001", ["src/spdx.ts", "src/cli.ts"], "create"), planned("T002", ["src/license.ts", "src/format.ts"], "create")];

class ScriptedExecutor implements AgentExecutor {
  outputs: string[] = [];
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    this.outputs.push(request.profile.output);
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "spdxok", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: created } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

/** New files supplied as diffs: 3 + 2 lines for T001, 1 + 2 for T002. */
const newFile = (path: string, lines: string[]) => [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
const brief = [
  "Create these files exactly as given:",
  "```diff",
  newFile("src/spdx.ts", ["export const LIST = '3.24';", "export const OK = true;", "export {};"]),
  newFile("src/cli.ts", ["import './spdx';", "export {};"]),
  newFile("src/license.ts", ["export const DEFAULT = 'MIT';"]),
  newFile("src/format.ts", ["export const WIDTH = 80;", "export const INDENT = 2;"]),
  "```",
].join("\n");

async function runToApproval(suppliedDiff: boolean) {
  const root = mkdtempSync(join(tmpdir(), "baked-supplied-diff-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  // An attempt cap the default rates of two files pass, while the supplied lines stay within it.
  const runPolicy: RunPolicy = { ...defaultWorkflowPolicy, checks: [check], sizing: { maxAttemptTokens: 10_000, ...(suppliedDiff ? { suppliedDiff } : {}) } };
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: runPolicy } };
  const executor = new ScriptedExecutor();
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "spdxok", workflowId: "sdd", prompt: brief, ownerLabel: "test", policy: runPolicy });
  await service.drive(run.runId, new AbortController().signal);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  const read = (path: string) => {
    const artifact = service.store.latestArtifact(run.runId, path);
    return artifact ? JSON.parse(service.store.readArtifact(run.runId, artifact.id)) : null;
  };
  return { executor, approval, body: JSON.parse(approval?.body_json ?? "{}") as { estimateSource?: string }, read };
}

describe("scenario: a supplied-diff brief through the scheduler (#2002)", () => {
  test("with suppliedDiff the plan goes to approval unsplit and the approval names the estimate source", async () => {
    const { executor, approval, body, read } = await runToApproval(true);
    expect(approval).toBeDefined();
    expect(read("sizing/plan-0.json")).toMatchObject({ decision: "fits", tasks: [{ taskId: "T001", basis: "supplied", suppliedLines: 5 }, { taskId: "T002", basis: "supplied", suppliedLines: 3 }] });
    expect(read("sizing/plan-1.json")).toBeNull();
    expect(executor.outputs.filter((o) => o !== "research")).toEqual(["spec", "plan", "analysis"]);
    expect(body.estimateSource).toBe("Task estimates: T001 (5 lines), T002 (3 lines) from the lines the request supplies");
  }, 60_000);

  test("without it the same plan is sent back to be split, and the approval carries no estimate source", async () => {
    const { executor, approval, body, read } = await runToApproval(false);
    expect(approval).toBeDefined();
    expect(read("sizing/plan-0.json")).toMatchObject({ decision: "split-tasks", tasks: [{ taskId: "T001", basis: "default" }, { taskId: "T002", basis: "default" }] });
    expect(executor.outputs.filter((o) => o !== "research")).toEqual(["spec", "plan", "analysis", "plan", "analysis"]);
    expect(body.estimateSource).toBeUndefined();
  }, 60_000);
});
