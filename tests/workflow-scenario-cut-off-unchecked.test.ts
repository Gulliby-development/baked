import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { canonical, hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 33, md-site 11b11f19 (#1329). Corrective T013 was finalized by its
// token cap after 14 steps; its last edits (a regression test expecting `.md` where the spec says
// `.html`) came after its last request_check, and it submitted a complete result. The required
// test check failed after it, a sibling inherited the failing test, a corrective for the failure
// was stopped by the watcher, and the run blocked `no_progress`. A cut-off attempt's unchecked
// edits are now checked before its result is accepted, and a failure goes back to the same task.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Links", problem: "Links are wrong", outcome: "Links point at html pages", inScope: ["Render links"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Links point at html pages", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a link to a.md", when: "it renders", then: "it points at a.html", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne output file.\n## Decisions\nDEC-001: FR-001 renders html links.\n## Components\nout.txt\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const testsCheck: Check = { id: "tests", executable: "bun", args: ["-e", "const t = await Bun.file('out.txt').text(); if (!t.includes('a.html')) { console.log('(fail) link points at html: expected a.html, received ' + t.trim()); process.exit(1) }"], cwd: ".", timeoutMs: 10000, required: true, scope: "task", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [testsCheck, { ...testsCheck, id: "suite", scope: "feature" }] };

interface Behavior {
  /** How the first attempt ended. */
  finalizedBy: "tokens" | "steps" | "watcher" | null;
  /** The first attempt's step tools; a request_check after its last edit means it checked them. */
  tools: string[][];
}

class ScriptedExecutor implements AgentExecutor {
  implementations: { cutOffChecks?: { failed: { id: string; output: string }[] }; maxTokens: number }[] = [];
  service?: NativeWorkflowService;
  constructor(
    private root: string,
    private behavior: Behavior,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[]; cutOffChecks?: { failed: { id: string; output: string }[] } } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["out.txt"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Render links", description: "Write out.txt", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "out.txt", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const first = this.implementations.length === 0;
        this.implementations.push({ ...(data.extra.cutOffChecks ? { cutOffChecks: data.extra.cutOffChecks } : {}), maxTokens: request.attemptTokens ?? 0 });
        // The cut-off attempt leaves a link to the markdown file; the next one fixes it.
        writeFileSync(join(this.root, "out.txt"), first ? "link a.md\n" : "link a.html\n");
        if (first)
          this.service?.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical({ schemaVersion: 1, profileId: request.profile.id, taskId: request.task?.id ?? null, maxSteps: request.maxSteps, maxTokens: 1000, stopReason: "submitted", finalizedBy: this.behavior.finalizedBy, totalTokens: 1000, steps: this.behavior.tools.map((tools) => ({ inputTokens: 50, outputTokens: 50, cacheReadTokens: null, toolCalls: tools.length, tools, compactedBytes: 0 })) }));
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote out.txt", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": {
        const html = readFileSync(join(this.root, "out.txt"), "utf8").includes("a.html");
        output = html
          ? { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "Checks pass" }], findings: [] }
          : { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [], findings: [{ id: "F001", kind: "correctness", severity: "medium", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "out.txt", symbol: null, evidenceIds: evidence, claim: "The link points at the markdown file", impact: "The page link is broken", suggestedFix: "Point at a.html" }] };
        break;
      }
      case "refutation": output = { schemaVersion: 1, findingId: "F001", decision: "confirmed", evidenceIds: evidence, explanation: "Seen" }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(behavior: Behavior) {
  const root = mkdtempSync(join(tmpdir(), "baked-cutoff-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, behavior);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  executor.service = service;
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "standard", prompt: "Render html links", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const waiting = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  const errors = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/"));
  const lastError = errors.length ? service.store.readArtifact(run.runId, errors.at(-1)?.id ?? "") : "";
  const state = service.store.state(run.runId);
  return { done, state, executor, root, lastError, correctives: (state.graph?.tasks ?? []).filter((t) => t.origin !== "planned") };
}

const editedAfterCheck = [["read"], ["edit_file"], ["request_check"], ["multi_edit"], ["submit_result"]];

describe("scenario: md-site 11b11f19, a corrective cut off after edits it did not check (#1329)", () => {
  test("its failing required check goes back to the same task with the output, not to a new corrective", async () => {
    const { done, state, executor, root, lastError, correctives } = await runScenario({ finalizedBy: "tokens", tools: editedAfterCheck });
    expect(lastError).toBe("");
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("link a.html\n");
    expect(executor.implementations).toHaveLength(2);
    expect(executor.implementations[1]?.cutOffChecks?.failed.map((f) => f.id)).toEqual(["tests"]);
    expect(executor.implementations[1]?.cutOffChecks?.failed[0]?.output).toContain("expected a.html, received link a.md");
    expect(executor.implementations[1]?.maxTokens).toBe(1500);
    expect(state.taskContinuations).toEqual({ T001: 1 });
    expect(correctives).toEqual([]);
  }, 60000);

  test("an attempt the watcher stopped is checked the same way", async () => {
    const { done, executor, correctives } = await runScenario({ finalizedBy: "watcher", tools: editedAfterCheck });
    expect(done.status).toBe("completed");
    expect(executor.implementations[1]?.cutOffChecks?.failed.map((f) => f.id)).toEqual(["tests"]);
    expect(correctives).toEqual([]);
  }, 60000);

  test("an attempt that checked its last edit, or was not cut off, keeps the usual corrective path", async () => {
    for (const behavior of [
      { finalizedBy: "tokens" as const, tools: [["edit_file"], ["request_check"], ["submit_result"]] },
      { finalizedBy: null, tools: editedAfterCheck },
    ]) {
      const { executor, state } = await runScenario(behavior);
      expect(executor.implementations[1]?.cutOffChecks).toBeUndefined();
      expect(state.taskContinuations).toEqual({});
    }
  }, 120000);
});
