import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { QUICK_FIX_TOKENS, quickFixLimits } from "../src/core/workflows/scheduler.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId, type WorkflowStore } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest, RuntimeState } from "../src/core/workflows/types.js";

// Bench rounds 17 to 24 (#1001): a one-function finding (url-shortener f8c51340 T006, a Unicode
// path in a Location header: 263k; expenses-py 4b13ba94 T009, a wrong CSV line number: 948k)
// started a corrective task at the cap of the task it corrected. With the policy's `quickFix` the
// first attempt of such a correction runs under small caps; a failed one falls back to the full
// correction with its edits. A finding that points at more than one source file, a high one, or a
// run without the setting gets the full correction as before.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Location header", problem: "Redirects lose Unicode paths", outcome: "Redirects keep Unicode paths", inScope: ["Encode the Location header"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The Location header encodes the path", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a Unicode path", when: "the server redirects", then: "the Location header is encoded", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne module.\n## Decisions\nDEC-001: FR-001 is one function.\n## Components\nsrc/redirect.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "await Bun.file('src/redirect.ts').text()"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const planned: Task = { id: "T001", title: "Write the redirect", description: "Write src/redirect.ts and README.md", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/redirect.ts", action: "create" }, { path: "README.md", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };

type Attempt = { taskId: string; maxSteps: number; maxTokens: number | undefined; quick: boolean; writes: string[] };

class ScriptedExecutor implements AgentExecutor {
  attempts: Attempt[] = [];
  constructor(
    private root: string,
    private wide: boolean,
    private quickFails: boolean,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { dimension?: string; evidence?: { id: string }[]; quickFix?: unknown } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/redirect.ts"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        const quick = data.extra.quickFix !== undefined;
        if (task?.origin !== "planned") this.attempts.push({ taskId: task?.id ?? "", maxSteps: request.maxSteps, maxTokens: request.maxTokens, quick, writes: task?.writes.map((w) => w.path) ?? [] });
        if (task?.origin === "planned") {
          mkdirSync(join(this.root, "src"), { recursive: true });
          writeFileSync(join(this.root, "src/redirect.ts"), "export const location = (path: string) => path;\n");
          writeFileSync(join(this.root, "README.md"), "# Redirect\n");
        } else if (quick && this.quickFails) {
          output = { schemaVersion: 1, taskId: task?.id, outcome: "blocked", summary: "The fix needs the README too", evidenceIds: [], unresolved: ["README.md must document the encoding"] };
          break;
        } else writeFileSync(join(this.root, "src/redirect.ts"), "export const location = (path: string) => encodeURI(path);\n");
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Wrote src/redirect.ts", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": {
        const encoded = readFileSync(join(this.root, "src/redirect.ts"), "utf8").includes("encodeURI");
        if (data.extra.dimension !== "correctness" || encoded) { output = pass; break; }
        const finding = { id: "F001", kind: "contradicts", severity: "medium", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "src/redirect.ts", symbol: "location", evidenceIds, claim: "location returns a Unicode path unencoded", impact: "The Location header is invalid", suggestedFix: this.wide ? "Encode the path with encodeURI and document it in README.md" : "Encode the path with encodeURI" };
        output = { ...pass, findings: [finding] };
        break;
      }
      case "convergence": output = pass; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function run(policy: RunPolicy, wide = false, quickFails = false) {
  const root = mkdtempSync(join(tmpdir(), "baked-quick-fix-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, wide, quickFails);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Encode the Location header", ownerLabel: "test", policy });
  await service.drive(started.runId, new AbortController().signal);
  const snapshot = await service.get(started.runId);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  const causes = service.store
    .events(started.runId)
    .filter((e) => e.type === "task.state_changed")
    .map((e) => (e.payload as { cause?: string }).cause)
    .filter(Boolean);
  return { done, executor, causes };
}

const policy = (quickFix?: RunPolicy["quickFix"]): RunPolicy => ({ ...defaultWorkflowPolicy, checks: [check], ...(quickFix ? { quickFix } : {}) });

describe("quick-fix attempts for small corrections (#1001)", () => {
  test("a medium one-file finding is fixed by a quick attempt under the small caps", async () => {
    const { done, executor } = await run(policy({}));
    expect(done.status).toBe("completed");
    expect(executor.attempts).toHaveLength(1);
    expect(executor.attempts[0]).toMatchObject({ quick: true, maxTokens: QUICK_FIX_TOKENS, writes: ["src/redirect.ts"] });
    expect(executor.attempts[0]?.maxSteps).toBeLessThanOrEqual(16);
  });

  test("the policy sets the caps", async () => {
    const { executor } = await run(policy({ attemptTokens: 60_000, maxSteps: 8 }));
    expect(executor.attempts[0]).toMatchObject({ quick: true, maxTokens: 60_000, maxSteps: 8 });
  });

  test("a failed quick attempt falls back to the full correction", async () => {
    const { done, executor, causes } = await run(policy({}), false, true);
    expect(done.status).toBe("completed");
    expect(executor.attempts.map((a) => a.quick)).toEqual([true, false]);
    expect(executor.attempts[1]?.maxTokens).toBeUndefined();
    expect(executor.attempts[1]?.writes).toEqual(["src/redirect.ts", "README.md"]);
    expect(causes).toContain("quick_fix_fallback");
  });

  test("a finding that points at two source files gets the full correction", async () => {
    const { done, executor } = await run(policy({}), true);
    expect(done.status).toBe("completed");
    expect(executor.attempts.map((a) => [a.quick, a.maxTokens])).toEqual([[false, undefined]]);
  });

  test("without the setting a correction runs as before", async () => {
    const { done, executor } = await run(policy());
    expect(done.status).toBe("completed");
    expect(executor.attempts.map((a) => [a.quick, a.maxTokens])).toEqual([[false, undefined]]);
  });

  test("only low and medium findings of one source file qualify", () => {
    const correction: Task = { ...planned, id: "T002", origin: "repair", findingIds: ["F001"] };
    const state = { quickFixFallbacks: [], widenedCorrections: [], taskSteps: {}, repairPredecessors: {} } as unknown as RuntimeState;
    const store = (severity: string) => ({ findings: () => [{ id: "F001", body_json: JSON.stringify({ severity }) }] }) as unknown as WorkflowStore;
    const limits = (severity: string, focus: string[], quickFix: RunPolicy["quickFix"] = {}) => quickFixLimits(store(severity), "run", state, policy(quickFix), correction, focus);
    expect(limits("low", ["src/redirect.ts", "tests/redirect.test.ts"])).toEqual({ maxSteps: 16, maxTokens: QUICK_FIX_TOKENS });
    expect(limits("high", ["src/redirect.ts"])).toBeNull();
    expect(limits("medium", ["src/redirect.ts", "README.md"])).toBeNull();
    expect(limits("medium", [])).toBeNull();
    expect(quickFixLimits(store("low"), "run", state, policy(), correction, ["src/redirect.ts"])).toBeNull();
  });
});
