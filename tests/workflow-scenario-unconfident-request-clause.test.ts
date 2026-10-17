import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { confidenceOnlyNote, findingBlocks } from "../src/core/verification/findings.js";
import { unconfidentReproAdvice } from "../src/core/verification/repro.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, Review, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 26, bytelens efe010c4 (#1210). The request says `invalid name "X"`
// applies also to `struct`, `end` and type names; the spec kept only the pattern rule. Convergence
// raised the gap at medium with confidence 0.6 and no repro, so it ended a note "below the
// confidence threshold" and the published app accepts `struct u8`. The walker is now asked once to
// try such a claim with run_repro; a repro that shows it starts a correction whatever the
// confidence.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const PARSE = "bytelens/parse.txt";
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Struct layout", problem: "Struct layouts are computed by hand", outcome: "A layout is printed for a struct file", inScope: ["Parse struct files"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Invalid names are rejected with FILE:LINE: invalid name", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "struct 1A", when: "the layout is printed", then: "FILE:LINE: invalid name \"1A\" is reported", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA parser.\n## Decisions\nDEC-001: FR-001 in the parser.\n## Components\nbytelens/parse.txt\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const tests: Check = { id: "tests", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const planned = (id: string, path: string): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });

/** Prints what `bytelens layout` gives for `struct u8`: the error once reserved names are checked. */
const repro = { executable: "bun", args: ["-e", `console.log((await Bun.file('${PARSE}').text()).includes('reserved') ? 'invalid name "u8"' : 'layout printed')`], expected: 'invalid name "u8"', actual: "layout printed" };

class ScriptedExecutor implements AgentExecutor {
  corrections: Task[] = [];
  advice: string[][] = [];
  /** The stage whose reviewer raises the dropped clause: the walker, or a dimension review (#1415). */
  constructor(
    private root: string,
    private raisedBy: "convergence" | "review" = "convergence",
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[]; finding?: { id: string }; dimension?: string } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: [PARSE] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned("T001", PARSE)] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task as Task;
        mkdirSync(join(this.root, "bytelens"), { recursive: true });
        if (task.origin === "planned") writeFileSync(join(this.root, PARSE), "pattern rule only\n");
        else {
          this.corrections.push(task);
          writeFileSync(join(this.root, PARSE), "pattern rule and reserved names\n");
        }
        output = { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence": {
        const coverage = [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "struct 1A is rejected" }];
        // One stage finds the dropped clause; the other passes.
        if (("dimension" in data.extra) !== (this.raisedBy === "review") || readFileSync(join(this.root, PARSE), "utf8").includes("reserved")) {
          output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage, findings: [] };
          break;
        }
        const finding: Review["findings"][number] = { id: "F-reserved-names", kind: "missing", severity: this.raisedBy === "review" ? "high" : "medium", basis: "spec", confidence: 0.6, requirementIds: ["FR-001"], criterionIds: [], file: PARSE, symbol: "valid_name", evidenceIds: evidence, claim: 'The request says invalid name "X" applies also for struct, end and type names, but `struct u8` is accepted', impact: "A struct named after a type prints a layout instead of the documented error", suggestedFix: "Reject struct, end and type names in valid_name" };
        const review = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage, findings: [finding] } as Review;
        // The walker attaches the repro it tried only when the host asks for it.
        const advice = request.validate?.(review) ?? [];
        this.advice.push(advice);
        if (advice.some((a) => a.includes("below the confidence threshold"))) finding.repro = repro;
        output = review;
        break;
      }
      case "refutation": output = { schemaVersion: 1, findingId: data.extra.finding?.id, decision: "confirmed", evidenceIds: evidence, explanation: "It is accepted" }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(raisedBy: "convergence" | "review" = "convergence") {
  const root = mkdtempSync(join(tmpdir(), "baked-bytelens-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 1, maxConvergenceRounds: 2, checks: [tests] };
  const executor = new ScriptedExecutor(root, raisedBy);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Print struct layouts; invalid name also for struct, end and type names", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const waiting = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  return { done, executor, root };
}

describe("scenario: bytelens efe010c4, a request clause kept as a confidence note (#1210)", () => {
  test("the walker is asked for a repro, it reproduces, and a corrective repairs the clause", async () => {
    const { done, executor, root } = await runScenario();
    expect(done.status).toBe("completed");
    expect(executor.advice[0]?.join("\n")).toContain("F-reserved-names are below the confidence threshold");
    expect(executor.corrections).toHaveLength(1);
    expect(readFileSync(join(root, PARSE), "utf8")).toContain("reserved names");
  }, 60000);

  // Audit of 2026-10-17 (#1415): the dimension review dropped such a claim before any repro ran.
  test("a dimension reviewer is asked for the repro too, and a reproduced claim repairs", async () => {
    const { done, executor, root } = await runScenario("review");
    expect(done.status).toBe("completed");
    expect(executor.advice[0]?.join("\n")).toContain("F-reserved-names are below the confidence threshold");
    expect(executor.corrections).toHaveLength(1);
    expect(readFileSync(join(root, PARSE), "utf8")).toContain("reserved names");
  }, 60000);

  test("only a missing or correctness claim on named behavior is kept a note for confidence alone", () => {
    const finding = (patch: Partial<Review["findings"][number]>): Review["findings"][number] => ({ id: "F1", kind: "missing", severity: "medium", basis: "spec", confidence: 0.6, requirementIds: [], criterionIds: [], file: PARSE, symbol: null, evidenceIds: ["E1"], claim: "struct u8 is accepted", impact: "", suggestedFix: "", ...patch });
    expect(confidenceOnlyNote(finding({}), 0.8)).toBe(true);
    expect(confidenceOnlyNote(finding({ kind: "correctness" }), 0.8)).toBe(true);
    expect(confidenceOnlyNote(finding({ confidence: 0.9 }), 0.8)).toBe(false);
    expect(confidenceOnlyNote(finding({ basis: "inferred" }), 0.8)).toBe(false);
    expect(confidenceOnlyNote(finding({ kind: "partial" }), 0.8)).toBe(false);
    expect(findingBlocks(finding({}), 0.8)).toBe(false);
    expect(findingBlocks(finding({}), 0.8, true)).toBe(true);
    expect(findingBlocks(finding({ basis: "inferred" }), 0.8, true)).toBe(false);
    const review = (f: Review["findings"][number]) => ({ schemaVersion: 1, snapshotHash: "x", verdict: "changes_requested", coverage: [], findings: [f] }) as Review;
    expect(unconfidentReproAdvice(review(finding({})), 0.8)).toHaveLength(1);
    expect(unconfidentReproAdvice(review(finding({ repro })), 0.8)).toEqual([]);
    expect(unconfidentReproAdvice(review(finding({ noRepro: "Wording only" })), 0.8)).toEqual([]);
  });
});
