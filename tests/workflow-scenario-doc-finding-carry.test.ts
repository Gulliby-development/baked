import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  CONVERGENCE_GATE_DIR,
  type ConvergenceGateRecord,
  convergenceGateDocCarries,
  REVIEW_GATE_DIR,
  type ReviewGateRecord,
  reviewGateDocCarries,
} from "../src/core/workflows/review-gate.js";
import type { Check, Review, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// #2868, R92 tailclose (Lua) docs: the review reported F1 (README transcript shows a literal `\n`)
// and F2 (prose code spans double the backslashes), kind `correctness`, `noRepro`, confidence 1,
// and F3 (kind `missing`) on the same README. F3 opened corrective T003, whose description named
// only F3: the gate passed it only the findings it decided, and F1 and F2 were notes
// (`doc_finding_unrepaired`, shadow, #2835). The second review raised them again (`repeatOf`), no
// correction opened, and the run completed with the README wrong. A documentation finding the gate
// keeps now rides the correction the same gate starts anyway (`reviewGateDocCarries`,
// `convergenceGateDocCarries`).

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Escapes", problem: "No reader", outcome: "A reader", inScope: ["Escapes"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The README documents the escapes \\n, \\t and \\\\", priority: "must", verification: "automated", sourceRefs: [] }, { id: "FR-002", text: "The README has a usage section", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the README", when: "a reader types its escapes", then: "the program reads the bytes the request names", method: "automated" }, { id: "AC-002", requirementIds: ["FR-002"], given: "the README", when: "a reader looks for usage", then: "it finds a usage section", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne reader.\n## Decisions\nDEC-001: FR-001 in README.md.\n## Components\nsrc/escapes.ts, README.md\n## Data\nNone\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "const t = await Bun.file('README.md').text(); if (!t.includes('Escapes')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
// The carry and repeat records are the shadow mode's; `enforce` (the default) repairs the finding itself.
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 3, maxConvergenceRounds: 3, checks: [check], stopModes: { doc_finding_unrepaired: "shadow" } };
const task: Task = { id: "T001", title: "Write the README", description: "Write README.md and src/escapes.ts", requirementIds: ["FR-001", "FR-002"], criterionIds: ["AC-001", "AC-002"], dependsOn: [], profileId: "implementer", writes: [{ path: "README.md", action: "create" }, { path: "src/escapes.ts", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };
// The planned README doubles each backslash in its code spans and has no usage section.
const doubled = "- `\\\\n` newline\n- `\\\\t` tab\n- `\\\\\\\\` backslash\n";
const single = "- `\\n` newline\n- `\\t` tab\n- `\\\\` backslash\n";
const ESCAPES_CLAIM = "The escape reference in README.md doubles every backslash: \\\\n where the program reads \\n";
const USAGE_CLAIM = "README.md has no usage section";

const finding = (id: string, over: Partial<Review["findings"][number]>, evidenceIds: string[]): Review["findings"][number] => ({
  id,
  kind: "correctness",
  severity: "medium",
  confidence: 1,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  file: "README.md",
  symbol: null,
  basis: "spec",
  evidenceIds,
  claim: ESCAPES_CLAIM,
  impact: "A reader who types the documented escapes gets different bytes",
  suggestedFix: "Show the request's escapes with single backslashes",
  noRepro: "This finding concerns README wording; changing that prose cannot change program output.",
  ...over,
});

type Stage = "review" | "convergence";

class CarryExecutor implements AgentExecutor {
  rounds = 0;
  /** The descriptions of the corrective tasks the run started. */
  correctives: string[] = [];
  constructor(
    private root: string,
    private stage: Stage,
    /** The corrective leaves the escapes as they are, as a model may although its task names them. */
    private stubborn = false,
  ) {}
  async execute(request: ExecutionRequest) {
    const current = request.task;
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: Record<string, unknown> & { evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const root = request.root ?? this.root;
    const readme = () => readFileSync(join(root, "README.md"), "utf8");
    // AC-002 fails while the usage section is missing, so the converge gate repairs C3 for it.
    const usage = (): "pass" | "fail" => (readme().includes("## Usage") ? "pass" : "fail");
    const coverage = [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }];
    // The reviewer of the stage under test: the escapes finding (and a usage finding in the first
    // round) while the README still has them; the other stage passes.
    const reviewed = (prefix: string) => {
      const findings: Review["findings"] = [];
      const first = this.rounds++ === 0;
      // A later round raises the escapes finding again as a repeat, as R92's second review did.
      if (readme().includes("\\\\n")) findings.push(first ? finding(`${prefix}1`, {}, evidenceIds) : finding(`${prefix}1-${this.rounds}`, { repeatOf: `${prefix}1` }, evidenceIds));
      if (!readme().includes("## Usage")) findings.push(finding(`${prefix}3`, { kind: "missing", criterionIds: ["AC-002"], requirementIds: ["FR-002"], claim: USAGE_CLAIM, impact: "A reader finds no usage", suggestedFix: "Add a usage section to README.md", noRepro: undefined }, evidenceIds));
      const covered = [...coverage, { criterionId: "AC-002", verdict: usage(), evidenceIds, explanation: "Read the README" }];
      return { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: findings.length ? "changes_requested" : "pass", coverage: covered, findings };
    };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["README.md"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [task] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        mkdirSync(dirname(join(root, "src/escapes.ts")), { recursive: true });
        if (current?.origin === "planned") {
          writeFileSync(join(root, "README.md"), `# tailclose\n\n## Escapes\n\n${doubled}`);
          writeFileSync(join(root, "src/escapes.ts"), "export const ESCAPES = ['\\n', '\\t', '\\\\'];\n");
        } else {
          // A corrective repairs what its description names, as a model reading its task would.
          const description = current?.description ?? "";
          this.correctives.push(description);
          let text = readme();
          if (description.includes(ESCAPES_CLAIM) && !this.stubborn) text = text.replace(doubled, single);
          if (description.includes(USAGE_CLAIM)) text += "\n## Usage\n\nRun `tailclose`.\n";
          writeFileSync(join(root, "README.md"), text);
        }
        output = { schemaVersion: 1, taskId: current?.id, outcome: "implemented", summary: "Wrote the files", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
        output = this.stage === "review" ? reviewed("F") : { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [...coverage, { criterionId: "AC-002", verdict: "pass", evidenceIds, explanation: "Read the README" }], findings: [] };
        break;
      case "convergence":
        output = this.stage === "convergence" ? reviewed("C") : { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [...coverage, { criterionId: "AC-002", verdict: "pass", evidenceIds, explanation: "Read the README" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function drive(stage: Stage, stubborn = false, run: RunPolicy = policy) {
  const root = mkdtempSync(join(tmpdir(), "baked-doc-carry-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new CarryExecutor(root, stage, stubborn);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: run } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Document the escapes", ownerLabel: "test", policy: run });
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
  const stopsOf = (reason: string) =>
    service.store
      .eventsOfType(started.runId, "decision.would_stop")
      .flatMap((e) => (e.type === "decision.would_stop" && e.payload.reason === reason ? [e.payload] : []));
  return { done, executor, readme: readFileSync(join(root, "README.md"), "utf8"), reviews: records<ReviewGateRecord>(REVIEW_GATE_DIR), convergences: records<ConvergenceGateRecord>(CONVERGENCE_GATE_DIR), stops: stopsOf("doc_finding_unrepaired"), repeats: stopsOf("doc_finding_repeat") };
}

describe("scenario: a kept README finding rides the correction the same gate starts (#2868)", () => {
  test("review gate (R92 tailclose): the corrective names F1 with F3 and the README ends repaired", async () => {
    const { done, executor, readme, reviews, stops } = await drive("review");
    expect(done.status).toBe("completed");
    // One corrective, named both findings: the escapes claim with its file and fix, and F3.
    expect(executor.correctives).toHaveLength(1);
    expect(executor.correctives[0]).toContain(ESCAPES_CLAIM);
    expect(executor.correctives[0]).toContain("Show the request's escapes with single backslashes");
    expect(executor.correctives[0]).toContain(USAGE_CLAIM);
    expect(readme).toContain(single);
    expect(readme).not.toContain("\\\\n");
    const gate = reviews.find((g) => g.record.findings.some((f) => f.id === "F1"));
    if (!gate) throw new Error("No review gate recorded F1");
    // The gate's own decision is unchanged (shadow, #2835); F1 rides it, recorded as carried.
    expect(gate.record.repaired).toEqual(["F3"]);
    expect(gate.record.carried).toEqual(["F1"]);
    expect(reviewGateDocCarries(gate.record)).toEqual(["F1"]);
    expect(stops.map((s) => [s.key, s.inputs.carried])).toEqual([[`${gate.path}#F1`, true]]);
  });

  test("converge gate: the corrective names C1 with C3 and the README ends repaired", async () => {
    const { done, executor, readme, convergences, stops } = await drive("convergence");
    expect(done.status).toBe("completed");
    expect(executor.correctives).toHaveLength(1);
    expect(executor.correctives[0]).toContain(ESCAPES_CLAIM);
    expect(executor.correctives[0]).toContain(USAGE_CLAIM);
    expect(readme).toContain(single);
    const gate = convergences.find((g) => g.record.findings.some((f) => f.id === "C1"));
    if (!gate) throw new Error("No convergence gate recorded C1");
    expect(gate.record.decision.verdicts.find((v) => v.id === "C3")?.verdict).toBe("repair");
    expect(gate.record.carried).toEqual(["C1"]);
    expect(convergenceGateDocCarries(gate.record)).toEqual(["C1"]);
    expect(stops.map((s) => [s.key, s.inputs.carried])).toEqual([[`${gate.path}#C1`, true]]);
  });

  test("shadow: a repeat no correction repaired records that it would open one more correction", async () => {
    const { done, executor, readme, reviews, stops } = await drive("review", true);
    // The second review's repeat is medium, below the floor of a round after a correction, so
    // R92 recorded no would-stop for it. The run completes as before (#2866 owns the enforce
    // mode); the record now names the repeat.
    expect(done.status).toBe("completed");
    expect(executor.correctives).toHaveLength(1);
    expect(readme).toContain(doubled);
    const repeat = reviews.find((g) => g.record.findings.some((f) => f.id === "F1-2"));
    if (!repeat) throw new Error("No review gate recorded the repeat");
    expect(repeat.record.repaired).toEqual([]);
    expect(repeat.record.carried).toBeUndefined();
    const stop = stops.find((s) => s.key === `${repeat.path}#F1-2`);
    expect(stop?.inputs).toMatchObject({ findingId: "F1-2", carried: false, repeatOf: "F1", belowFloor: true });
    expect(stop?.summary).toContain("would open one more correction");
  });
});

// #2931, R99 cronwhen (PHP) guide c0676172: under `enforce` (the default) review 1 repaired F1 and F2
// on the README; the corrective fixed part of them, review 2 raised F1 and F2 again at medium, the
// round's floor (critical, high) kept them notes, and the run completed with two unclosed code spans.
// `docFindingWouldStops` returned before its repeat rule under `enforce`, so nothing recorded the
// repeat. It now records a `doc_finding_repeat` would-stop (shadow) in every mode.
describe("scenario: R99 cronwhen, a README finding repeated below the floor is recorded under enforce (#2931)", () => {
  const enforced: RunPolicy = { ...policy, stopModes: { doc_finding_unrepaired: "enforce" } };
  for (const stage of ["review", "convergence"] as const)
    test(`${stage} gate: the repeat records doc_finding_repeat; the first round repaired the finding`, async () => {
      const { done, executor, readme, reviews, convergences, stops, repeats } = await drive(stage, true, enforced);
      const prefix = stage === "review" ? "F" : "C";
      const gates = stage === "review" ? reviews : convergences;
      expect(done.status).toBe("completed");
      // Enforce repairs the first round's finding with the usage finding; the corrective leaves the
      // escapes, and the repeat stays a note, as in R99.
      expect(executor.correctives).toHaveLength(1);
      expect(executor.correctives[0]).toContain(ESCAPES_CLAIM);
      expect(readme).toContain(doubled);
      const repeat = gates.find((g) => g.record.findings.some((f) => f.id === `${prefix}1-2`));
      if (!repeat) throw new Error("No gate recorded the repeat");
      expect(stops).toEqual([]);
      expect(repeats.map((r) => [r.key, r.mode])).toEqual([[`${repeat.path}#${prefix}1-2`, "shadow"]]);
      expect(repeats[0]?.inputs).toMatchObject({ findingId: `${prefix}1-2`, repeatOf: `${prefix}1`, severity: "medium", carried: false });
      expect(repeats[0]?.summary).toContain("would open one more correction");
    });

  test("shadow: the doc_finding_unrepaired record of the repeat is unchanged, and the repeat rule records it too", async () => {
    const { stops, repeats, reviews } = await drive("review", true);
    const repeat = reviews.find((g) => g.record.findings.some((f) => f.id === "F1-2"));
    if (!repeat) throw new Error("No review gate recorded the repeat");
    expect(stops.find((s) => s.key === `${repeat.path}#F1-2`)?.inputs).toMatchObject({ findingId: "F1-2", carried: false, repeatOf: "F1", belowFloor: true });
    expect(repeats.map((r) => r.key)).toEqual([`${repeat.path}#F1-2`]);
  });
});
