import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { reproAllows, reproCrash } from "../src/core/verification/repro.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  type ConvergenceGate,
  convergenceGateCrashKeeps,
  convergenceGateDecision,
  type GateFinding,
  REVIEW_GATE_DIR,
  type ReviewGate,
  type ReviewGateRecord,
  reviewGateCrashKeeps,
  reviewGateDecision,
} from "../src/core/workflows/review-gate.js";
import type { Check, Review, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Sibling of #2136 (#2152). A reviewer's high correctness finding on src/storage.ts carries a repro
// that imports the module and crashes inside it (`error: Missing parameter "code"` at
// src/storage.ts): the repro is inconclusive, so `reproAllows` keeps the finding a note, as the
// edge probe passed R68 url-shortener's crashing cases. The gate now records the crash decision on
// the finding and an `edge_crash_finding` would-stop that names it; a finding whose repro fails on
// its own (a module that does not exist) records neither. Shadow: the run is as before.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Links", problem: "No storage", outcome: "A storage", inScope: ["Storage"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "A link is stored and read back", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a link of any code", when: "it is stored and read", then: "the same link is printed", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne storage.\n## Decisions\nDEC-001: FR-001 in src/storage.ts.\n## Components\nsrc/storage.ts\n## Data\nSQLite\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "const t = await Bun.file('src/storage.ts').text(); if (!t.includes('createLink')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 3, maxConvergenceRounds: 3, checks: [check] };
const source: Task = { id: "T001", title: "Write the link storage", description: "Write src/storage.ts", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/storage.ts", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };
const storage = [
  "export function createLink(code: string, url: string) {",
  "  if (code !== undefined) throw new Error('Missing parameter \"code\"');",
  "  return { code, url };",
  "}",
  "",
].join("\n");

const finding = (id: string, module: string, evidenceIds: string[]): Review["findings"][number] => ({
  id,
  kind: "correctness",
  severity: "high",
  confidence: 0.9,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  file: "src/storage.ts",
  symbol: "createLink",
  basis: "spec",
  evidenceIds,
  claim: "createLink throws for every code",
  impact: "No link can be stored",
  suggestedFix: "Bind the code parameter",
  repro: { executable: "bun", args: ["-e", `import { createLink } from '${module}'; console.log(createLink('abc', 'https://e.x').code)`], expected: "abc", actual: "undefined" },
});

class ReviewExecutor implements AgentExecutor {
  reviews = 0;
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const task = request.task;
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: Record<string, unknown> & { evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const coverage = [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }];
    const root = request.root ?? this.root;
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/storage.ts"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [source] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        mkdirSync(dirname(join(root, "src/storage.ts")), { recursive: true });
        writeFileSync(join(root, "src/storage.ts"), storage);
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Wrote the code", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": {
        // The first review reports both findings; later reviews pass.
        const findings = this.reviews++ === 0 ? [finding("F1", "./src/storage.ts", evidenceIds), finding("F2", "./src/nope.ts", evidenceIds)] : [];
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: findings.length ? "changes_requested" : "pass", coverage, findings };
        break;
      }
      case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage, findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function drive() {
  const root = mkdtempSync(join(tmpdir(), "baked-repro-crash-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ReviewExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Store links", ownerLabel: "test", policy });
  await service.drive(started.runId, new AbortController().signal);
  const snapshot = await service.get(started.runId);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  const gates = service.store
    .artifacts(started.runId)
    .filter((a) => a.logical_path.startsWith(REVIEW_GATE_DIR))
    .map((a) => ({ path: a.logical_path, record: JSON.parse(service.store.readArtifact(started.runId, a.id)) as ReviewGateRecord }));
  const stops = service.store
    .eventsOfType(started.runId, "decision.would_stop")
    .flatMap((e) => (e.type === "decision.would_stop" && e.payload.reason === "edge_crash_finding" ? [e.payload] : []));
  return { done, gates, stops };
}

describe("scenario: a reviewer finding whose repro crashes in its own file (#2152)", () => {
  test("the crash is recorded on the finding with a shadow would-stop; a repro that fails on its own is not", async () => {
    const { done, gates, stops } = await drive();
    // Shadow: both findings stay notes and the run completes as before.
    expect(done.status).toBe("completed");
    const gate = gates.find((g) => g.record.findings.some((f) => f.id === "F1"));
    if (!gate) throw new Error("No review gate recorded F1");
    expect(gate.record.repaired).toEqual([]);
    const byId = new Map(gate.record.findings.map((f) => [f.id, f]));
    expect(byId.get("F1")).toMatchObject({ outcome: "inconclusive", crash: "finding" });
    expect(byId.get("F2")).toMatchObject({ outcome: "inconclusive", crash: "pass" });
    const keyed = stops.filter((s) => s.key.startsWith(gate.path));
    expect(keyed.map((s) => [s.mode, s.key])).toEqual([["shadow", `${gate.path}#F1`]]);
    expect(keyed[0]?.summary).toContain('Missing parameter "code"');
    // The recorded gate decides the same, and the crash rule would repair F1 alone.
    expect(reviewGateDecision(gate.record)).toEqual([]);
    expect(reviewGateCrashKeeps(gate.record)).toEqual(["F1"]);
  });
});

describe("reproCrash and the gates' crash rule (#2152)", () => {
  const crashed = {
    status: "inconclusive" as const,
    output: 'error: Missing parameter "code"\n    at createLink (/home/u/p/src/storage.ts:2:27)\n    at /home/u/p/[eval]:1:40\n',
  };
  test("an inconclusive repro that crashes in the finding's file is a finding; one outside it, or not inconclusive, is not", () => {
    expect(reproCrash(crashed, "src/storage.ts")).toEqual({ crash: "finding", actual: 'error: Missing parameter "code"' });
    expect(reproCrash(crashed, "src/other.ts")).toEqual({ crash: "pass", actual: null });
    expect(reproCrash(crashed, null)).toEqual({ crash: "pass", actual: null });
    expect(reproCrash({ status: "inconclusive", output: "error: Cannot find module './src/nope.ts'" }, "src/storage.ts")).toEqual({ crash: "pass", actual: null });
    expect(reproCrash({ ...crashed, status: "refuted" }, "src/storage.ts")).toBeNull();
    expect(reproCrash(undefined, "src/storage.ts")).toBeNull();
    // `reproAllows` itself is unchanged: an inconclusive repro still keeps the finding a note.
    expect(reproAllows({ kind: "correctness", severity: "high" }, "inconclusive", true)).toBe(false);
  });

  const gated = (id: string, fields: Partial<GateFinding>): GateFinding => ({ id, severity: "medium", kind: "correctness", basis: "spec", confidence: 0.9, repro: true, sibling: false, outcome: "inconclusive", ...fields });

  test("the review gate's crash keeps are the crashed findings the gate does not repair", () => {
    const gate: ReviewGate = {
      reviewer: "correctness",
      required: true,
      blocking: ["critical", "high", "medium"],
      severities: ["critical", "high", "medium"],
      minConfidence: 0.7,
      reproAvailable: true,
      findings: [gated("A", { crash: "finding" }), gated("B", { crash: "pass" }), gated("C", {}), gated("D", { kind: "security", crash: "finding" }), gated("E", { outcome: "reproduced" })],
    };
    expect(reviewGateDecision(gate).sort()).toEqual(["D", "E"]);
    expect(reviewGateCrashKeeps(gate)).toEqual(["A"]);
  });

  test("the convergence gate's crash keeps are the crashed claims it accepts unreproduced", () => {
    const gate: ConvergenceGate = {
      severities: ["critical", "high", "medium"],
      minConfidence: 0.7,
      checksPass: true,
      reproAvailable: true,
      canRepro: true,
      criteria: [{ criterionId: "AC-001", verdict: "pass", evidence: 1 }],
      failing: [],
      findings: [gated("A", { crash: "finding" }), gated("B", { crash: "pass" })].map((f) => ({ ...f, testOrDoc: false, criterionIds: ["AC-001"] })),
    };
    expect(convergenceGateDecision(gate).verdicts).toEqual([{ id: "A", verdict: "repro" }, { id: "B", verdict: "repro" }]);
    expect(convergenceGateCrashKeeps(gate)).toEqual(["A"]);
  });
});
