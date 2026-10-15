import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { sweepClass, sweepTestFiles } from "../src/core/verification/class-sweep.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 25, aclvet 5684de0e (#1191). The convergence finds that a performance
// test builds its rules with a loop instead of static fixtures, and its correction fixes that one
// test file; the next pass finds the same in the sibling test file (641k tokens). With
// `classSweep` the corrective of a test-style finding may write every planned test file of its
// kind in the same directory and is told to check each one, so one task covers both.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const CHECK = "acl/check_test.go";
const DIFF = "acl/diff_test.go";
const SOURCE = "acl/check.go";
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "ACL checker", problem: "Rule sets are hard to check", outcome: "Checks are tested with static fixtures", inScope: ["Check rule sets"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Rule sets are checked against static fixtures", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "150 TCP and UDP rules", when: "they are checked", then: "the result matches the fixture", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA checker and its tests.\n## Decisions\nDEC-001: FR-001 with fixtures.\n## Components\nacl/check.go, acl/check_test.go, acl/diff_test.go\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const tests: Check = { id: "tests", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const planned = (id: string, path: string): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });

class ScriptedExecutor implements AgentExecutor {
  corrections: Task[] = [];
  constructor(private root: string) {}
  private looped(path: string): boolean {
    return readFileSync(join(this.root, path), "utf8").includes("loop");
  }
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[]; finding?: { id: string } } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: [SOURCE] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned("T001", SOURCE), planned("T002", CHECK), planned("T003", DIFF)] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task as Task;
        if (task.origin === "planned") {
          mkdirSync(join(this.root, "acl"), { recursive: true });
          const path = task.writes[0]?.path ?? "";
          writeFileSync(join(this.root, path), path === SOURCE ? "checker\n" : "rules built in a loop, TCP only\n");
        } else {
          // A corrective fixes the test file its finding names, and with a class sweep every test
          // file the host lists, as long as the task may write it.
          this.corrections.push(task);
          const sweep = task.description.includes("Class sweep");
          for (const path of [CHECK, DIFF])
            if ((sweep || task.description.includes(path)) && task.writes.some((w) => w.path === path))
              writeFileSync(join(this.root, path), "static TCP and UDP fixtures\n");
        }
        output = { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence": {
        const file = [CHECK, DIFF].find((path) => this.looped(path));
        const coverage = [{ criterionId: "AC-001", verdict: file ? "fail" : "pass", evidenceIds: evidence, explanation: file ? "Fixtures are generated" : "Checks pass" }];
        output = file
          ? { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage, findings: [{ id: "F001", kind: "partial", severity: "medium", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file, symbol: null, evidenceIds: evidence, claim: `The tests in ${file} build their 150 rules with arithmetic loops, not static example fixtures, and cover TCP only`, impact: "AC-001 names intersecting TCP and UDP ranges and the brief bans generators", suggestedFix: "Replace the loops with static fixtures that include UDP", noRepro: "A test-style finding: nothing to run" }] }
          : { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage, findings: [] };
        break;
      }
      case "refutation": output = { schemaVersion: 1, findingId: data.extra.finding?.id, decision: "confirmed", evidenceIds: evidence, explanation: "The file shows it" }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(classSweep: boolean) {
  const root = mkdtempSync(join(tmpdir(), "baked-aclvet-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 1, maxConvergenceRounds: 1, checks: [tests], ...(classSweep ? { classSweep } : {}) };
  const executor = new ScriptedExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "standard", prompt: "Check rule sets", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const waiting = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  return { done, executor, root };
}

describe("scenario: aclvet 5684de0e, one test-style defect found one test file per pass (#1191)", () => {
  test("with classSweep the corrective sweeps the sibling test files and the run completes", async () => {
    const { done, executor, root } = await runScenario(true);
    expect(done.status).toBe("completed");
    expect(executor.corrections).toHaveLength(1);
    const [sweep] = executor.corrections;
    expect(sweep?.description).toContain("Class sweep");
    expect(sweep?.description).toContain(`- ${DIFF}`);
    expect(sweep?.writes.map((w) => w.path)).toContain(DIFF);
    expect(readFileSync(join(root, DIFF), "utf8")).toBe("static TCP and UDP fixtures\n");
  }, 60000);

  test("without it the corrective fixes one test file and the sibling keeps the defect", async () => {
    const { done, executor, root } = await runScenario(false);
    expect(executor.corrections[0]?.description).not.toContain("Class sweep");
    expect(readFileSync(join(root, CHECK), "utf8")).toBe("static TCP and UDP fixtures\n");
    // The sibling keeps the defect: the one review round is spent, and the run ends with it as a
    // known limitation.
    expect(readFileSync(join(root, DIFF), "utf8")).toContain("loop");
    expect(done.status).toBe("completed");
  }, 60000);

  test("a test-style finding is recognised only on a test file, after the robustness class", () => {
    const finding = (file: string, claim: string) => ({ file, claim, impact: "", repro: undefined });
    expect(sweepClass(finding(CHECK, "The tests build their rules with arithmetic loops"))).toBe("tests");
    expect(sweepClass(finding(CHECK, "The CLI tests omit cases the criteria name with exact stdout"))).toBe("tests");
    expect(sweepClass(finding(SOURCE, "The checker builds its rules with arithmetic loops"))).toBeNull();
    expect(sweepClass(finding(CHECK, "Deeply nested rules raise RecursionError"))).toBe("robustness");
  });

  test("the sibling test files are those of the same kind in the same directory", () => {
    const root = { tasks: [planned("T001", SOURCE), planned("T002", CHECK), planned("T003", DIFF), planned("T004", "cmd/main_test.go"), planned("T005", "acl/testdata_test.py")] };
    expect(sweepTestFiles([{ file: DIFF }], root, "implementer")).toEqual([DIFF, CHECK]);
  });
});
