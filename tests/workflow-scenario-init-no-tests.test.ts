import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { noTestsCollected } from "../src/core/verification/convergence.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { namesPath } from "../src/core/workflows/task-graph.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 19, ignorewhy 84f2692e (#1031). A Python plan writes the package's
// __init__.py first, then its modules, then the tests. A module task's summary mentions
// `pkg/globs.py`; before the fix that "named" `pkg/__init__.py` (another done task's file), the
// defect routing ran the required test check, pytest collected nothing (exit 5, the tests come
// later) and a corrective task opened for every module task.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Ignore why", problem: "Globs are missing", outcome: "Globs exist", inScope: ["Create the package"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Globs match", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the tests run", then: "globs match", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA package and its tests.\n## Decisions\nDEC-001: FR-001 is tested last.\n## Components\npkg/__init__.py, pkg/globs.py, tests/test_globs.py\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
// pytest without a test file: "no tests ran" and exit code 5.
const pytest: Check = { id: "tests", executable: "bun", args: ["-e", "if (!(await Bun.file('tests/test_globs.py').exists())) { console.log('collected 0 items\\n\\n===== no tests ran in 0.01s ====='); process.exit(5) } console.log('1 passed')"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [pytest] };
const planned = (id: string, path: string, dependsOn: string[] = []): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });

class ScriptedExecutor implements AgentExecutor {
  implemented: string[] = [];
  constructor(
    private root: string,
    private moduleSummary: string,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["pkg/"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned("T001", "pkg/__init__.py"), planned("T002", "pkg/globs.py", ["T001"]), planned("T003", "tests/test_globs.py", ["T002"])] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        this.implemented.push(task?.id ?? "");
        for (const write of task?.writes ?? []) {
          mkdirSync(dirname(join(this.root, write.path)), { recursive: true });
          writeFileSync(join(this.root, write.path), "# code\n");
        }
        const summary = task?.id === "T002" ? this.moduleSummary : `Created ${task?.writes[0]?.path}`;
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary, evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }], findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(moduleSummary: string) {
  const root = mkdtempSync(join(tmpdir(), "baked-ignorewhy-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, moduleSummary);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create the ignorewhy package with tests", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const snapshot = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  return { service, runId: run.runId, done, executor };
}

describe("scenario: ignorewhy 84f2692e, __init__.py named by a module path and no tests yet (#1031)", () => {
  test("a summary that mentions a module of the package opens no corrective task", async () => {
    const { service, runId, done, executor } = await runScenario("Created pkg/globs.py with the glob matcher.");
    expect(done.status).toBe("completed");
    expect(service.store.run(runId).corrective_tasks).toBe(0);
    expect(executor.implemented).toEqual(["T001", "T002", "T003"]);
    expect(service.store.latestArtifact(runId, "tasks/defects/T002.json")).toBeFalsy();
  });

  test("a test check that collects no test before the tests exist routes no defect", async () => {
    const { service, runId, done, executor } = await runScenario("Created pkg/globs.py; pkg/__init__.py should re-export match_glob, which T001 owns.");
    expect(done.status).toBe("completed");
    expect(service.store.run(runId).corrective_tasks).toBe(0);
    expect(executor.implemented).toEqual(["T001", "T002", "T003"]);
    const defects = service.store.latestArtifact(runId, "tasks/defects/T002.json");
    expect(defects).toBeTruthy();
    const record = JSON.parse(service.store.readArtifact(runId, defects?.id ?? "")) as { checks: { status: string }[]; findings: string[] };
    expect(record.checks.map((c) => c.status)).toEqual(["no_tests"]);
    expect(record.findings).toEqual([]);
  });
});

describe("namesPath and noTestsCollected (#1031)", () => {
  test("a package directory prefix does not name its __init__.py", () => {
    expect(namesPath("Created ignorewhy/globs.py", "ignorewhy/__init__.py")).toBe(false);
    expect(namesPath("see ignorewhy.globs for the matcher", "ignorewhy/__init__.py")).toBe(false);
    expect(namesPath("import ignorewhy fails", "ignorewhy/__init__.py")).toBe(true);
    expect(namesPath("the ignorewhy package.", "ignorewhy/__init__.py")).toBe(true);
    expect(namesPath("run python -m cfgtrace.__main__", "cfgtrace/__main__.py")).toBe(true);
    expect(namesPath("edit ignorewhy/__init__.py", "ignorewhy/__init__.py")).toBe(true);
  });

  test("runner output that collected no test", () => {
    expect(noTestsCollected("collected 0 items\n\n==== no tests ran in 0.01s ====")).toBe(true);
    expect(noTestsCollected("No tests found, exiting with code 1")).toBe(true);
    expect(noTestsCollected("No test files found, exiting with code 1")).toBe(true);
    expect(noTestsCollected("?   \texample.com/pkg\t[no test files]")).toBe(true);
    expect(noTestsCollected("FAILED tests/test_globs.py::test_star - AssertionError")).toBe(false);
  });
});
