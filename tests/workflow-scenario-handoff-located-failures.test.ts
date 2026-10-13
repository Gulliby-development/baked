import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { failingPathsInOutput } from "../src/core/verification/convergence.js";
import { pendingWriters, testUpdateOwners } from "../src/core/workflows/task-graph.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 16, mdtoc-update 952805a8 (#972). The #931 handoff was in place, but
// T001's first failing check was the type check: tsc located the error in tests/cli.test.ts, the
// test T003 updates, and named the source declaration (src/cli.ts) in an indented line. The
// handoff saw a source file in the output and refused; a corrective task (1.15M tokens) rewrote
// the tests and README of four later tasks.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Exclude option", problem: "No --exclude", outcome: "--exclude exists", inScope: ["Add --exclude"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "parseArgs returns excludePattern", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the CLI", when: "parseArgs runs", then: "it returns excludePattern", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nAdd --exclude.\n## Decisions\nDEC-001: FR-001 needs parseArgs to return excludePattern.\n## Components\nsrc/cli.ts, tests/cli.test.ts\n## Data\nOptions\n## Verification\nTests\n## Risks\nExisting expectations change";
// The type check: the existing test's options object lacks the property the source now requires.
const typecheck: Check = {
  id: "typecheck",
  executable: "bun",
  args: ["-e", "const s = await Bun.file('src/cli.ts').text(); const t = await Bun.file('tests/cli.test.ts').text(); if (s.includes('excludePattern') && !t.includes('excludePattern')) { console.log(\"tests/cli.test.ts(258,45): error TS2769: No overload matches this call.\\n  Property 'excludePattern' is missing in type '{}'.\\n    src/cli.ts(1,30): 'excludePattern' is declared here.\"); process.exit(2) }"],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "task",
  envNames: [],
  writes: [],
};
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [typecheck] };
const planned = (id: string, path: string, dependsOn: string[] = [], checkIds = ["typecheck"]): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "modify" }], readHints: [], checkIds, origin: "planned", findingIds: [], rationale: "Required behavior" });
const plan = [planned("T001", "src/cli.ts"), planned("T002", "README.md", [], []), planned("T003", "tests/cli.test.ts", ["T001"])];

class ScriptedExecutor implements AgentExecutor {
  implemented: string[] = [];
  constructor(
    private root: string,
    private idle: string[] = [],
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A CLI", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/cli.ts"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: plan } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        this.implemented.push(task?.id ?? "");
        const path = task?.writes[0]?.path ?? "";
        if (this.idle.includes(task?.id ?? "")) {
          output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Already done", evidenceIds: [], unresolved: [] };
          break;
        }
        const content: Record<string, string> = {
          "src/cli.ts": "export const parseArgs = (o: { excludePattern: string }) => o;\n",
          "README.md": "# mdtoc\n\n`--exclude` skips matching headings.\n",
          "tests/cli.test.ts": "expect(parseArgs({ excludePattern: \"\" })).toEqual({ excludePattern: \"\" });\n",
        };
        writeFileSync(join(this.root, path), content[path] ?? "fixed\n");
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: `Wrote ${path}`, evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runPlan(idle: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "baked-mdtoc-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "src/cli.ts"), "export const parseArgs = (o: {}) => o;\n");
  writeFileSync(join(root, "tests/cli.test.ts"), "expect(parseArgs({})).toEqual({});\n");
  writeFileSync(join(root, "README.md"), "# mdtoc\n");
  const executor = new ScriptedExecutor(root, idle);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Add --exclude; update the parseArgs expectations", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const snapshot = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  return { root, executor, service, runId: run.runId, done };
}

describe("scenario: mdtoc-update 952805a8, a type error located in a test a later task updates (#972)", () => {
  test("the type check failing in that test hands the failure to the task that updates it", async () => {
    const { root, executor, service, runId, done } = await runPlan();
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "tests/cli.test.ts"), "utf8")).toContain("excludePattern");
    expect(service.store.run(runId).corrective_tasks).toBe(0);
    expect(executor.implemented).toEqual(["T001", "T002", "T003"]);
    const handoff = service.store.latestArtifact(runId, "tasks/handoffs/T001.json");
    if (!handoff) throw new Error("No handoff artifact");
    expect(JSON.parse(service.store.readArtifact(runId, handoff.id))).toMatchObject({ taskId: "T001", checkId: "typecheck", owners: ["T003"] });
  }, 60000);

  test("a planned task that changed nothing is rejected with the reason", async () => {
    const { service, runId, done } = await runPlan(["T001"]);
    expect(done.status).toBe("blocked");
    const error = service.store.artifacts(runId).filter((a) => a.logical_path.startsWith("errors/")).at(-1);
    expect(error ? service.store.readArtifact(runId, error.id) : "").toContain("Task T001 did not complete its implementation: it reported implemented but changed none of its files");
  }, 60000);
});

describe("failingPathsInOutput", () => {
  const tasks = plan;
  test("takes the files a line reports a failure in, not the ones indented lines explain it with", () => {
    expect(failingPathsInOutput("tests/cli.test.ts(258,45): error TS2769: No overload\n    src/cli.ts(1,30): declared here", tasks)).toEqual(["tests/cli.test.ts"]);
    expect(failingPathsInOutput("tests/cli.test.ts:\n(fail) parseArgs\n      at /work/src/cli.ts:3:1", tasks)).toEqual(["tests/cli.test.ts"]);
    expect(failingPathsInOutput("FAIL tests/cli.test.ts > parseArgs", tasks)).toEqual(["tests/cli.test.ts"]);
    expect(failingPathsInOutput("C:\\work\\src\\cli.ts(3,1): error TS1005", tasks)).toEqual(["src/cli.ts"]);
  });
  test("is empty when no line starts with a planned file", () => {
    expect(failingPathsInOutput("1 test failed in tests/cli.test.ts", tasks)).toEqual([]);
    expect(failingPathsInOutput("  tests/cli.test.ts:3", tasks)).toEqual([]);
  });
});

describe("testUpdateOwners and pendingWriters", () => {
  const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: plan };
  const [source, readme, update] = plan as [Task, Task, Task];
  const row = (t: Task, status: string) => ({ id: t.id, status, generation: 0, snapshot_id: "s", definition_json: JSON.stringify(t) }) as never;
  const rows = (status: string) => [row(source, "implemented"), row(readme, "pending"), row(update, status)];
  const tsc = "tests/cli.test.ts(258,45): error TS2769: No overload matches this call.\n    src/cli.ts(1,30): 'excludePattern' is declared here.";
  test("a located type error in a later task's test is that task's", () => {
    expect(testUpdateOwners(graph, rows("pending"), {}, source, tsc)).toEqual(["T003"]);
    expect(testUpdateOwners(graph, rows("pending"), {}, source, `${tsc}\nsrc/cli.ts(2,1): error TS1005`)).toEqual([]);
  });
  test("pendingWriters names the unfinished planned tasks that write a file", () => {
    expect(pendingWriters(graph, rows("pending"), {}, source, "tests/cli.test.ts")).toEqual(["T003"]);
    expect(pendingWriters(graph, rows("verified"), {}, source, "tests/cli.test.ts")).toEqual([]);
    expect(pendingWriters(graph, rows("pending"), {}, update, "tests/cli.test.ts")).toEqual([]);
  });
});
