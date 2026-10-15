import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  advisorySizeTarget,
  type Check,
  type RunPolicy,
  type Spec,
  type Task,
} from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 30 (#1282). ecfit 25614519: the brief asked for source files "below
// about 400 lines". T003 wrote glob.go at 543 lines, its checks passed, and it submitted
// implemented with that miss as its only unresolved item. The host counted it unfinished and
// restarted the task, the restart came back blocked on "Reduce glob.go to about 400 lines", and
// the run needed two resumes (2.4M tokens). Here the first attempt reports the same miss and the
// restart would block the same way.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const MISS = "src/glob.ts is 543 lines, exceeding the requested approximate 400-line file-size target";
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Glob", problem: "No glob matching", outcome: "Glob matching", inScope: ["Glob"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Globs match paths", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a glob", when: "it is matched", then: "matching paths match", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne module.\n## Decisions\nDEC-001: FR-001 matches globs.\n## Components\nsrc/glob.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const tasks: Task[] = [{ id: "T001", title: "Implement glob matching", description: "Write src/glob.ts", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/glob.ts", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }];
const tests: Check = { id: "tests", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 30000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [tests] };

class ScriptedExecutor implements AgentExecutor {
  attempts: string[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/glob.ts"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const id = request.task?.id ?? "";
        this.attempts.push(id);
        if (this.attempts.length > 1) {
          // The restart of ecfit T003: blocked on a line count it cannot measure.
          output = { schemaVersion: 1, taskId: id, outcome: "blocked", summary: "The file is still too long", evidenceIds: [], unresolved: ["Reduce src/glob.ts to about 400 lines without changing its matching behavior."] };
          break;
        }
        mkdirSync(join(this.root, "src"), { recursive: true });
        writeFileSync(join(this.root, "src/glob.ts"), "export const match = (glob: string, path: string) => glob === path;\n");
        output = { schemaVersion: 1, taskId: id, outcome: "implemented", summary: "Implemented glob matching", evidenceIds: [], unresolved: [MISS] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "The checks pass" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: ecfit 25614519, an approximate size target in the brief (#1282)", () => {
  test("a missed size target is a note, not an unfinished task", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-size-target-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Add glob matching; keep source files below about 400 lines", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const waiting = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(executor.attempts).toEqual(["T001"]);
    const note = service.store.artifacts(run.runId).find((a) => a.logical_path === "tasks/size-targets/T001.json");
    expect(JSON.parse(service.store.readArtifact(run.runId, note?.id ?? ""))).toEqual({ taskId: "T001", advisory: [MISS] });
  }, 90000);
});

describe("an unresolved item", () => {
  test("is a size target only when it reports a length against a soft target", () => {
    expect(advisorySizeTarget(MISS)).toBe(true);
    expect(advisorySizeTarget("internal/config/glob.go is 433 lines, above the ~400 line guideline")).toBe(true);
    expect(advisorySizeTarget("tests/test_errors.py is 306 lines against the 300-line target")).toBe(true);
    expect(advisorySizeTarget("glob.go is 543 lines and the ** pattern still fails")).toBe(false);
    expect(advisorySizeTarget("Negated patterns are not implemented")).toBe(false);
    expect(advisorySizeTarget("The parser reads about 400 lines of input per call")).toBe(false);
  });
});
