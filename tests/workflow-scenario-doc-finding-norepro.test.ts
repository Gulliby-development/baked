import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  CONVERGENCE_GATE_DIR,
  type ConvergenceGateRecord,
  convergenceGateDecision,
  REVIEW_GATE_DIR,
  type ReviewGateRecord,
  reviewGateDecision,
} from "../src/core/workflows/review-gate.js";
import type { Check, Review, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// #2835, R91 stopcut docs (run b10e4246): the reviewer found that the README's escape reference
// doubles every backslash (`\\n` where the program reads `\n`), confidence 1, basis spec, and wrote
// kind `correctness` with a `noRepro` ("changing that prose cannot change program output").
// `reproAllows` keeps a correctness claim without a repro a note, so the review gate recorded
// `repaired: []` and the README shipped wrong, where the same defect called `partial` repairs. The
// review and converge gates now decide such a documentation finding with `docFindingRepairs` and
// record a `doc_finding_unrepaired` would-stop for it; the same finding on a source file records
// none. Shadow: the run is as before.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Escapes", problem: "No reader", outcome: "A reader", inScope: ["Escapes"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The README documents the escapes \\n, \\t, \\\\ and \\xHH", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the README", when: "a reader types its escapes", then: "the program reads the bytes the request names", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne reader.\n## Decisions\nDEC-001: FR-001 in README.md.\n## Components\nsrc/escapes.ts, README.md\n## Data\nNone\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "const t = await Bun.file('README.md').text(); if (!t.includes('Escapes')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 3, maxConvergenceRounds: 3, checks: [check] };
const task: Task = { id: "T001", title: "Write the README", description: "Write README.md and src/escapes.ts", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "README.md", action: "create" }, { path: "src/escapes.ts", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };
// The delivered README doubles each backslash in its code spans, as R91 stopcut's did.
const readme = "# stopcut\n\n## Escapes and input format\n\n- `\\\\n` newline\n- `\\\\t` tab\n- `\\\\\\\\` backslash\n- `\\\\xHH` byte\n";

const finding = (id: string, file: string, evidenceIds: string[]): Review["findings"][number] => ({
  id,
  kind: "correctness",
  severity: "medium",
  confidence: 1,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  file,
  symbol: null,
  basis: "spec",
  evidenceIds,
  claim: `The escape reference in ${file} doubles every backslash: \\\\n where the program reads \\n`,
  impact: "A reader who types the documented escapes gets different bytes",
  suggestedFix: "Show the request's escapes with single backslashes",
  noRepro: "This finding concerns README wording; changing that prose cannot change program output.",
});

class DocExecutor implements AgentExecutor {
  reviews = 0;
  convergences = 0;
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const current = request.task;
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: Record<string, unknown> & { evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const coverage = [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }];
    const root = request.root ?? this.root;
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["README.md"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [task] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        mkdirSync(dirname(join(root, "src/escapes.ts")), { recursive: true });
        writeFileSync(join(root, "README.md"), readme);
        writeFileSync(join(root, "src/escapes.ts"), "export const ESCAPES = ['\\n', '\\t', '\\\\'];\n");
        output = { schemaVersion: 1, taskId: current?.id, outcome: "implemented", summary: "Wrote the files", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": {
        // The first review reports the README finding and the same claim on a source file.
        const findings = this.reviews++ === 0 ? [finding("F1", "README.md", evidenceIds), finding("F2", "src/escapes.ts", evidenceIds)] : [];
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: findings.length ? "changes_requested" : "pass", coverage, findings };
        break;
      }
      case "convergence": {
        // The first convergence walk reports both again; later walks pass.
        const findings = this.convergences++ === 0 ? [finding("C1", "README.md", evidenceIds), finding("C2", "src/escapes.ts", evidenceIds)] : [];
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: findings.length ? "changes_requested" : "pass", coverage, findings };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function drive() {
  const root = mkdtempSync(join(tmpdir(), "baked-doc-norepro-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new DocExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Document the escapes", ownerLabel: "test", policy });
  await service.drive(started.runId, new AbortController().signal);
  const snapshot = await service.get(started.runId);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  const records = <T>(dir: string) =>
    service.store
      .artifacts(started.runId)
      .filter((a) => a.logical_path.startsWith(dir))
      .map((a) => ({ path: a.logical_path, record: JSON.parse(service.store.readArtifact(started.runId, a.id)) as T }));
  const stops = service.store
    .eventsOfType(started.runId, "decision.would_stop")
    .flatMap((e) => (e.type === "decision.would_stop" && e.payload.reason === "doc_finding_unrepaired" ? [e.payload] : []));
  return { done, reviews: records<ReviewGateRecord>(REVIEW_GATE_DIR), convergences: records<ConvergenceGateRecord>(CONVERGENCE_GATE_DIR), stops };
}

describe("scenario: a README correctness finding marked noRepro (#2835)", () => {
  test("the review and converge gates record a shadow would-stop for the README finding, none for the source one", async () => {
    const { done, reviews, convergences, stops } = await drive();
    // Shadow: both findings stay notes and the run completes as before.
    expect(done.status).toBe("completed");
    const review = reviews.find((g) => g.record.findings.some((f) => f.id === "F1"));
    if (!review) throw new Error("No review gate recorded F1");
    expect(review.record.repaired).toEqual([]);
    const reviewed = new Map(review.record.findings.map((f) => [f.id, f]));
    expect(reviewed.get("F1")).toMatchObject({ kind: "correctness", noRepro: true, doc: true });
    expect(reviewed.get("F2")?.doc).toBeUndefined();
    // The recorded gate decides the same (the documentation rule's keeps: tests/gate-matrix.test.ts).
    expect(reviewGateDecision(review.record)).toEqual([]);

    const converge = convergences.find((g) => g.record.findings.some((f) => f.id === "C1"));
    if (!converge) throw new Error("No convergence gate recorded C1");
    expect(converge.record.decision.verdicts.filter((v) => v.verdict === "repair")).toEqual([]);
    expect(convergenceGateDecision(converge.record).verdicts).toEqual(converge.record.decision.verdicts);
    const converged = new Map(converge.record.findings.map((f) => [f.id, f]));
    expect(converged.get("C1")).toMatchObject({ noRepro: true, doc: true, testOrDoc: true });
    expect(converged.get("C2")?.doc).toBeUndefined();

    expect(stops.map((s) => [s.mode, s.key]).sort()).toEqual(
      [
        ["shadow", `${review.path}#F1`],
        ["shadow", `${converge.path}#C1`],
      ].sort(),
    );
    expect(stops.every((s) => s.summary.includes("README.md"))).toBe(true);
  });
});
