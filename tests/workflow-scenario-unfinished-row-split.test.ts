import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { CheckRunner } from "../src/core/verification/check-runner.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { fileHash } from "../src/core/workflows/effects.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import { ROW_SPLIT_DIR, type RowSplitRecord, rowSplitDecision, rowSplitRecord, rowSplitRecords } from "../src/core/workflows/row-split.js";
import type { Check, RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { rowVolumePrice } from "../src/core/workflows/sizing.js";
import { newId } from "../src/core/workflows/store.js";
import { exportTrace, replayRowSplits, replayTrace } from "../src/core/workflows/trace.js";
import type { AgentExecutor, ExecutionRequest, Task } from "../src/core/workflows/types.js";

// Bench round 78 deltaglue cli (#2458, follow-up to #2455 item 3): T007 wrote
// `tests/problems.test.ts` from 63 prescribed rows, ended unfinished four times with "add the
// remaining 55 prescribed literal rows", and each resume started over with the whole task: 7
// attempts, 6.89M tokens. The host now records, at each unfinished end from the second on, the
// rows the file still lacks and the slices of them it would start instead (shadow).

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const PATH = "tests/problems.test.ts";
const row = (n: number) => `{ args: ["problems", "case-${n}"], code: 0, out: "answer ${n}\\n", err: "" }`;
const ROWS = Array.from({ length: 60 }, (_, i) => row(i + 1));
const REQUEST = [
  "Write the problems command and its tests.",
  "",
  "```",
  `ProblemsTests in ${PATH} (60 rows, { args, code, out, err })`,
  ...ROWS,
  "```",
].join("\n");
/** The test file holding the first `n` rows. */
const fileWith = (n: number) => ['import { test } from "bun:test";', "const rows = [", ...ROWS.slice(0, n).map((r) => `  ${r},`), "];", "for (const r of rows) test(r.args[1], () => {});", ""].join("\n");
const task: Pick<Task, "id" | "writes"> = { id: "T001", writes: [{ path: PATH, action: "create" }] };
const policy = { sizing: { maxAttemptTokens: 600_000 } };

describe("the split decision at a rows test task's unfinished end (#2458)", () => {
  test("after two unfinished ends the missing rows are recorded with the slices the host would start", () => {
    const record = rowSplitRecord(task, REQUEST, 2, () => fileWith(8), policy);
    expect(record).toMatchObject({ schemaVersion: 1, taskId: "T001", mode: "shadow", path: PATH, delivered: true, ends: 2, rows: 60, decision: "split", cap: 600_000 });
    expect(record?.missing).toEqual(Array.from({ length: 52 }, (_, i) => i + 9));
    const chars = ROWS.slice(8).reduce((n, r) => n + r.length, 0);
    expect(record?.missingChars).toBe(chars);
    // The slices are cut by the missing rows' price, as a plan-time row split is (#2455).
    const count = rowVolumePrice(chars, 52, 600_000).slices;
    expect(record?.slices).toHaveLength(count);
    expect(record?.slices.flat()).toEqual(record?.missing ?? []);
    expect(record?.reason).toContain(`52 of 60 prescribed rows missing: the host would start ${count} slice`);
  });

  test("one unfinished end, a file that holds every row, or a task with no prescribed rows decides no split", () => {
    expect(rowSplitRecord(task, REQUEST, 1, () => fileWith(8), policy)).toMatchObject({ decision: "resume", slices: [], missing: expect.any(Array) });
    expect(rowSplitRecord(task, REQUEST, 3, () => fileWith(60), policy)).toMatchObject({ decision: "resume", missing: [], reason: "the file holds every prescribed row" });
    expect(rowSplitRecord({ id: "T002", writes: [{ path: "src/problems.ts", action: "create" }] }, REQUEST, 3, () => null, policy)).toBeNull();
    // Rows the host writes itself (`rowsAsData`) are not this decision's.
    expect(rowSplitRecord({ ...task, rows: ["AC-001"] }, REQUEST, 3, () => null, policy)).toBeNull();
  });

  test("a file not there lacks every row; a slice task owns only its own rows", () => {
    expect(rowSplitRecord(task, REQUEST, 2, () => null, policy)).toMatchObject({ delivered: false, rows: 60, decision: "split" });
    const slice = { ...task, sizingSlice: { taskId: "T001", index: 1, count: 2, share: 0.5, rows: ROWS.slice(30) } };
    const record = rowSplitRecord(slice, REQUEST, 2, () => fileWith(40), policy);
    expect(record).toMatchObject({ rows: 30, decision: "split" });
    expect(record?.missing).toEqual(Array.from({ length: 20 }, (_, i) => i + 41));
  });
});

// The run: a test task that keeps ending blocked with rows missing, each attempt adding a few.
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Problems", problem: "No tests", outcome: "Tests exist", inScope: ["Tests"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The rows are tested", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the rows", when: "the tests run", then: "every row passes", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne test file.\n## Decisions\nDEC-001: FR-001 rows.\n## Components\ntests/problems.test.ts\n## Data\nRows\n## Verification\nrows check\n## Risks\nNone for fixture";
const script = `const t = await Bun.file('${PATH}').text(); const n = (t.match(/case-/g) ?? []).length; console.log(n + ' of 60 rows'); process.exit(n === 60 ? 0 : 1);`;
const rowsCheck: Check = { id: "rows", executable: "bun", args: ["-e", script], cwd: ".", timeoutMs: 10000, required: true, scope: "task", envNames: [], writes: [] };
const runPolicy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [rowsCheck, { ...rowsCheck, id: "suite", scope: "feature" }] };

class ScriptedExecutor implements AgentExecutor {
  implementations = 0;
  service?: NativeWorkflowService;
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["tests"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Write the problems tests", description: `Transcribe the 60 prescribed rows into ${PATH}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: PATH, action: "create" }], readHints: [], checkIds: ["rows"], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const index = this.implementations++;
        const root = request.root ?? this.root;
        const store = this.service?.store;
        if (!store) throw new Error("No service");
        const file = join(root, PATH);
        mkdirSync(join(root, "tests"), { recursive: true });
        const effect = store.prepareEffect(request.runId, request.attemptId, "file_patch", { path: PATH, tool: "edit_file" }, fileHash(file), null);
        // Each attempt adds four rows and runs out before the rest.
        const held = 4 * (index + 1);
        writeFileSync(file, fileWith(held));
        store.finishFileEffect(request.runId, effect, fileHash(file));
        const scope = new ProcessScope();
        try {
          await new CheckRunner(store, scope).run(request.runId, request.attemptId, rowsCheck, request.signal ?? new AbortController().signal, root);
        } finally {
          await scope.stop();
        }
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "blocked", summary: `Wrote ${held} of the 60 rows`, evidenceIds: [], unresolved: [`Add the remaining ${60 - held} prescribed literal rows`] };
        break;
      }
      case "review": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "Checks pass" }], findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: R78 deltaglue cli T007, a rows test task that ends unfinished twice (#2458)", () => {
  test("the second unfinished end records the missing rows and the slices the host would start; the resume stays whole", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-unfinished-row-split-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: runPolicy } };
    const service = new NativeWorkflowService(root, config, executor);
    executor.service = service;
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "standard", prompt: REQUEST, ownerLabel: "test", policy: runPolicy });
    await service.drive(run.runId, new AbortController().signal);
    const waiting = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    const store = service.store;
    // Shadow: the run blocks and resumes the whole task as before.
    expect(done).toMatchObject({ status: "blocked", reason: "invalid_output" });
    expect(executor.implementations).toBe(3);
    const versions = store
      .artifacts(run.runId)
      .filter((a) => a.logical_path === `${ROW_SPLIT_DIR}T001.json`)
      .map((a) => JSON.parse(store.readArtifact(run.runId, a.id)) as RowSplitRecord);
    // One record per unfinished end: the first resumes, the second would split.
    expect(versions.map((r) => [r.ends, r.decision, r.missing.length])).toEqual([
      [1, "resume", 52],
      [2, "split", 48],
    ]);
    const [latest] = rowSplitRecords(store, run.runId);
    expect(latest?.missing).toEqual(Array.from({ length: 48 }, (_, i) => i + 13));
    expect(latest?.slices.flat()).toEqual(latest?.missing ?? []);
    const wouldStops = store
      .eventsOfType(run.runId, "decision.would_stop")
      .flatMap((e) => (e.type === "decision.would_stop" && e.payload.reason === "unfinished_row_split" ? [e.payload] : []));
    expect(wouldStops).toHaveLength(1);
    expect(wouldStops[0]).toMatchObject({ mode: "shadow", key: "task-T001", inputs: { taskId: "T001", path: PATH, ends: 2, rows: 60, missing: 48 } });
    expect(wouldStops[0]?.summary).toContain("48 of 60 prescribed rows missing");

    // The decision replays from the bench trace, and an older rule that always resumed is caught.
    const dir = mkdtempSync(join(tmpdir(), "unfinished-row-split-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(root, out);
    const replayed = replayTrace(out).runs.find((r) => r.runId === run.runId);
    expect(replayed?.rowSplits).toEqual([{ taskId: "T001", ends: 2, recorded: "split", replayed: "split", slices: { recorded: latest?.slices.length ?? 0, replayed: latest?.slices.length ?? 0 } }]);
    expect(replayed?.newRowSplits).toBe(0);
    const resumeAlways = () => ({ decision: "resume" as const, slices: [], reason: "before #2458" });
    expect(replayTrace(out, { rowSplitRule: resumeAlways }).runs.find((r) => r.runId === run.runId)?.rowSplits[0]?.replayed).toBe("resume");
    // A recording made by the older rule is a new split under the current one.
    const old = JSON.parse(JSON.stringify(latest)) as RowSplitRecord;
    expect(rowSplitDecision({ ...old, ends: 1 }).decision).toBe("resume");
    expect(replayRowSplits(store, run.runId)[0]?.recorded).toBe("split");
  }, 120000);
});
