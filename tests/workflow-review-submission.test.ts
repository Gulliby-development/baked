import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { resolveEvidenceId } from "../src/core/verification/evidence.js";
import { capturePreImage } from "../src/core/workflows/rollback.js";
import { buildReviewBundle, taskChangedFiles } from "../src/core/workflows/review-bundle.js";
import { completeReview, reviewProblems } from "../src/core/verification/review.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Review, RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

const criterion = (id: string) => ({ id, requirementIds: ["FR-001"], given: "a workspace", when: "the task completes", then: "value is ready", method: "automated" as const });
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Fixture", problem: "Missing value", outcome: "Value exists", inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Value is ready", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [criterion("AC-001"), criterion("AC-002"), criterion("AC-003")], dependencies: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "if (await Bun.file('value.txt').text() !== 'ready') process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
const HASH = "a".repeat(64);

const review = (overrides: Partial<Review>): Review => ({ schemaVersion: 1, snapshotHash: "0".repeat(64), verdict: "pass", coverage: [], findings: [], ...overrides });

/** A store with a run and three pieces of current evidence on one snapshot. */
async function evidenceFixture() {
  const root = mkdtempSync(join(tmpdir(), "baked-review-submission-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, { execute: async () => { throw new Error("unused"); } });
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
  const snapshot = service.store.putSnapshot(run.runId, {});
  const ids = ["first", "second", "third"].map((name) => {
    const artifact = service.store.artifact(run.runId, "review", `${name}.json`, name);
    return service.store.addEvidence(run.runId, "diff", snapshot.id, artifact.id);
  });
  return { store: service.store, runId: run.runId, snapshotId: snapshot.id, ids };
}

describe("host-filled review submission", () => {
  test("the host sets the snapshot hash and resolves handles and mistyped ids", async () => {
    const { store, runId, snapshotId, ids } = await evidenceFixture();
    const real = ids[1] ?? "";
    // The md-site B shape: a real id whose tail lost characters.
    const mangled = `${real.slice(0, 24)}${real.slice(26)}`;
    const result = review({
      coverage: [
        { criterionId: "AC-001", verdict: "pass", evidenceIds: ["E1", mangled, real], explanation: "ok" },
        { criterionId: "AC-002", verdict: "pass", evidenceIds: [ids[2]?.slice(0, 12) ?? ""], explanation: "ok" },
      ],
    });
    expect(reviewProblems(store, runId, snapshotId, HASH, spec, result)).toEqual([]);
    expect(result.snapshotHash).toBe(HASH);
    expect(result.coverage[0]?.evidenceIds).toEqual([ids[0], real]);
    expect(result.coverage[1]?.evidenceIds).toEqual([ids[2]]);
  });
  test("a partial pass lists the omitted criteria as inconclusive instead of failing", async () => {
    const { store, runId, snapshotId, ids } = await evidenceFixture();
    const result = review({ coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: [ids[0] ?? ""], explanation: "ok" }] });
    expect(reviewProblems(store, runId, snapshotId, HASH, spec, result)).toEqual([]);
    expect(result.coverage.map((c) => `${c.criterionId}:${c.verdict}`)).toEqual(["AC-001:pass", "AC-002:inconclusive", "AC-003:inconclusive"]);
    completeReview(store, runId, snapshotId, HASH, spec, result);
    expect(result.coverage).toHaveLength(3);
  });
  test("manual criteria are deferred and do not make a required review inconclusive", async () => {
    const { store, runId, snapshotId, ids } = await evidenceFixture();
    const manual = (id: string) => ({ ...criterion(id), method: "manual" as const });
    const withManual: Spec = { ...spec, criteria: [criterion("AC-001"), manual("AC-005"), manual("AC-007")] };
    // The jsondelta shape: the other criteria pass with citations, the manual ones are inconclusive.
    const result = review({
      verdict: "inconclusive",
      coverage: [
        { criterionId: "AC-001", verdict: "pass", evidenceIds: [ids[0] ?? ""], explanation: "ok" },
        { criterionId: "AC-005", verdict: "inconclusive", evidenceIds: [], explanation: "No evidence yet" },
      ],
    });
    expect(reviewProblems(store, runId, snapshotId, HASH, withManual, result)).toEqual([]);
    expect(result.verdict).toBe("pass");
    expect(result.coverage.map((c) => `${c.criterionId}:${c.verdict}`)).toEqual(["AC-001:pass", "AC-005:deferred", "AC-007:deferred"]);
    // An automated criterion left inconclusive still keeps the verdict inconclusive.
    const open = review({ verdict: "inconclusive", coverage: [{ criterionId: "AC-005", verdict: "inconclusive", evidenceIds: [], explanation: "x" }] });
    reviewProblems(store, runId, snapshotId, HASH, withManual, open);
    expect(open.verdict).toBe("inconclusive");
  });
  test("an unknown id is rejected with the message and the valid ids", async () => {
    const { store, runId, snapshotId, ids } = await evidenceFixture();
    const result = review({ coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: ["feedface-0000-4000-8000-000000000000"], explanation: "ok" }] });
    const [message] = reviewProblems(store, runId, snapshotId, HASH, spec, result);
    expect(message).toContain("Unknown or stale evidence feedface-0000-4000-8000-000000000000");
    expect(message).toContain(`E1=${ids[0]}`);
    expect(message).toContain(`E3=${ids[2]}`);
  });
  test("an ambiguous or short reference is left for the validator to reject", async () => {
    const { store, runId, snapshotId } = await evidenceFixture();
    const current = store.evidence(runId).filter((e) => e.snapshot_id === snapshotId);
    expect(resolveEvidenceId(current, "E9")).toBe("E9");
    expect(resolveEvidenceId(current, "abc")).toBe("abc");
    expect(resolveEvidenceId(current, current[0]?.id ?? "")).toBe(current[0]?.id ?? "");
  });
});

const markdown = "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\ncheck\n## Risks\nNone for fixture";
const single: Spec = { ...spec, criteria: [criterion("AC-001")] };

/** An agent that gets the hash and the evidence ids wrong the way the bench runs did. */
class CarelessReviewer implements AgentExecutor {
  hints: (string | undefined)[] = [];
  reviews = 0;
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; extra: { evidence?: { id: string; handle: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] }; break;
      case "spec": output = single; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(single), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Create value", description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": writeFileSync(join(this.root, "value.txt"), "ready"); output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] }; break;
      case "review":
      case "convergence": {
        this.hints.push(request.formatHints);
        if (request.profile.output === "review") this.reviews++;
        // A wrong 64-hex hash and handles instead of ids; the host fixes both.
        output = { schemaVersion: 1, snapshotHash: "0".repeat(64), verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: (data.extra.evidence ?? []).map((e) => e.handle), explanation: "Checked" }], findings: [] };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    const errors = request.validate?.(output) ?? [];
    if (errors.length) throw new Error(`validate rejected: ${errors.join("; ")}`);
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("review stage", () => {
  test("a review with a wrong hash and handle citations is accepted and the run completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-review-run-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new CarelessReviewer(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const request = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    const current = await service.get(run.runId);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: current.revision }, { kind: "approve", requestId: request?.id ?? "", digest: request?.digest ?? "" });
    const finished = await service.drive(run.runId, new AbortController().signal);
    expect(finished.reason).not.toBe("invalid_output");
    expect((await service.get(run.runId)).status).toBe("completed");
    expect(executor.reviews).toBeGreaterThan(0);
    // The format correction of a review is told the hash and the citable ids.
    const hint = executor.hints.find((h) => h !== undefined) ?? "";
    expect(hint).toMatch(/snapshotHash is [a-f0-9]{64}\./);
    expect(hint).toContain("E1=");
  });
});

describe("review bundle", () => {
  test("one patch covers every file the run edited, including earlier tasks", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-review-bundle-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, { execute: async () => { throw new Error("unused"); } });
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    service.leases.acquire("mutation", run.runId);
    // Two tasks (two steps) edit two files; only the second task's diff would be current at review.
    writeFileSync(join(root, "a.txt"), "old a\n");
    for (const [name, text, task] of [["a.txt", "new a\n", "task-T001"], ["b.txt", "created b\n", "task-T002"]] as const) {
      const step = service.store.beginStep(run.runId, task);
      const attempt = service.store.reserve(run.runId, step, null, 0, policy);
      const before = service.store.transaction(() => capturePreImage(service.store, run.runId, join(root, name)));
      service.scheduler.journal.publish(run.runId, attempt, name, text, before, "file_patch");
    }
    const bundle = await buildReviewBundle(service.store, run.runId, root);
    expect(bundle.changed).toEqual(["a.txt", "b.txt"]);
    expect(bundle.patch).toContain("-old a");
    expect(bundle.patch).toContain("+new a");
    expect(bundle.patch).toContain("+created b");
    expect(bundle.patch).toContain("--- /dev/null");
    // Each task's changed files; a task that changed nothing is left out.
    const tasks = [
      { id: "T001", writes: [{ path: "a.txt" }, { path: "c.txt" }] },
      { id: "T002", writes: [{ path: "b.txt" }] },
      { id: "T003", writes: [{ path: "d.txt" }] },
    ];
    expect(taskChangedFiles(tasks, bundle.changed)).toEqual({ T001: ["a.txt"], T002: ["b.txt"] });
  });
});
