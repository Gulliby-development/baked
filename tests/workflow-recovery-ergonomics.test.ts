import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { RecoverBody } from "../src/core/api/schemas.js";
import { EffectJournal } from "../src/core/workflows/effects.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import * as recovery from "../src/core/workflows/recovery.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import { newId } from "../src/core/workflows/store.js";
import * as headless from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// R76 schemamask (#2415): the laptop slept at about 17:35Z while feature runs were mid-check.
// Two runs stopped `waiting interrupted_effect` on a check's `command` effect whose process died
// with the host; `recover --resolution retry` refused `--events` and then wanted an evidence
// file, and `extend --resume` at the workspace's parallel cap exited 5 with WORKSPACE_BUSY
// although the extension was applied.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A pid no process has: the check's process died with the host. */
const DEAD_PID = 2147483647;

function fixture(maxParallelRuns?: number) {
  const f = workflowFixture();
  if (maxParallelRuns !== undefined)
    (f.config.workflows as Record<string, unknown>).maxParallelRuns = maxParallelRuns;
  cleanups.push(f.dispose);
  return f;
}

/** A check's command effect, as `CheckRunner.run` journals it, whose process is `pid`. */
function checkEffect(store: WorkflowStore, runId: string, checkId: string, pid: number): string {
  const policy = JSON.parse(store.run(runId).policy_json);
  const step = store.beginStep(runId, `check-${checkId}`);
  const attempt = store.reserve(runId, step, null, 0, policy);
  const effect = store.prepareEffect(runId, attempt, "command", { checkId, definitionHash: `hash-${checkId}` }, null, null);
  store.recordProcess(runId, effect, pid);
  return effect;
}

/** The host died while it executed the run: its execution lease names a gone process. */
function deadOwner(store: WorkflowStore, runId: string): void {
  store.putLease({ resource: "execution", owner_id: "dead-owner", owner_epoch: 1, run_id: runId, expires_at: 0, process_identity_json: JSON.stringify({ pid: DEAD_PID }) });
}

const wouldResume = (store: WorkflowStore, runId: string) =>
  store
    .eventsOfType(runId, "decision.would_resume")
    .flatMap((e) => (e.type === "decision.would_resume" ? [e.payload] : []))
    .filter((p) => p.reason === "host-settle-interrupted-check");

describe("an interrupted check's command (#2415)", () => {
  test("the host records, in shadow, that it would settle it at a resume after the host died", async () => {
    const f = fixture();
    const run = await f.start();
    const store = f.service.store;
    const effect = checkEffect(store, run.runId, "tests-written", DEAD_PID);
    deadOwner(store, run.runId);
    const waiting = await f.service.resume(run.runId, { commandId: newId(), expectedRevision: (await f.service.get(run.runId)).revision });
    expect(waiting).toMatchObject({ status: "waiting", reason: "interrupted_effect" });
    const records = wouldResume(store, run.runId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ mode: "shadow", key: `effect-${effect}` });
    expect(records[0]?.inputs).toMatchObject({ effectId: effect, checkId: "tests-written", definitionHash: "hash-tests-written", processGone: true, settle: true, at: "resume", cause: "host stopped" });
    // Shadow: recorded, not applied. The person's request stays, and says retry is safe.
    expect(store.effects(run.runId).find((e) => e.id === effect)?.status).toBe("prepared");
    const request = store.requests(run.runId).find((r) => r.kind === "recovery" && r.status === "pending");
    expect(JSON.parse(request?.body_json ?? "{}").note).toContain("retry is safe");
  });

  test("the drive's recovery records it once, and not for a live process or another command", async () => {
    const f = fixture();
    const run = await f.start();
    const store = f.service.store;
    const gone = checkEffect(store, run.runId, "format", DEAD_PID);
    const live = checkEffect(store, run.runId, "lint", process.pid);
    const policy = JSON.parse(store.run(run.runId).policy_json);
    const step = store.beginStep(run.runId, "walk");
    const walk = store.prepareEffect(run.runId, store.reserve(run.runId, step, null, 0, policy), "command", { acceptanceGateId: "gate", executable: "app", args: [] }, null, null);
    store.recordProcess(run.runId, walk, DEAD_PID);
    const journal = new EffectJournal(store, new WorkspaceLeases(store));
    expect(recovery.recoverRun(store, journal, run.runId)).toBe(false);
    expect(recovery.recoverRun(store, journal, run.runId)).toBe(false);
    expect(wouldResume(store, run.runId).map((p) => p.key)).toEqual([`effect-${gone}`]);
    expect(store.run(run.runId)).toMatchObject({ status: "waiting", reason: "interrupted_effect" });
    const effects = store.effects(run.runId);
    expect(recovery.interruptedCheckDecision(effects.find((e) => e.id === live)!)?.settle).toBe(false);
    expect(recovery.interruptedCheckDecision(effects.find((e) => e.id === walk)!)).toBeNull();
  });
});

describe("recover from the terminal (#2415)", () => {
  async function interrupted() {
    const f = fixture();
    const run = await f.start();
    const effect = checkEffect(f.service.store, run.runId, "tests-written", DEAD_PID);
    deadOwner(f.service.store, run.runId);
    const waiting = await f.service.resume(run.runId, { commandId: newId(), expectedRevision: (await f.service.get(run.runId)).revision });
    const request = f.service.store.requests(run.runId).find((r) => r.kind === "recovery" && r.status === "pending")!;
    return { f, run, effect, request, revision: waiting.revision };
  }

  test("retry needs no --file, takes --events and continues the run", async () => {
    const { f, run, effect, request, revision } = await interrupted();
    const args = parseWorkflowArgs(["recover", run.runId, "--request", request.id, "--effect", effect, "--resolution", "retry", "--expected-revision", String(revision), "--events"]);
    expect(args.flags).toMatchObject({ resume: true, events: true });
    const stdout = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    let result: { status: string; reason: string };
    try {
      result = (await headless.executeWorkflowCommand(f.service, args, new AbortController().signal)) as typeof result;
    } finally { stdout.mockRestore(); }
    // The run went on: the fixture drove to its plan approval instead of staying `paused`.
    expect(f.executor.calls).toContain("plan");
    expect(result).toMatchObject({ status: "waiting", reason: "approval" });
    const decided = f.service.store.requests(run.runId).find((r) => r.id === request.id);
    expect(decided?.status).toBe("accepted");
    expect(JSON.parse(decided?.answer_json ?? "{}").evidence).toContain("Retry chosen without evidence");
    expect(f.service.store.effects(run.runId).find((e) => e.id === effect)?.status).toBe("failed");
  });

  test("--no-resume records the decision and leaves the run paused", async () => {
    const { f, run, effect, request, revision } = await interrupted();
    const args = parseWorkflowArgs(["recover", run.runId, "--request", request.id, "--effect", effect, "--resolution", "record-not-applied", "--expected-revision", String(revision), "--no-resume"]);
    const result = (await headless.executeWorkflowCommand(f.service, args, new AbortController().signal)) as { status: string };
    expect(result.status).toBe("paused");
    expect(f.executor.calls).toEqual([]);
  });

  test("the local API takes a recovery without evidence", () => {
    expect(RecoverBody.parse({ commandId: "c1", expectedRevision: 3, requestId: "r1", effectId: "e1", resolution: "retry" })).toMatchObject({ resolution: "retry" });
  });
});

describe("extend --resume at the workspace's parallel cap (#2415)", () => {
  test("answers that the extension is applied and the run continues when a slot is free, exit 0", async () => {
    const f = fixture(1);
    const run = await f.start();
    const store = f.service.store;
    store.transition(run.runId, "blocked", "budget_exhausted");
    // Another run executes in its own worktree and holds the only slot.
    const other = await f.start("other");
    store.putLease({ resource: `execution:${other.runId}`, owner_id: "other-owner", owner_epoch: 1, run_id: other.runId, expires_at: Date.now() + 60_000, process_identity_json: JSON.stringify({ pid: process.pid }) });
    const before = JSON.parse(store.run(run.runId).policy_json).maxActiveMs as number;
    const args = parseWorkflowArgs(["extend", run.runId, "--time-ms", String(before * 2), "--resume", "--expected-revision", String((await f.service.get(run.runId)).revision)]);
    const written: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { written.push(String(chunk)); return true; }) as never);
    let result: { status: string; queued?: { reason: string; message: string; next: string | null; executing: string[] } };
    try {
      result = (await headless.executeWorkflowCommand(f.service, args, new AbortController().signal)) as typeof result;
    } finally { stderr.mockRestore(); }
    expect(JSON.parse(store.run(run.runId).policy_json).maxActiveMs).toBe(before * 2);
    expect(result.status).toBe("paused");
    expect(result.queued).toMatchObject({ reason: "parallel_cap", executing: [other.runId] });
    expect(result.queued?.message).toContain("The extension is applied; the run is paused and continues when a slot is free");
    expect(result.queued?.next).toContain(`baked workflow resume ${run.runId}`);
    expect(written.join("")).toContain("The extension is applied");
    expect(headless.commandExit(args, result, () => Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("another WORKSPACE_BUSY refusal is not a queued answer", async () => {
    const f = fixture();
    const run = await f.start();
    const { WorkflowFault } = await import("../src/core/workflows/errors.js");
    const { queuedResume } = await import("../src/core/workflows/queued-resume.js");
    expect(queuedResume(new WorkflowFault("WORKSPACE_BUSY", "Workspace execution is owned by x"), f.service.store, run.runId, "The extension is applied")).toBeNull();
  });
});
