import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { EDGE_DIR, type EdgeRecord } from "../src/core/verification/edge-inputs.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { exportTrace, replayTrace } from "../src/core/workflows/trace.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench rounds 53 and 54 (#1808). A source task's code broke on an extreme but legal
// input its criterion allows (an amount `1e4300` past Python's integer-string limit, a non-ASCII
// redirect target), its tests never tried one, and the final review found it after every test
// task had been written on top: 586k and 2.43M tokens of correctives. Here the source task's code
// handles ordinary amounts only. With `edgeProbe: "on"` the probe proposes a huge amount, the
// host runs it after the source task settles, and the corrective runs before the test task; a
// case the code gets right and a case that cannot run start nothing.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Amounts", problem: "No parser", outcome: "A parser", inScope: ["Parser"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Any decimal amount is accepted", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "an amount of any number of digits", when: "it is parsed", then: "the parser prints ok", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne parser.\n## Decisions\nDEC-001: FR-001 in amount.ts.\n## Components\namount.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "const t = await Bun.file('amount.ts').text(); if (!t.includes('ready')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const basePolicy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 3, maxConvergenceRounds: 3, checks: [check] };
const source: Task = { id: "T001", title: "Write the amount parser", description: "Write amount.ts", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "amount.ts", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };
const tests: Task = { ...source, id: "T002", title: "Test the amount parser", description: "Write tests/amount.test.ts", dependsOn: ["T001"], writes: [{ path: "tests/amount.test.ts", action: "create" }] };
// The parser handles a huge amount once its file says `big`.
const huge = { executable: "bun", args: ["-e", "const t = await Bun.file('amount.ts').text(); console.log(t.includes('big') ? 'ok' : 'overflow')"], expected: "ok", criterionId: "AC-001" };

class EdgeExecutor implements AgentExecutor {
  calls: { output: string; taskId?: string; origin?: string }[] = [];
  probed: Record<string, unknown>[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const task = request.task;
    this.calls.push({ output: request.profile.output, ...(task ? { taskId: task.id, origin: task.origin } : {}) });
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: Record<string, unknown> & { evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    const root = request.root ?? this.root;
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["amount.ts"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [source, tests] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        if (task?.id === "T001") write("amount.ts", "export const ready = true;\n");
        else if (task?.id === "T002") write("tests/amount.test.ts", "// amount tests\n");
        else write("amount.ts", "export const ready = true; // big\n");
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Changed the parser", evidenceIds: [], unresolved: [] };
        break;
      }
      case "edge-cases": {
        this.probed.push(data.extra);
        output = {
          schemaVersion: 1,
          cases: [
            huge,
            // One the code gets right, one that crashes without output, one no criterion allows.
            { executable: "bun", args: ["-e", "console.log('ok')"], expected: "ok", criterionId: "AC-001" },
            { executable: "bun", args: ["-e", "process.exit(3)"], expected: "ok", criterionId: "AC-001" },
            { ...huge, criterionId: "AC-999" },
          ],
          rationale: "Amounts past a number type's range",
        };
        break;
      }
      case "review":
      case "convergence": output = pass; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function drive(quality?: { edgeProbe: "on" | "off" }) {
  const root = mkdtempSync(join(tmpdir(), "baked-edge-probe-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new EdgeExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", ...(quality ? { quality } : {}), workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: basePolicy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Parse amounts", ownerLabel: "test", policy: basePolicy });
  await service.drive(started.runId, new AbortController().signal);
  const snapshot = await service.get(started.runId);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  const records = service.store
    .artifacts(started.runId)
    .filter((a) => a.logical_path.startsWith(EDGE_DIR))
    .map((a) => JSON.parse(service.store.readArtifact(started.runId, a.id)) as EdgeRecord);
  return { root, runId: started.runId, done, executor, service, records };
}

describe("scenario: R54 expenses-py, an extreme legal input of a source task (#1808)", () => {
  test("with edgeProbe on, a failing edge input is corrected before the test task runs", async () => {
    const { root, runId, done, executor, service, records } = await drive({ edgeProbe: "on" });
    expect(done.status).toBe("completed");
    expect(service.store.run(runId).policy_json).toContain('"edgeProbe":"on"');
    // One probe, of the source task only: not of the test task or of the corrective.
    expect(executor.calls.filter((c) => c.output === "edge-cases")).toHaveLength(1);
    const shown = executor.probed[0] as { task: { id: string }; criteria: { id: string }[]; files: string[]; executables: string[]; edge: { classes: string[]; limits: { language: string }[] } };
    expect(shown.task.id).toBe("T001");
    expect(shown.criteria.map((c) => c.id)).toEqual(["AC-001"]);
    expect(shown.files).toEqual(["amount.ts"]);
    expect(shown.executables).toContain("bun");
    expect(shown.edge.limits.map((l) => l.language)).toEqual(["typescript"]);
    expect(shown.edge.classes.length).toBeGreaterThan(0);
    // The huge amount is a finding; the right answer and the crash pass; AC-999 never runs.
    expect(records).toHaveLength(1);
    expect(records[0]?.cases.map((c) => [c.criterionId, c.status, c.decision])).toEqual([
      ["AC-001", "refuted", "finding"],
      ["AC-001", "reproduced", "pass"],
      ["AC-001", "inconclusive", "pass"],
    ]);
    const finding = service.store
      .findings(runId)
      .map((f) => JSON.parse(f.body_json) as { criterionIds: string[]; file: string; repro: { expected: string; actual: string } });
    expect(finding).toHaveLength(1);
    expect(finding[0]).toMatchObject({ criterionIds: ["AC-001"], file: "amount.ts", repro: { expected: "ok", actual: "overflow" } });
    // The corrective runs right after the source task, before the test task builds on it.
    const implementations = executor.calls.filter((c) => c.output === "implementation");
    expect(implementations.map((c) => c.origin)).toEqual(["planned", "repair", "planned"]);
    expect(implementations.at(-1)?.taskId).toBe("T002");
    expect(readFileSync(join(root, "amount.ts"), "utf8")).toContain("big");

    // The decisions replay from the bench trace (#1649).
    const dir = mkdtempSync(join(tmpdir(), "edge-probe-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(root, out);
    const replayed = replayTrace(out).runs.find((r) => r.runId === runId);
    expect(replayed?.edgeProbes.map((b) => [b.recorded, b.replayed])).toEqual([["finding", "finding"], ["pass", "pass"], ["pass", "pass"]]);
    expect(replayed?.newEdgeDecisions).toBe(0);
    expect(replayTrace(out, { edgeRule: () => "pass" }).runs.find((r) => r.runId === runId)?.newEdgeDecisions).toBe(1);
  }, 120_000);

  test("with edgeProbe off, no probe runs and the run is as before", async () => {
    const { done, executor, records } = await drive();
    expect(done.status).toBe("completed");
    expect(executor.calls.filter((c) => c.output === "edge-cases")).toEqual([]);
    expect(records).toEqual([]);
    expect(executor.calls.filter((c) => c.output === "implementation").map((c) => c.taskId)).toEqual(["T001", "T002"]);
  }, 120_000);
});
