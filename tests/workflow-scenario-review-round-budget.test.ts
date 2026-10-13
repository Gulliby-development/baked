import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 14, mdrefs 8531a4f0 (#928). A v2 run (the standard preset) whose checks
// stage needs two corrective passes (the tests, then the formatter) and whose review then reports
// one medium finding the host reproduces. Before the fix the review's correction was numbered
// repair round 3 and refused: `no_progress: 1 finding(s) remain after the policy's
// maxRepairRounds (2)`, although every required check passed.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Diagnostics", problem: "Diagnostics are missing", outcome: "Diagnostics use the exact format", inScope: ["Write diagnostics"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Diagnostics use the exact format", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a bad argument", when: "the tool runs", then: "the diagnostic has the exact format", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne output file.\n## Decisions\nDEC-001: FR-001 needs the exact format.\n## Components\nout.txt\n## Data\nText\n## Verification\nTests and formatter\n## Risks\nNone for fixture";
const check = (id: string, script: string): Check => ({ id, executable: "bun", args: ["-e", script], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] });
const policy: RunPolicy = {
  ...defaultWorkflowPolicy,
  maxRepairRounds: 2,
  checks: [
    check("tests", "const t = await Bun.file('out.txt').text(); if (!t.startsWith('ready')) { console.log('(fail) value is ready'); console.log('Expected ready, received ' + t.trim()); process.exit(1) }"),
    check("fmt", "const t = await Bun.file('out.txt').text(); if (t.split('\\n').some((l) => l.endsWith(' '))) { console.log('out.txt: trailing whitespace'); process.exit(1) }"),
  ],
};
/** Prints `debug` while the diagnostic is not in the exact format, as Rust's Debug formatting did. */
const repro = { executable: "bun", args: ["-e", "console.log((await Bun.file('out.txt').text()).includes('exact') ? 'exact' : 'debug')"], expected: "exact", actual: "debug" };

interface Behavior {
  /** What each implementation writes to out.txt, in order; the last entry repeats. */
  writes: string[];
  /** Severity of the review finding. */
  severity: "high" | "medium";
}

class ScriptedExecutor implements AgentExecutor {
  implementations = 0;
  reviews = 0;
  constructor(
    private root: string,
    private behavior: Behavior,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[]; finding?: { id: string } } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["out.txt"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Write diagnostics", description: "Write out.txt", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "out.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const writes = this.behavior.writes;
        writeFileSync(join(this.root, "out.txt"), writes[Math.min(this.implementations++, writes.length - 1)] ?? "");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote out.txt", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": {
        this.reviews++;
        const exact = readFileSync(join(this.root, "out.txt"), "utf8").includes("exact");
        output = exact
          ? { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "Checks pass" }], findings: [] }
          : { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [], findings: [{ id: "F001", kind: "correctness", severity: this.behavior.severity, basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "out.txt", symbol: null, evidenceIds: evidence, claim: `Argument diagnostics use Debug formatting (review ${this.reviews})`, impact: "The output violates the specified exact format", suggestedFix: "Print the exact format", repro }] };
        break;
      }
      // The skeptic of a high finding confirms it.
      case "refutation": output = { schemaVersion: 1, findingId: data.extra.finding?.id, decision: "confirmed", evidenceIds: evidence, explanation: "The repro shows it" }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(behavior: Behavior) {
  const root = mkdtempSync(join(tmpdir(), "baked-mdrefs-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, behavior);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "standard", prompt: "Write exact diagnostics", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const waiting = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  const errors = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/"));
  const lastError = errors.length ? service.store.readArtifact(run.runId, errors.at(-1)?.id ?? "") : "";
  return { done, row: service.store.run(run.runId), service, runId: run.runId, executor, root, lastError };
}

// Tests fail first, the corrected file leaves trailing whitespace for the formatter, then all
// checks pass with the Debug-formatted diagnostic the review reports.
const checksTwice = ["broken\n", "ready debug \n", "ready debug\n"];

describe("scenario: mdrefs 8531a4f0, a review after two checks-stage passes (#928)", () => {
  test("a reproduced medium review finding is repaired after the checks stage used both repair rounds", async () => {
    const { done, row, root, lastError, service, runId } = await runScenario({ writes: [...checksTwice, "ready exact\n"], severity: "medium" });
    expect(lastError).toBe("");
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("ready exact\n");
    expect(row.repair_rounds).toBe(2);
    expect(row.review_rounds).toBe(1);
    expect(row.convergence_rounds).toBe(0);
    expect(row.corrective_tasks).toBe(3);
    expect(service.store.latestArtifact(runId, "corrections/review-1.json")).toBeTruthy();
  }, 60000);

  test("a high review finding that keeps reproducing still stops once the review rounds are used", async () => {
    const { done, row, lastError, executor } = await runScenario({ writes: [...checksTwice, "ready debug v2\n", "ready debug v3\n", "ready debug v4\n"], severity: "high" });
    expect(done.status).toBe("blocked");
    expect(done.reason).toBe("no_progress");
    expect(lastError).toContain("maxRepairRounds (2)");
    expect(row.repair_rounds).toBe(2);
    expect(row.review_rounds).toBe(2);
    expect(executor.reviews).toBe(3);
  }, 60000);

  test("a required check that keeps failing still stops at maxRepairRounds", async () => {
    const { done, row, executor } = await runScenario({ writes: ["broken\n", "broken again\n", "still broken\n", "never ready\n"], severity: "medium" });
    expect(done.status).toBe("blocked");
    expect(done.reason).toBe("no_progress");
    expect(row.repair_rounds).toBe(2);
    expect(row.review_rounds).toBe(0);
    expect(executor.reviews).toBe(0);
  }, 60000);
});
