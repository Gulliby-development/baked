import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { reproBlindToDocument } from "../src/core/verification/repro.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, Repro, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 37, ranktally d8bc82f7 (#1375). The correctness review raised F1 on
// README.md ("winners are every candidate with zero losses; a tied A=B ballot elects both") with a
// repro that ran the tally and expected [] where it printed ["A","B"]: the expected value contradicts
// the claim, and no edit of the README can change what the code prints. Corrective T004 rewrote the
// README, the repro still printed ["A","B"], and the worker raised a spec conflict that waited for
// a person (one intervention, about 0.32M tokens).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const CODE = "export const winners = (tied: string[]) => tied;\n";
const WRONG = "# ranktally\n\nWinners reach every candidate through locked results.\n";
const RIGHT = "# ranktally\n\nWinners are every candidate with zero losses; a tie elects both.\n";

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Release", problem: "The README describes winners", outcome: "The README matches the contract", inScope: ["README.md"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The README says winners are every candidate with zero losses", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the README", when: "it is read", then: "it names zero losses", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne library.\n## Decisions\nDEC-001: FR-001 in README.md.\n## Components\ntally.ts, README.md\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "if (!(await Bun.file('tally.ts').exists())) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [check] };
const planned: Task = { id: "T001", title: "Write the library and README", description: "Write tally.ts and README.md", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "tally.ts", action: "create" }, { path: "README.md", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };
// What the code prints for a tied A=B ballot, against an expected value the claim contradicts.
const repro: Repro = { executable: "bun", args: ["-e", "const { winners } = await import(`${process.cwd()}/tally.ts`); console.log(JSON.stringify(winners(['A', 'B'])))"], expected: "[]", actual: '["A","B"]' };

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
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["README.md"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        if (task?.origin !== "planned") {
          // The corrective rewrites the README, then the host reruns the findings' repros.
          writeFileSync(join(this.root, "README.md"), RIGHT);
          this.verdicts.push((await request.reproCheck?.(this.root, request.signal)) ?? []);
        } else {
          writeFileSync(join(this.root, "tally.ts"), CODE);
          writeFileSync(join(this.root, "README.md"), WRONG);
        }
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Wrote the files", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = pass; break;
      case "convergence": {
        if (readFileSync(join(this.root, "README.md"), "utf8").includes("zero losses")) {
          output = pass;
          break;
        }
        const finding = { id: "F1", kind: "correctness", severity: "high", basis: "spec", confidence: 1, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "README.md", symbol: null, evidenceIds, claim: "The README says winners reach every candidate through locked results; the contract elects every candidate with zero losses, so a tied A=B ballot elects both", impact: "Users misread the result", suggestedFix: "Describe winners as the candidates with zero losses", repro };
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: "The README contradicts the contract" }], findings: [finding] };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: ranktally d8bc82f7, a README finding whose repro runs the code (#1375)", () => {
  test("the corrective that fixes the README is not held by the code's output and asks nobody", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-ranktally-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Document who wins", ownerLabel: "test", policy });
    await service.drive(started.runId, new AbortController().signal);
    const snapshot = await service.get(started.runId);
    const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(started.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    // The corrective ran once and the host found nothing its README edit was expected to change.
    expect(executor.verdicts).toEqual([[]]);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe(RIGHT);
  });
});

describe("a document finding's repro", () => {
  test("that runs code is blind to the document; one that reads the document is not", () => {
    expect(reproBlindToDocument("README.md", repro)).toBe(true);
    expect(reproBlindToDocument("docs/usage.md", repro)).toBe(true);
    expect(reproBlindToDocument("README.md", { ...repro, args: ["-e", "console.log(require('fs').readFileSync('README.md','utf8'))"] })).toBe(false);
    expect(reproBlindToDocument("tally.ts", repro)).toBe(false);
    expect(reproBlindToDocument(null, repro)).toBe(false);
  });
});
