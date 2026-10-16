import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { runRepro, shadowedPath } from "../src/core/verification/repro.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import type { Check, Repro, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 35, narrowfit 3c2e3629 (#1348). The correctness review raised F1 on
// internal/constraint/sum.go with a repro that ran `go run {files}/sum.go ...`: a pasted copy of
// buildSum. The corrective fixed the real file, the copy kept printing the old value after every
// attempt, and the run ended invalid_output; two resumes and an extension repeated the same stop
// until a replan (1.25M tokens, 4 operator commands).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const BUGGY = [
  "export function buildSum(words: string[]): string {",
  '  const canonical = words.join(" ");',
  "  return canonical; // the sum keyword is missing",
  "}",
  'console.log(buildSum(["b", "==", "0"]));',
  "",
].join("\n");
const FIXED = BUGGY.replace("return canonical;", 'return "sum " + canonical;');

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Sum", problem: "A sum constraint prints without its keyword", outcome: "The canonical text of a sum starts with sum", inScope: ["sum.ts"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The canonical text of a sum starts with the sum keyword", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a sum of b", when: "it is printed", then: "it reads sum b == 0", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne file.\n## Decisions\nDEC-001: FR-001 in sum.ts.\n## Components\nsum.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "const t = await Bun.file('sum.ts').text(); if (!t.includes('buildSum')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [check] };
const planned: Task = { id: "T001", title: "Write sum.ts", description: "Write sum.ts", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "sum.ts", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };
// The reviewer's repro runs a copy of sum.ts as it was at review time, like narrowfit's sum.go.
const shadow: Repro = { executable: "bun", args: ["{files}/sum.ts"], expected: "sum b == 0", actual: "b == 0", files: [{ name: "sum.ts", content: BUGGY }] };

class ScriptedExecutor implements AgentExecutor {
  /** The host's verdicts a corrective worker saw, one per attempt. */
  verdicts: string[][] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["sum.ts"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        if (task?.origin !== "planned") {
          // The worker fixes the real file, then the host reruns the repro, as after each attempt.
          writeFileSync(join(this.root, "sum.ts"), FIXED);
          this.verdicts.push((await request.reproCheck?.(this.root, request.signal)) ?? []);
        } else writeFileSync(join(this.root, "sum.ts"), BUGGY);
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Wrote sum.ts", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = pass; break;
      case "convergence": {
        if (readFileSync(join(this.root, "sum.ts"), "utf8").includes('"sum "')) {
          output = pass;
          break;
        }
        const finding = { id: "F1", kind: "correctness", severity: "medium", basis: "spec", confidence: 1, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "sum.ts", symbol: "buildSum", evidenceIds, claim: "The canonical text of a sum omits the sum keyword", impact: "Printed sums do not parse back", suggestedFix: "Prefix the words with sum", repro: shadow };
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: "The keyword is missing" }], findings: [finding] };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: narrowfit 3c2e3629, a repro that runs a copy of the file under test (#1348)", () => {
  test("the copy does not gate a correction, so no corrective is held by a result its fix cannot change", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-narrowfit-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Print sums with their keyword", ownerLabel: "test", policy });
    await service.drive(started.runId, new AbortController().signal);
    const snapshot = await service.get(started.runId);
    const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(started.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    // No corrective attempt was started on the copy's word, so none could be held by it.
    expect(executor.verdicts).toEqual([]);
    const outcomes = service.store
      .artifacts(started.runId)
      .filter((a) => a.logical_path.startsWith("convergence/repro-"))
      .map((a) => service.store.readArtifact(started.runId, a.id));
    expect(outcomes.join("\n")).toContain("is a copy of sum.ts");
  });
});

describe("a repro input file that copies a workspace file", () => {
  const options = (root: string, shadows: string[]) => ({ root, executables: ["bun"], generated: [], signal: new AbortController().signal, sandbox: null, shadows });

  test("is inconclusive without running, and names the file and what to run instead", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-shadow-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    // The workspace holds the fixed file; the copy still prints the old value.
    writeFileSync(join(root, "sum.ts"), FIXED);
    const outcome = await runRepro(new ProcessScope(), shadow, options(root, ["sum.ts"]));
    expect(outcome.status).toBe("inconclusive");
    expect(outcome.reason).toContain("Input file sum.ts is a copy of sum.ts");
    expect(outcome.reason).toContain("workspace's own code");
    // Without the paths a fix may change, the same repro reproduces from its copy.
    expect((await runRepro(new ProcessScope(), shadow, options(root, []))).status).toBe("reproduced");
  });

  test("a probe of its own with the same name that only calls the workspace code is not a copy", () => {
    const workspace = new Map([["src/sum.ts", FIXED]]);
    const probe = { name: "sum.ts", content: 'import { buildSum } from "../src/sum.ts";\nconsole.log(buildSum(["b"]));\n' };
    expect(shadowedPath(probe, workspace)).toBeNull();
    expect(shadowedPath({ name: "sum.ts", content: BUGGY }, workspace)).toBe("src/sum.ts");
    // An input file with another name is data, whatever it holds.
    expect(shadowedPath({ name: "input.txt", content: BUGGY }, workspace)).toBeNull();
  });
});
