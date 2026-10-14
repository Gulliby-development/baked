import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, Review, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { runReport } from "../src/core/workflows/run-report.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { specAmendmentOf } from "../src/core/workflows/spec-amendment.js";
import { newId } from "../src/core/workflows/store.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 19, pngvet a2da6c24 (#1034). The request says "no random generators:
// plain example-based tests", the approved AC-001 still asks for generated cases with a fixed seed,
// and the test task wrote them with a random generator. The review finding R001 (contradicts)
// says to remove the generated cases from AC-001 and the plan. Its correction can only change the
// tests, and replaced the four generated tests with three examples. The test-integrity guard read
// that as a dropped test and its correction restored the generated cases, which the review raised
// again, until the run ended no_progress after 1.19M tokens of correctives.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const request = "Write a PNG chunk stripper. No random generators: plain example-based tests.";
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "PNG stripper", problem: "PNG files carry metadata", outcome: "Chunks are stripped", inScope: ["Strip chunks"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Ancillary chunks are stripped", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "100 generated deterministic byte-array cases with a fixed seed", when: "they are stripped", then: "only critical chunks remain", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA stripper and its tests.\n## Decisions\nDEC-001: FR-001 in src/strip.ts.\n## Components\nsrc/strip.ts, tests/strip.test.ts\n## Data\nBytes\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "await Bun.file('src/strip.ts').text()"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [check] };
const planned = (id: string, path: string, dependsOn: string[] = []): Task => ({ id, title: `create ${path}`, description: `create ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" });
const tasks = [planned("T001", "src/strip.ts"), planned("T002", "tests/strip.test.ts", ["T001"])];

/** Four tests over generated cases, as the approved AC-001 asked. */
const generated = `const rand = mulberry(42);\n${[1, 2, 3, 4].map((n) => `test("generated ${n}", () => { expect(strip(cases(rand))).toBeDefined(); });`).join("\n")}\n`;
/** Three example tests, as the request asks. */
const examples = `${[1, 2, 3].map((n) => `test("example ${n}", () => { expect(strip(example${n})).toEqual(expected${n}); });`).join("\n")}\n`;

type Finding = Review["findings"][number];
const r001: Omit<Finding, "evidenceIds"> = { id: "R001", kind: "contradicts", severity: "medium", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "tests/strip.test.ts", symbol: null, claim: "tests/strip.test.ts uses a seeded random generator although the request says no random generators: plain example-based tests", impact: "The tests contradict the request", suggestedFix: "Remove the mandatory generated-case count and seed from AC-001, the plan and T002, and test plain examples instead" };

class ScriptedExecutor implements AgentExecutor {
  corrections: Task[] = [];
  reviewRequests: string[] = [];
  store: WorkflowStore | null = null;
  constructor(private root: string) {}
  /** Writes the test file and keeps its earlier content, as the edit tools do. */
  private writeTests(runId: string, content: string) {
    const path = join(this.root, "tests/strip.test.ts");
    const before = readFileSync(path, "utf8");
    if (!this.store?.latestArtifact(runId, `pre-images/${hashBytes(before)}`)) this.store?.artifact(runId, "pre-images", `pre-images/${hashBytes(before)}`, before);
    writeFileSync(path, content);
  }
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { dimension?: string; evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        if (!task) throw new Error("No task");
        if (task.origin !== "planned") this.corrections.push(task);
        if (task.id === "T001") writeFileSync(join(this.root, "src/strip.ts"), "export const strip = (b) => b;\n");
        // The planned test task follows AC-001; a correction of R001 follows the request; a
        // correction of the integrity finding restores what the guard says was dropped.
        else if (task.id === "T002") writeFileSync(join(this.root, "tests/strip.test.ts"), generated);
        else this.writeTests(request.runId, task.description.includes("Test integrity") ? generated : examples);
        output = { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Wrote the files", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": {
        this.reviewRequests.push(request.prompt);
        const random = readFileSync(join(this.root, "tests/strip.test.ts"), "utf8").includes("mulberry");
        if (data.extra.dimension !== "correctness" || !random) { output = pass; break; }
        output = { ...pass, verdict: "changes_requested", findings: [{ ...r001, evidenceIds }] };
        break;
      }
      case "convergence": output = pass; break;
      case "refutation": {
        const { finding: raised } = data.extra as unknown as { finding: Finding };
        output = { schemaVersion: 1, findingId: raised.id, decision: "confirmed", evidenceIds, explanation: "The review shows it" };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: pngvet a2da6c24, a review finding against the spec (#1034)", () => {
  test("the finding amends the spec and its tests-only correction is not undone", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-pngvet-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    executor.store = service.store;
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: request, ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const snapshot = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    // One correction, of R001; no integrity correction restored the generated tests.
    expect(executor.corrections.map((t) => t.description.includes("Test integrity"))).toEqual([false]);
    expect(readFileSync(join(root, "tests/strip.test.ts"), "utf8")).toBe(examples);
    const amendments = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("amendments/"));
    expect(amendments).toHaveLength(1);
    // The review after the correction reads that the request wins over AC-001.
    expect(executor.reviewRequests.at(-1)).toContain("Spec amendment (amendments/");
    expect(executor.reviewRequests.at(-1)).toContain("The request is authoritative over AC-001, FR-001");
    // The run report (and so the delivered pull request) lists it under Decisions.
    expect(runReport(service.store, run.runId)).toContain("Spec amendments (the request wins over the spec):");
  });
});

describe("spec amendment", () => {
  const finding = { ...r001, evidenceIds: ["E1"] };

  test("a contradicts finding that changes a criterion against the request amends the spec", () => {
    expect(specAmendmentOf(finding, spec)).toMatchObject({ findingId: "R001", criterionIds: ["AC-001"], requirementIds: ["FR-001"], paths: ["tests/strip.test.ts"] });
  });

  test("a finding against the code is corrected as before", () => {
    // The code contradicts the criterion: nothing in the spec changes.
    expect(specAmendmentOf({ ...finding, claim: "strip keeps tEXt chunks, which AC-001 forbids", suggestedFix: "Drop ancillary chunks in strip" }, spec)).toBeNull();
    // Another kind of finding, or a fix that only changes the code, even when it names the request.
    expect(specAmendmentOf({ ...finding, kind: "correctness" }, spec)).toBeNull();
    expect(specAmendmentOf({ ...finding, suggestedFix: "Use the examples of the request in tests/strip.test.ts" }, spec)).toBeNull();
  });
});
