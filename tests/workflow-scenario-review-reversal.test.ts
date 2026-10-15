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

// Scenario of bench round 27 (#1234, the broader option of #1227). expenses-py 617fef26: the repair
// of F004 (an unterminated quote swallowed the valid rows after it) made F005 (a valid multiline
// field with a record-shaped line is split). Both repros cannot pass, and once the review rounds
// were used the run blocked `no_progress`. Here each correction fixes the side it is given and
// breaks the other: the reader alternates between `swallowed` and `split` in the same file.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "CSV reader", problem: "Rows are read wrong", outcome: "Rows are read", inScope: ["Read CSV rows"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Rows are read", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a CSV", when: "it is read", then: "every row is read", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne reader.\n## Decisions\nDEC-001: FR-001 needs rows.\n## Components\nreader.txt\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check = (id: string, script: string): Check => ({ id, executable: "bun", args: ["-e", script], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] });
const base: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [check("tests", "if (!(await Bun.file('reader.txt').text()).startsWith('ready')) process.exit(1)")] };
const repro = (word: string) => ({ executable: "bun", args: ["-e", `console.log((await Bun.file('reader.txt').text()).includes('${word}') ? '${word}' : 'ok')`], expected: "ok", actual: word });

class ScriptedExecutor implements AgentExecutor {
  reviews = 0;
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[]; finding?: { id: string } } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["reader.txt"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Read rows", description: "Write reader.txt", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "reader.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        // The planned task swallows rows; each correction fixes the side it is given and breaks the other.
        const path = join(this.root, "reader.txt");
        const swallows = request.task?.origin === "planned" || readFileSync(path, "utf8").includes("split");
        writeFileSync(path, swallows ? "ready swallowed\n" : "ready split\n");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote reader.txt", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": {
        this.reviews++;
        const text = readFileSync(join(this.root, "reader.txt"), "utf8");
        const word = text.includes("swallowed") ? "swallowed" : "split";
        const finding = { id: `F00${this.reviews}`, kind: "correctness", severity: "high", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "reader.txt", symbol: "read_rows", evidenceIds: evidence, claim: word === "swallowed" ? "An unterminated quote swallows the valid rows after it" : `A valid multiline field is split (review ${this.reviews})`, impact: "Rows are lost or split", suggestedFix: "Read every row", repro: repro(word), repeatOf: null };
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [], findings: [finding] };
        break;
      }
      case "refutation": output = { schemaVersion: 1, findingId: data.extra.finding?.id, decision: "confirmed", evidenceIds: evidence, explanation: "The repro shows it" }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(policy: RunPolicy) {
  const root = mkdtempSync(join(tmpdir(), "baked-review-reversal-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "standard", prompt: "Read every CSV row", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const waiting = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  const errors = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/"));
  const lastError = errors.length ? service.store.readArtifact(run.runId, errors.at(-1)?.id ?? "") : "";
  return { done, service, runId: run.runId, lastError };
}

describe("scenario: a review finding that reverses an earlier fix (#1234)", () => {
  test("under clarification assume it becomes a known limitation once the review rounds are used", async () => {
    const { done, service, runId, lastError } = await runScenario({ ...base, clarification: "assume" });
    expect(lastError).toBe("");
    expect(done.status).toBe("completed");
    const state = service.store.state(runId);
    expect(state.limitations.map((l) => [l.severity, l.decidedBy])).toEqual([["high", "assume"]]);
    const reversal = service.store.artifacts(runId).find((a) => a.logical_path.startsWith("review/reversals-"));
    const pairs = JSON.parse(service.store.readArtifact(runId, reversal?.id ?? "")).pairs as { earlierClaim: string }[];
    expect(pairs.map((p) => p.earlierClaim)).toEqual(["A valid multiline field is split (review 2)"]);
  }, 60000);

  test("without assume the run still stops at the review limit", async () => {
    const { done, lastError } = await runScenario(base);
    expect(done.status).toBe("blocked");
    expect(lastError).toContain("maxRepairRounds (2)");
  }, 60000);
});
