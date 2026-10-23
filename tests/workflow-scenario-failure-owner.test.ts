import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { canonical, hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { fileHash } from "../src/core/workflows/effects.js";
import type { Check, RunPolicy, Spec, Task, TaskGraph } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { sizePlan, splitTestTasks } from "../src/core/workflows/sizing.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// R46 envguard-update and youngkit bijections (#1563, #1564). Real check processes print
// deterministic Bun and Go diagnostics, without requiring an installed Go toolchain.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Failure ownership", problem: "A change needs tests", outcome: "Required behavior is checked", inScope: ["Implement and test the change"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The change works", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "valid input", when: "the program runs", then: "the required result is returned", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nCode and tests.\n## Decisions\nDEC-001: FR-001 needs a source and tests.\n## Components\nSource and tests\n## Data\nText\n## Verification\nRequired checks\n## Risks\nStale tests and source defects";
const task = (id: string, paths: string[], dependsOn: string[] = [], checkIds: string[] = []): Task => ({ id, title: `Write ${paths.join(", ")}`, description: `Write ${paths.join(", ")}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: paths.map((path) => ({ path, action: "create" })), readHints: [], checkIds, origin: "planned", findingIds: [], rationale: "Required behavior" });
const graphOf = (tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks });
const check = (id: string, script: string, scope: Check["scope"]): Check => ({ id, executable: "bun", args: ["-e", script], cwd: ".", timeoutMs: 10000, required: true, scope, envNames: [], writes: [] });
const UPDATE_FAILURE = "tests/project.test.ts:\n(fail) project declares the CLI build command";
const PANIC = "--- FAIL: TestParse (0.00s)\npanic: runtime error: index out of range [1] with length 1\nexample.com/p/a.Parse()\n\t/work/a/parse.go:82 +0x12\nexample.com/p/a.TestParse()\n\t/work/a/parse_test.go:8 +0x20";

class ScriptedExecutor implements AgentExecutor {
  attempts: string[] = [];
  ownership: unknown[] = [];
  correctionWrites: string[][] = [];
  checksBeforeCorrection: number[] = [];
  caseChecks: string[] = [];
  caseFailures: { taskId: string; missing: string[] }[] = [];
  service?: NativeWorkflowService;
  constructor(private root: string, private graph: TaskGraph, private mode: "update" | "panic", private cutOff = false, private scenarioSpec = spec, private reportOnly = false) {}
  write(path: string, content: string) {
    mkdirSync(dirname(join(this.root, path)), { recursive: true });
    writeFileSync(join(this.root, path), content);
  }
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture", facts: [], unknowns: [], constraints: [], suggestedScope: this.graph.tasks.flatMap((t) => t.writes.map((w) => w.path)) }; break;
      case "spec": output = this.scenarioSpec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: this.graph }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const t = request.task as Task;
        this.attempts.push(t.id);
        let summary = "Done";
        if (t.origin !== "planned") {
          this.correctionWrites.push(t.writes.map((w) => w.path).sort());
          this.checksBeforeCorrection.push(this.service?.store.taskCheckRuns(request.runId, "T002").filter((c) => c.check_id === (this.reportOnly ? "tests" : "tests-written") && c.status === "failed").length ?? 0);
          if (this.mode === "panic") this.write("a/parse.go", "package a\nfunc Parse() {}\n");
          else this.write("tests/project.test.ts", "expect(build).toBe('new');\n");
        } else if (this.mode === "update") {
          for (const w of t.writes) {
            if (w.path === "src/ci.ts") this.write(w.path, "export const ci = true;\n");
            else if (w.path === "pyproject.toml") {
              const before = fileHash(join(this.root, w.path));
              const effect = this.service?.store.prepareEffect(request.runId, request.attemptId, "file_patch", { path: w.path, tool: "edit_file" }, before, null);
              this.write(w.path, "[project.scripts]\nbuild = 'new'\n");
              if (effect) this.service?.store.finishFileEffect(request.runId, effect, fileHash(join(this.root, w.path)));
            }
            else if (w.path === "tests/project.test.ts") this.write(w.path, "expect(build).toBe('new');\n");
            else this.write(w.path, "test('--ci', () => expect(true).toBe(true));\n");
          }
          if (t.id === "T002") {
            summary = "The build was not run because src/ci.ts is handled by a separate task.";
            this.ownership.push(request.failureOwner?.(UPDATE_FAILURE));
          }
          if (t.writes.some((w) => w.path === "tests/ci.test.ts")) {
            // An unsplit test plan can still run beside the existing-test updater.
            this.ownership.push(request.failureOwner?.(UPDATE_FAILURE));
          }
        } else if (t.id === "T001") {
          this.write("a/parse.go", 'package a\nfunc Parse() { panic("index") }\n');
          this.write("a/other.go", "package a\nfunc Other() {}\n");
          this.write("cli/cmd.go", "package cli\nfunc Command() {}\n");
        } else {
          this.write("a/parse_test.go", 'package a\nimport "example.com/p/cli"\nfunc TestParse() { Parse(); cli.Command() }\n');
          this.ownership.push(request.failureOwner?.(PANIC));
          if (this.reportOnly) summary = "The required parse test exposes a panic in a/parse.go, which this task cannot write.";
          if (this.cutOff)
            this.service?.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical({ schemaVersion: 1, profileId: request.profile.id, taskId: t.id, maxSteps: request.maxSteps, maxTokens: 1000, stopReason: "submitted", finalizedBy: "tokens", totalTokens: 1000, steps: [{ inputTokens: 50, outputTokens: 50, cacheReadTokens: null, toolCalls: 1, tools: ["edit_file"], compactedBytes: 0 }] }));
        }
        if (request.caseCheck) this.caseChecks.push(t.id);
        const missing = await request.caseCheck?.(this.root);
        if (missing?.length) this.caseFailures.push({ taskId: t.id, missing });
        output = { schemaVersion: 1, taskId: t.id, outcome: "implemented", summary, evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", // The run's spec, with the criterion the host adds for a request that names CI (#1943).
        coverage: ((this.service?.store.state(request.runId).spec as Spec | undefined) ?? this.scenarioSpec).criteria.map((c) => ({ criterionId: c.id, verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" })), findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(mode: "update" | "panic", split = false, cutOff = false, reportOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "baked-failure-owner-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const update = { ...task("T005", ["tests/project.test.ts"], ["T001", "T002"], ["tests"]), writes: [{ path: "tests/project.test.ts", action: "modify" as const, reason: "The requested build command changes this existing expectation" }] };
  let graph = mode === "update"
    ? graphOf([task("T001", ["src/ci.ts"]), { ...task("T002", ["pyproject.toml"], ["T001"]), writes: [{ path: "pyproject.toml", action: "modify" }] }, task("T004", ["tests/ci.test.ts"], ["T001", "T002"], ["tests"]), update])
    : graphOf([task("T001", ["a/parse.go", "a/other.go", "cli/cmd.go"]), task("T002", ["a/parse_test.go"], ["T001"], reportOnly ? [] : ["tests-written"])]);
  const scenarioSpec: Spec = split ? { ...spec, criteria: [{ ...spec.criteria[0]!, given: 'the "--ci" option' }, { ...spec.criteria[0]!, id: "AC-002", given: "the build command" }] } : spec;
  if (split) {
    graph.tasks = graph.tasks.map((t, index) => index < 2 ? { ...t, criterionIds: ["AC-002"] } : t);
    const combined = { ...graph.tasks[2] as Task, writes: [...(graph.tasks[2]?.writes ?? []), ...update.writes] };
    const unsplit = { ...graph, tasks: [...graph.tasks.slice(0, 2), combined] };
    // The split must exceed the expected price cap, not just the default's uncertain high end.
    const report = sizePlan({ graph: unsplit, policy: { ...defaultWorkflowPolicy, sizing: { maxAttemptTokens: 350_000 } }, samples: [], spent: 0 });
    graph = splitTestTasks(unsplit, report, scenarioSpec) as TaskGraph;
  }
  graph.specHash = hashJson(scenarioSpec);
  const tests = mode === "update"
    ? check("tests", `if ((await Bun.file('pyproject.toml').text()).includes('new') && !(await Bun.file('tests/project.test.ts').text()).includes("'new'")) { console.log(${JSON.stringify(UPDATE_FAILURE)}); process.exit(1) }`, "feature")
    : check("tests-written", `if (await Bun.file('a/parse_test.go').exists() && (await Bun.file('a/parse.go').text()).includes('panic')) { console.log(${JSON.stringify(PANIC)}); process.exit(1) }`, "task");
  const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: mode === "panic" ? [...(reportOnly ? [] : [tests]), { ...tests, id: "tests", scope: "feature" }] : [tests] };
  const executor = new ScriptedExecutor(root, graph, mode, cutOff, scenarioSpec, reportOnly);
  if (mode === "update") {
    executor.write("pyproject.toml", "[project.scripts]\nbuild = 'old'\n");
    executor.write("tests/project.test.ts", "expect(build).toBe('old');\n");
  }
  const service = new NativeWorkflowService(root, { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } }, executor);
  executor.service = service;
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: mode === "update" ? "Update the build command and its obsolete project assertion, and add CI tests" : "Parse valid inputs and test them", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const waiting = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error(`No approval: ${waiting.status} ${waiting.reason}`);
  await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  expect(service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/")).map((a) => service.store.readArtifact(run.runId, a.id))).toEqual([]);
  return { service, runId: run.runId, done, executor, root };
}

describe("scenario: shared failure ownership (#1563, #1564)", () => {
  for (const split of [false, true]) test(`a reported failure waits for the existing-test updater, sizing split=${split}`, async () => {
    const { service, runId, done, executor, root } = await runScenario("update", split);
    expect(done.status).toBe("completed");
    expect(executor.caseFailures).toEqual([]);
    expect(service.store.run(runId).corrective_tasks).toBe(0);
    const report = service.store.latestArtifact(runId, "tasks/defects/T002.json");
    expect(report).toBeTruthy();
    const updater = "T005";
    expect(JSON.parse(service.store.readArtifact(runId, report?.id ?? ""))).toMatchObject({ findings: [], handoffs: [{ checkId: "tests", owners: [updater] }] });
    expect(executor.ownership[0]).toMatchObject({ kind: "test-update", owners: [updater] });
    if (split) {
      expect(executor.attempts.indexOf(updater)).toBeLessThan(executor.attempts.indexOf("T004"));
      expect(executor.caseChecks).toContain("T004");
      expect(executor.caseChecks).not.toContain(updater);
    }
    else expect(executor.ownership[1]).toMatchObject({ kind: "test-update", owners: [updater] });
    expect(readFileSync(join(root, "tests/project.test.ts"), "utf8")).toContain("'new'");
  }, 60000);

  for (const cutOff of [false, true]) test(`a named Go panic skips the test task's continuation and narrows its corrective, cutOff=${cutOff}`, async () => {
    const { service, runId, done, executor } = await runScenario("panic", false, cutOff);
    expect(done.status).toBe("completed");
    expect(executor.attempts.filter((id) => id === "T002")).toHaveLength(1);
    expect(service.store.state(runId).taskContinuations).toEqual({});
    expect(executor.ownership[0]).toMatchObject({ kind: "finished", owners: ["T001"], files: ["a/parse.go"] });
    expect(executor.correctionWrites).toEqual([["a/parse.go", "a/parse_test.go"]]);
    expect(executor.checksBeforeCorrection).toEqual([1]);
  }, 60000);
  test("a finished-source defect reported in the summary routes to that source owner", async () => {
    const { service, runId, done, executor } = await runScenario("panic", false, false, true);
    expect(done.status).toBe("completed");
    const report = service.store.latestArtifact(runId, "tasks/defects/T002.json");
    expect(report).toBeTruthy();
    expect(JSON.parse(service.store.readArtifact(runId, report?.id ?? ""))).toMatchObject({ files: ["a/parse.go"], findings: [expect.any(String)] });
    expect(executor.ownership[0]).toMatchObject({ kind: "finished", owners: ["T001"] });
    expect(executor.correctionWrites).toEqual([["a/parse.go", "a/parse_test.go"]]);
    expect(executor.checksBeforeCorrection).toEqual([1]);
  }, 60000);
});
