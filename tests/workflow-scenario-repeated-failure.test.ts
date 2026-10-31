import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidOutputRepeat } from "../src/core/workflows/invalid-output-repeat.js";
import { REPEAT_TASKS_DIR, type RepeatRecord } from "../src/core/workflows/repeated-failure.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { NativeWorkflowService } from "../src/core/workflows/service.js";
import { stopRecovery } from "../src/core/workflows/stop-detail.js";
import { newId } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import { exportTrace, replayTrace } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 64, cfgquill lint a843cc11 (#1996): the corrective chain T003 -> T005 ->
// T006 -> T007 failed gofmt with the same `rules_test.go:26:2217: illegal byte order mark` each
// round, and only `maxTaskRepairs` ended it, after T006 (1.42M tokens) and T007 (3.43M). Here a
// task-scoped check prints what value.txt holds; each task writes its own scripted value. The
// `repeated_failure` stop reason is in shadow mode: it records `decision.would_stop` at the second
// identical corrective and the chain goes on as before.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class ScriptedExecutor extends FixtureExecutor {
  constructor(
    private directory: string,
    /** What each task writes to value.txt, by its place in the run: planned task first. */
    private values: string[],
  ) {
    super(directory);
  }
  private order: string[] = [];
  private attempts = 0;
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = result.output as { taskGraph: { tasks: { checkIds: string[] }[] } };
      plan.taskGraph.tasks[0]!.checkIds = ["check"];
    }
    if (request.profile.output === "implementation") {
      const id = request.task?.id ?? "";
      if (!this.order.includes(id)) this.order.push(id);
      const index = this.order.indexOf(id);
      // Every attempt edits the file (its second line), as each session of the bench run did;
      // the check reads only the first line.
      writeFileSync(join(this.directory, "value.txt"), `${this.values[Math.min(index, this.values.length - 1)] ?? ""}\nattempt ${++this.attempts}`);
    }
    return result;
  }
}

// The check fails like gofmt on a byte order mark: the file, line and column, and a duration
// that differs between runs of the same failure.
const checkScript = [
  "const t = (await Bun.file('value.txt').text()).split('\\n')[0];",
  "if (t !== 'ready') {",
  "  console.log('value.txt:26:2217: ' + t);",
  "  console.log('FAIL\\tlint\\t' + (Math.random() * 3).toFixed(3) + 's');",
  "  process.exit(1);",
  "}",
].join("\n");

async function chain(values: string[]) {
  const policy: RunPolicy = {
    ...fixturePolicy,
    maxTaskRepairs: 3,
    checks: fixturePolicy.checks.map((c) => ({ ...c, scope: "task", args: ["-e", checkScript] })),
  };
  const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, values) });
  cleanups.push(fixture.dispose);
  const { service } = fixture;
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  const stopped = await service.drive(run.runId, new AbortController().signal);
  const store = service.store;
  const records = store
    .artifacts(run.runId)
    .filter((a) => a.logical_path.startsWith(REPEAT_TASKS_DIR))
    .map((a) => JSON.parse(store.readArtifact(run.runId, a.id)) as RepeatRecord);
  const wouldStops = store
    .eventsOfType(run.runId, "decision.would_stop")
    .flatMap((e) => (e.type === "decision.would_stop" && e.payload.reason === "repeated_failure" ? [e.payload] : []));
  return { ...fixture, runId: run.runId, stopped, records, wouldStops };
}

describe("scenario: cfgquill lint a843cc11, a corrective chain repeating one failure (#1996)", () => {
  test("three correctives whose checks print the same output record a would-stop at the second", async () => {
    const { stopped, records, wouldStops, root, runId } = await chain(["bom", "bom", "bom", "bom"]);
    // Shadow mode: the chain still ends where maxTaskRepairs ends it.
    expect(stopped.status).toBe("blocked");
    expect(stopped.reason).toBe("no_progress");
    expect(records.map((r) => [r.taskId, r.previous, r.decision])).toEqual([
      ["T002", null, "first"],
      ["T003", "T002", "repeat"],
      ["T004", "T003", "repeat"],
    ]);
    expect(records.every((r) => r.root === "T001")).toBe(true);
    expect(records[1]?.checks).toEqual([{ id: "check", text: "value.txt:26:2217: bom\nFAIL\tlint\t<duration>", files: ["value.txt"] }]);
    expect(records[1]?.hash).toBe(records[0]?.hash ?? "");
    expect(records[1]?.firstDifference).toBeNull();
    // One would-stop per chain, at the second identical round, with both round ids.
    expect(wouldStops).toHaveLength(1);
    expect(wouldStops[0]).toMatchObject({ mode: "shadow", key: "chain-T001", inputs: { rounds: ["T002", "T003"], checks: ["check"], files: ["value.txt"], firstDifference: null } });
    expect(wouldStops[0]?.summary).toContain("T003 failed check exactly as T002 did");

    // The decision replays from the bench trace without the check's output (#1649).
    const dir = mkdtempSync(join(tmpdir(), "repeated-failure-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(root, out);
    expect(Buffer.from(Bun.gunzipSync(readFileSync(out))).includes("2217: bom")).toBe(false);
    const replayed = replayTrace(out).runs.find((r) => r.runId === runId);
    expect(replayed?.repeatedFailures.map((b) => [b.taskId, b.recorded, b.replayed])).toEqual([
      ["T002", "first", "first"],
      ["T003", "repeat", "repeat"],
      ["T004", "repeat", "repeat"],
    ]);
    expect(replayed?.newRepeatStops).toBe(0);
  }, 90000);

  test("a corrective whose output changes (progress) records none", async () => {
    const { stopped, records, wouldStops, root, runId } = await chain(["bom-1", "bom-2", "bom-3", "bom-4"]);
    expect(stopped.reason).toBe("no_progress");
    expect(records.map((r) => [r.taskId, r.decision])).toEqual([
      ["T002", "first"],
      ["T003", "progress"],
      ["T004", "progress"],
    ]);
    expect(records[1]?.firstDifference).toBeGreaterThan(0);
    expect(wouldStops).toEqual([]);
    // A rule that compares only the check ids is a new would-stop on this run's trace.
    const dir = mkdtempSync(join(tmpdir(), "repeated-failure-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(root, out);
    expect(replayTrace(out).runs.find((r) => r.runId === runId)?.newRepeatStops).toBe(0);
    const idsOnly = replayTrace(out, {
      repeatRule: (previous, current) =>
        previous === null ? "first" : previous.map((c) => c.id).join() === current.map((c) => c.id).join() ? "repeat" : "progress",
    }).runs.find((r) => r.runId === runId);
    expect(idsOnly?.newRepeatStops).toBe(1);
  }, 90000);

  test("a chain whose output repeats only after a different one in between records none", async () => {
    const { records, wouldStops } = await chain(["bom", "bom", "tab", "bom"]);
    expect(records.map((r) => [r.taskId, r.decision])).toEqual([
      ["T002", "first"],
      ["T003", "progress"],
      ["T004", "progress"],
    ]);
    expect(records[2]?.hash).toBe(records[0]?.hash ?? "");
    expect(wouldStops).toEqual([]);
  }, 90000);
});

// Scenario of bench round 82, slotprompt blocks 733c7777 and filters a7c8cf04 (#2520): the plan,
// made before core existed, had a `create` write for a file core's release had written, so the
// tool policy refused every edit ("Create target already exists"). Each attempt ended `blocked`
// with a reason worded anew, the repeat guard keyed on that wording, and the run was resumed into
// four attempts (852k tokens for blocks). Here value.txt exists before the run, the plan creates
// it, and each attempt's edit goes through the tool policy and words its blocked reason anew.
class RefusedExecutor extends FixtureExecutor {
  service?: NativeWorkflowService;
  attempts = 0;
  constructor(private workspace: string) {
    super(workspace);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output !== "implementation") return super.execute(request);
    const service = this.service;
    if (!service) throw new Error("No service");
    const root = request.root ?? this.workspace;
    const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, fixturePolicy, request.task, root);
    const refusal = await guard
      .execute("edit_file", { path: "value.txt" }, async () => {
        writeFileSync(join(root, "value.txt"), "ready");
        return { success: true };
      })
      .then(() => "", (error: Error) => error.message);
    const n = ++this.attempts;
    const reasons = [
      `The edit tool refuses value.txt (${refusal}); I cannot write the file.`,
      "Writing value.txt is not possible: the host says the target already exists, so the task is blocked.",
      `Attempt ${n}: value.txt cannot be created because it is present; please plan a modify instead.`,
    ];
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: "blocked", summary: `Blocked on value.txt, attempt ${n}`, evidenceIds: [], unresolved: [reasons[(n - 1) % reasons.length] ?? ""] },
      inputTokens: 25,
      outputTokens: 25,
    };
  }
}

describe("scenario: R82 slotprompt blocks 733c7777, one host refusal in new words each attempt (#2520)", () => {
  test("the second stop on the same refused write repeats, whatever the blocked reason says, and offers no resume", async () => {
    const fixture = workflowFixture({ executor: (root) => new RefusedExecutor(root) });
    cleanups.push(fixture.dispose);
    fixture.executor.service = fixture.service;
    const { service, root } = fixture;
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    // Core's release writes value.txt after the plan was made and approved; the run takes it in
    // as its baseline, as a released dependency's files are.
    writeFileSync(join(root, "value.txt"), "written by core\n");
    expect(await service.drive(run.runId, new AbortController().signal)).toMatchObject({ status: "blocked", reason: "input_changed" });
    await service.resume(run.runId, { commandId: newId(), expectedRevision: (await service.get(run.runId)).revision }, { acceptWorkspace: true });
    expect(await service.drive(run.runId, new AbortController().signal)).toMatchObject({ status: "blocked", reason: "invalid_output" });
    const store = service.store;
    const diagnostics = () => store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/")).map((a) => store.readArtifact(run.runId, a.id));
    // One stop: a plain resume gives the task the diagnostic, so it is offered.
    expect(invalidOutputRepeat(store, run.runId)?.repeats).toBe(false);
    await fixture.resume(run.runId);
    expect(await service.drive(run.runId, new AbortController().signal)).toMatchObject({ status: "blocked", reason: "invalid_output" });
    // The two stops' diagnostics differ in wording; the host's refusal is the same.
    const [first, second] = diagnostics();
    expect(first).not.toBe(second);
    const repeat = invalidOutputRepeat(store, run.runId);
    expect(repeat?.repeats).toBe(true);
    expect(repeat?.record.refusals).toEqual([{ code: "exists", path: "value.txt" }]);
    // The views lead with a changed input and offer no resume; a plain resume is refused.
    expect(stopRecovery(store, run.runId)?.remedies.map((r) => r.action)).toEqual(["reroute", "revise", "replan", "cancel"]);
    const refused = await fixture.resume(run.runId).then(() => null, (error: Error & { code?: string }) => error);
    expect(refused?.code).toBe("STALE_DECISION");

    // Each stop's decision is recorded with its inputs and replays from the bench trace.
    const dir = mkdtempSync(join(tmpdir(), "invalid-output-repeat-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(root, out);
    const replayed = replayTrace(out).runs.find((r) => r.runId === run.runId);
    const stops = replayed?.repeatedFailures.filter((b) => b.kind === "invalid-output") ?? [];
    expect(stops.map((b) => [b.recorded, b.replayed])).toEqual([
      ["first", "first"],
      ["repeat", "repeat"],
    ]);
    expect(replayed?.newRepeatStops).toBe(0);
  });
});
