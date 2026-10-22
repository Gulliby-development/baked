import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Smoke 2026-10-22, rpn 09a1c786 (#1913). The required check `ruff check src tests` runs in an
// empty repository; T001 writes `src/rpn/core.py`, T002 (depending on T001) writes
// `tests/test_core.py`. After T001 ruff fails with E902 on the missing `tests` folder only. Before
// the fix no task owned that failure and it was not the baseline's, so T001 blocked, correctives
// targeted its files and the run stopped `invalid_output` at 482k tokens.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "RPN", problem: "No calculator", outcome: "A calculator", inScope: ["Create the package"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Evaluates RPN", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the checks run", then: "they pass", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA package and its tests.\n## Decisions\nDEC-001: FR-001 is tested last.\n## Components\nsrc/rpn/core.py, tests/test_core.py\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
// A stand-in for `ruff check src tests`: E902 for each folder that does not exist. With `first`,
// it stops at the first missing folder, so its baseline (only `src`) differs from the failure
// after T001 (only `tests`) and only the owner rule can excuse it.
const ruff = (first = false): Check => ({
  id: "lint",
  executable: "bun",
  args: [
    "-e",
    `const { existsSync } = await import("node:fs"); let n = 0; for (const p of ["src", "tests"]) { if (existsSync(p)) continue; n++; console.log("E902 No such file or directory (os error 2)\\n --> " + p + ":1:1\\n"); if (${first}) break; } if (n) { console.log("Found " + n + " error" + (n > 1 ? "s" : "") + "."); process.exit(1) } console.log("All checks passed!")`,
  ],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "feature",
  envNames: [],
  writes: [],
});
const planned = (id: string, path: string, dependsOn: string[] = []): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });

class ScriptedExecutor implements AgentExecutor {
  implemented: string[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "An empty workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned("T001", "src/rpn/core.py"), planned("T002", "tests/test_core.py", ["T001"])] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        this.implemented.push(task?.id ?? "");
        for (const write of task?.writes ?? []) {
          mkdirSync(dirname(join(this.root, write.path)), { recursive: true });
          writeFileSync(join(this.root, write.path), "x = 1\n");
        }
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: `Created ${task?.writes[0]?.path}`, evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }], findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(check: Check) {
  const root = mkdtempSync(join(tmpdir(), "baked-rpn-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [check] };
  const executor = new ScriptedExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create the rpn package with tests", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const snapshot = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  return { service, runId: run.runId, done, executor };
}

describe("scenario: rpn 09a1c786, a required check names a folder a later task creates (#1913)", () => {
  test("ruff's E902 on tests/ after T001 is left to T002 and the run completes", async () => {
    const { service, runId, done, executor } = await runScenario(ruff(true));
    expect(done.status).toBe("completed");
    expect(service.store.run(runId).corrective_tasks).toBe(0);
    expect(executor.implemented).toEqual(["T001", "T002"]);
    const handoff = service.store.latestArtifact(runId, "tasks/handoffs/T001.json");
    expect(JSON.parse(service.store.readArtifact(runId, handoff?.id ?? "")).owners).toEqual(["T002"]);
  });

  test("a failure that keeps only some of the baseline's E902 errors is the baseline's", async () => {
    const { service, runId, done, executor } = await runScenario(ruff());
    expect(done.status).toBe("completed");
    expect(service.store.run(runId).corrective_tasks).toBe(0);
    expect(executor.implemented).toEqual(["T001", "T002"]);
  });
});
