import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import { scaledPolicy, UNCAPPED_TOKENS } from "../src/core/workflows/budget.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { migration001 } from "../src/core/workflows/migrations/001.js";
import { PolicySchema } from "../src/core/workflows/schemas.js";
import { newId, WorkflowStore } from "../src/core/workflows/store.js";
import { readWorkflowView } from "../src/core/workflows/view.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const checkpointed = (interval: number) => ({ ...fixturePolicy, maxTotalTokens: UNCAPPED_TOKENS, checkpointTokens: interval });
const signal = () => new AbortController().signal;

describe("storage migration 002", () => {
  function legacyDatabase(): string {
    const root = mkdtempSync(join(tmpdir(), "baked-migration-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".baked"), { recursive: true });
    const db = new Database(join(root, ".baked", "workflows.sqlite"));
    db.exec(migration001);
    db.run("INSERT INTO schema_migrations VALUES (1,?,?)", [hashBytes(migration001), Date.now()]);
    db.run("INSERT INTO features VALUES ('legacy','specs/legacy',1)");
    db.run("INSERT INTO runs (id,feature_id,status,definition_json,profiles_json,policy_json,input_manifest_json,input_hash,created_at,updated_at) VALUES ('r1','legacy','paused','{}','[]','{}','{}',?,1,1)", ["a".repeat(64)]);
    db.run("INSERT INTO requests (run_id,id,kind,status,digest,body_json,answer_json,actor,decided_at) VALUES ('r1','q1','clarification','accepted',?,'{\"q\":1}','{\"a\":2}','user',5)", ["b".repeat(64)]);
    db.run("INSERT INTO requests (run_id,id,kind,status,digest,body_json) VALUES ('r1','q2','approval','pending',?,'{}')", ["c".repeat(64)]);
    db.close();
    return root;
  }
  test("a version 1 database is upgraded on open and keeps every request", () => {
    const root = legacyDatabase();
    const store = new WorkflowStore(root);
    try {
      expect(store.requests("r1").map((r) => [r.id, r.kind, r.status])).toEqual([["q1", "clarification", "accepted"], ["q2", "approval", "pending"]]);
      expect(store.requests("r1")[0]).toMatchObject({ answer_json: '{"a":2}', body_json: '{"q":1}' });
      const id = store.request("r1", "checkpoint", "d".repeat(64), { boundary: 1 });
      expect(store.requests("r1").find((r) => r.id === id)?.kind).toBe("checkpoint");
    } finally { store.close(); }
    const db = new Database(join(root, ".baked", "workflows.sqlite"));
    try { expect(db.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }]); } finally { db.close(); }
    const again = new WorkflowStore(root);
    again.close();
  });
  test("a read-only open of a version 1 database works and does not change it", () => {
    const root = legacyDatabase();
    const reader = new WorkflowStore(root, true);
    try { expect(reader.requests("r1")).toHaveLength(2); } finally { reader.close(); }
    const db = new Database(join(root, ".baked", "workflows.sqlite"));
    try { expect(db.query("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 }); } finally { db.close(); }
  });
  test("a changed or unknown migration is refused", () => {
    const root = legacyDatabase();
    const db = new Database(join(root, ".baked", "workflows.sqlite"));
    db.run("UPDATE schema_migrations SET checksum=?", ["0".repeat(64)]);
    db.close();
    expect(() => new WorkflowStore(root)).toThrow("checksum");
    const second = legacyDatabase();
    const other = new Database(join(second, ".baked", "workflows.sqlite"));
    other.run("INSERT INTO schema_migrations VALUES (2,?,0)", ["1".repeat(64)]);
    other.close();
    expect(() => new WorkflowStore(second)).toThrow("version");
  });
  test("a new database starts at the latest version", () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const db = new Database(fixture.service.store.path, { readonly: true });
    try { expect(db.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }]); } finally { db.close(); }
  });
});

describe("policy and presets", () => {
  test("a stored policy without checkpoints reads as no checkpoints, and the interval has a floor", () => {
    const { checkpointTokens: _omitted, ...stored } = defaultWorkflowPolicy;
    expect(PolicySchema.parse(stored).checkpointTokens).toBeNull();
    expect(() => PolicySchema.parse({ ...stored, checkpointTokens: 500 })).toThrow();
    expect(PolicySchema.parse({ ...stored, checkpointTokens: 10000 }).checkpointTokens).toBe(10000);
  });
  test("the checkpoint preset removes the token cap and keeps the other guards", () => {
    const preset = scaledPolicy(defaultWorkflowPolicy, "checkpoints");
    expect(preset).toMatchObject({ maxTotalTokens: UNCAPPED_TOKENS, checkpointTokens: 200000, maxAgentCalls: 160, maxActiveMs: 7200000 });
    expect(scaledPolicy({ ...defaultWorkflowPolicy, checkpointTokens: 50000 }, "checkpoints").checkpointTokens).toBe(50000);
    expect(scaledPolicy(defaultWorkflowPolicy, "quick")).toMatchObject({ maxTotalTokens: 200000, checkpointTokens: null });
    // Scaling a checkpointed policy back to a capped preset drops the checkpoints.
    expect(scaledPolicy(preset, "extended")).toMatchObject({ checkpointTokens: null });
    expect(scaledPolicy(defaultWorkflowPolicy, "standard")).toBe(defaultWorkflowPolicy);
  });
});

describe("soft token checkpoints", () => {
  test("reservations that would pass the checkpoint fail before any attempt starts", async () => {
    const fixture = workflowFixture({ policy: checkpointed(10000) });
    cleanups.push(fixture.dispose);
    const { store } = fixture.service;
    const run = await fixture.start();
    store.transaction(() => store.transition(run.runId, "running"));
    const step = store.beginStep(run.runId, "fixture");
    const attempt = store.reserve(run.runId, step, "fixture/model", 6000, fixture.policy);
    // A second attempt starting inside the same interval would pass it.
    expect(() => store.reserve(run.runId, step, "fixture/model", 6000, fixture.policy)).toThrow("checkpoint");
    expect(store.attempts(run.runId)).toHaveLength(1);
    // A runaway loop inside one attempt is stopped at the next step, not after it.
    expect(() => store.expandReservation(run.runId, attempt, 9999, fixture.policy)).not.toThrow();
    expect(() => store.expandReservation(run.runId, attempt, 10001, fixture.policy)).toThrow("checkpoint");
    expect(store.checkpointBoundary(run.runId, fixture.policy)).toBe(10000);
    expect(store.checkpointBoundary(run.runId, { ...fixture.policy, checkpointTokens: null })).toBeNull();
  });

  test("a run waits at each checkpoint, never spends past it, and continues only on a decision", async () => {
    // Every call reports 4000 tokens and reserves far more, so checkpoints arrive early and often.
    const fixture = workflowFixture({ policy: checkpointed(10000), tokensPerCall: 4000 });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    const seen: { boundary: number; used: number; stage: string | null }[] = [];
    for (let i = 0; i < 60; i++) {
      const state = await service.get(run.runId);
      if (state.status === "completed") break;
      if (state.status === "waiting" && state.reason === "checkpoint") {
        const request = service.store.requests(run.runId).find((r) => r.kind === "checkpoint" && r.status === "pending")!;
        const body = JSON.parse(request.body_json);
        // The pause happens before the spend: the tokens used never exceed the checkpoint.
        expect(state.tokenUsage).toBeLessThanOrEqual(body.boundary);
        expect(body.boundary).toBe(service.store.checkpointBoundary(run.runId, fixture.policy));
        seen.push({ boundary: body.boundary, used: body.usedTokens, stage: body.stageId });
        // Nothing runs while the decision is pending.
        const before = fixture.executor.calls.length;
        expect(await service.drive(run.runId, signal())).toMatchObject({ status: "waiting", reason: "checkpoint" });
        expect(fixture.executor.calls.length).toBe(before);
        await service.decide(run.runId, { commandId: newId(), expectedRevision: state.revision }, { kind: "continue", requestId: request.id });
        await fixture.resume(run.runId);
        await service.drive(run.runId, signal());
        continue;
      }
      if (state.pendingRequestIds.length) await fixture.approve(run.runId);
      else if (state.status === "paused" || state.status === "created") await fixture.resume(run.runId);
      await service.drive(run.runId, signal());
    }
    expect((await service.get(run.runId)).status).toBe("completed");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    // Each checkpoint is further out than the last one.
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.boundary).toBeGreaterThan(seen[i - 1]!.boundary);
    const accepted = service.store.requests(run.runId).filter((r) => r.kind === "checkpoint");
    expect(accepted).toHaveLength(seen.length);
    expect(accepted.every((r) => r.status === "accepted")).toBe(true);
  });

  test("stopping at a checkpoint pauses the run, and resuming asks again instead of spending", async () => {
    const fixture = workflowFixture({ policy: checkpointed(10000), tokensPerCall: 4000 });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    await service.drive(run.runId, signal());
    const waiting = await service.get(run.runId);
    expect(waiting).toMatchObject({ status: "waiting", reason: "checkpoint" });
    const request = service.store.requests(run.runId).find((r) => r.kind === "checkpoint")!;
    const stopped = await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "reject", requestId: request.id, explanation: "Stopped at the token checkpoint" });
    expect(stopped.status).toBe("paused");
    const used = stopped.tokenUsage;
    await fixture.resume(run.runId);
    const again = await service.drive(run.runId, signal());
    expect(again).toMatchObject({ status: "waiting", reason: "checkpoint" });
    expect(again.tokenUsage).toBe(used);
    expect(service.store.requests(run.runId).filter((r) => r.kind === "checkpoint" && r.status === "pending")).toHaveLength(1);
  });

  test("only a checkpoint request accepts a continue decision", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    await service.drive(run.runId, signal());
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval")!;
    const state = await service.get(run.runId);
    await expect(service.decide(run.runId, { commandId: newId(), expectedRevision: state.revision }, { kind: "continue", requestId: approval.id })).rejects.toThrow("checkpoint");
  });

  test("the run view reports the interval and the next checkpoint; CLI continue stores the decision", async () => {
    const fixture = workflowFixture({ policy: checkpointed(10000), tokensPerCall: 4000 });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    await service.drive(run.runId, signal());
    const view = readWorkflowView(service, run.runId);
    expect(view.budget).toMatchObject({ checkpointTokens: 10000, nextCheckpoint: 10000, maxTokens: UNCAPPED_TOKENS });
    expect(view.requests.find((r) => r.status === "pending")?.kind).toBe("checkpoint");
    const request = view.requests.find((r) => r.status === "pending")!;
    const result = await executeWorkflowCommand(service, parseWorkflowArgs(["continue", run.runId, "--request", request.id, "--expected-revision", String(view.snapshot.revision)]), signal()) as { status: string };
    expect(result.status).toBe("paused");
    expect(readWorkflowView(service, run.runId).budget.nextCheckpoint).toBeGreaterThan(10000);
    expect(() => parseWorkflowArgs(["continue", run.runId, "--expected-revision", "1"])).not.toThrow();
  });
});
