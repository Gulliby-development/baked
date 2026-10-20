import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findPricing } from "../src/core/llm/pricing.js";
import { canonical } from "../src/core/specs/hash.js";
import { assertForecastFits } from "../src/core/workflows/cost-forecast.js";
import { DEFAULT_MIX } from "../src/core/workflows/estimate.js";
import { PolicySchema, type Task } from "../src/core/workflows/schemas.js";
import { DEFAULT_PER_FILE, verificationTokens } from "../src/core/workflows/sizing.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import { exportTrace, openTrace, replayTrace } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #1649: a change to the forecast or the caps is replayed on recorded runs before it merges.
const MODEL = "anthropic/claude-sonnet-4-6";
const mid = (range: { low: number; high: number }) => (range.low + range.high) / 2;
const CODE = mid(DEFAULT_PER_FILE.code.create);
const price = findPricing(MODEL)!.pricing;
const reviewRate = (DEFAULT_MIX.input * price.input + DEFAULT_MIX.cacheRead * price.cacheRead + DEFAULT_MIX.output * price.output) / 1e6;
const SECRET = "Implement the zebra-striped quantum ledger";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class ScriptedExecutor extends FixtureExecutor {
  store!: WorkflowStore;
  override async execute(request: ExecutionRequest) {
    const policy = PolicySchema.parse(JSON.parse(this.store.run(request.runId).policy_json));
    assertForecastFits(this.store, request.runId, policy);
    if (request.profile.output === "implementation") {
      const task = request.task!;
      for (const write of task.writes) {
        const path = join(request.root, write.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "// ready\n");
      }
      const tokens = CODE * 2;
      this.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical({
        schemaVersion: 1, profileId: request.profile.id, taskId: task.id,
        maxSteps: 10, maxTokens: 1_000_000, stopReason: "submitted", finalizedBy: null, totalTokens: tokens,
        steps: [{ step: 1, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
      }));
      return {
        output: { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: SECRET, evidenceIds: [], unresolved: [] },
        inputTokens: tokens, outputTokens: 0,
      };
    }
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = result.output as { taskGraph: { tasks: Task[] } };
      const template = plan.taskGraph.tasks[0]!;
      plan.taskGraph.tasks = Array.from({ length: 6 }, (_, i) => ({
        ...template,
        id: `T00${i + 1}`,
        title: `${SECRET} ${i + 1}`,
        description: `${SECRET} in value ${i}`,
        dependsOn: i ? [`T00${i}`] : [],
        writes: [{ path: `src/value${i}.ts`, action: "create" }],
      }));
    }
    return result;
  }
}

/** A finished run whose code tasks used twice their price, under a cap that covers that. */
async function recordedRun() {
  const cap = Math.ceil((6 * CODE * 2 * price.input / 1e6 + verificationTokens() * reviewRate) * 1.3 * 100) / 100;
  const policy = {
    ...fixturePolicy, maxAgentCalls: 1000, maxTotalTokens: 10_000_000, maxCostUsd: cap, sizing: { maxRunTokens: 20_000_000 },
    checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "0"] }],
  };
  const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root) });
  cleanups.push(fixture.dispose);
  fixture.config.defaultModel = MODEL;
  fixture.executor.store = fixture.service.store;
  const { runId } = await fixture.start();
  const planned = await fixture.service.drive(runId, new AbortController().signal);
  if (planned.status !== "waiting") throw new Error(`${planned.status} ${planned.reason} ${JSON.stringify(fixture.service.store.artifacts(runId).filter((a) => a.kind === "diagnostic").map((a) => fixture.service.store.readArtifact(runId, a.id).slice(0, 400)))}`);
  await fixture.approve(runId);
  const done = await fixture.service.drive(runId, new AbortController().signal);
  expect(done.status).toBe("completed");
  const out = join(mkdtempSync(join(tmpdir(), "trace-test-")), "run.sqlite.gz");
  cleanups.push(() => rmSync(dirname(out), { recursive: true, force: true }));
  return { fixture, runId, cap, out };
}

describe("usage traces of recorded runs (#1649)", () => {
  test("a trace keeps the usage, policy and transitions of a run and none of its work", async () => {
    const { fixture, runId, out } = await recordedRun();
    const exported = exportTrace(fixture.root, out);
    expect(exported.runs).toBe(1);
    const raw = Buffer.from(Bun.gunzipSync(readFileSync(out)));
    expect(raw.includes(SECRET)).toBe(false);
    expect(raw.includes("// ready")).toBe(false);
    const path = join(dirname(out), "plain.sqlite");
    writeFileSync(path, raw);
    const db = new Database(path, { readonly: true });
    try {
      const kinds = (db.query("SELECT DISTINCT kind FROM artifacts ORDER BY kind").all() as { kind: string }[]).map((r) => r.kind);
      expect(kinds).toContain("usage");
      expect(kinds).toContain("sizing");
      expect(kinds).not.toContain("diagnostic");
      const attempts = db.query("SELECT COUNT(*) AS n FROM attempts WHERE run_id=?").get(runId) as { n: number };
      expect(attempts.n).toBe(fixture.service.store.attempts(runId).length);
      expect((db.query("SELECT COUNT(*) AS n FROM evidence").get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  }, 60000);

  test("a trace keeps the run state readable, with stand-ins for its prose (#1707)", async () => {
    const { fixture, runId, out } = await recordedRun();
    exportTrace(fixture.root, out);
    const { store, dispose } = openTrace(out);
    try {
      const state = store.state(runId);
      const original = fixture.service.store.state(runId);
      expect(state.prompt).toMatch(/^prompt-\d+$/);
      expect(state.verificationState).toBe(original.verificationState);
      expect(state.graph?.tasks.length).toBe(original.graph?.tasks.length);
      // Equal prose stays equal and distinct prose stays distinct, without its text.
      const descriptions = (state.graph?.tasks ?? []).map((t) => t.description);
      const before = (original.graph?.tasks ?? []).map((t) => t.description);
      expect(new Set(descriptions).size).toBe(new Set(before).size);
      expect(descriptions.every((d) => /^description-\d+$/.test(d))).toBe(true);
      expect(store.snapshot(runId).status).toBe("completed");
    } finally {
      dispose();
    }
  }, 60000);

  test("replaying a run the current code passes finds no stop or growth it did not make", async () => {
    const { fixture, runId, out } = await recordedRun();
    exportTrace(fixture.root, out);
    const replay = replayTrace(out);
    expect(replay.runs.map((r) => r.runId)).toEqual([runId]);
    const run = replay.runs[0]!;
    expect(run.boundaries.length).toBe(fixture.service.store.attempts(runId).filter((a) => a.model_id !== null).length);
    expect(run.boundaries.some((b) => b.projectedUsd !== null)).toBe(true);
    expect([run.newStops, run.newGrowth, run.removedStops]).toEqual([0, 0, 0]);
    expect(run.finalUsd).toBeCloseTo(fixture.service.store.costUsage(runId).spentUsd, 6);
    expect(run.ratios.length).toBeGreaterThan(0);
  }, 60000);

  test("a change that would have stopped the recorded run shows as a new stop", async () => {
    const { fixture, runId, cap, out } = await recordedRun();
    exportTrace(fixture.root, out);
    // Stand-in for a forecast regression: the same run held to a tighter cap than it needed.
    const path = join(dirname(out), "tight.sqlite");
    writeFileSync(path, Bun.gunzipSync(readFileSync(out)));
    const db = new Database(path);
    const policy = JSON.parse((db.query("SELECT policy_json FROM runs WHERE id=?").get(runId) as { policy_json: string }).policy_json);
    db.run("UPDATE runs SET policy_json=? WHERE id=?", [canonical({ ...policy, maxCostUsd: Math.round(cap * 0.5 * 100) / 100 }), runId]);
    db.close();
    const run = replayTrace(path).runs[0]!;
    expect(run.newStops).toBeGreaterThan(0);
    expect(run.boundaries.find((b) => b.replayed === "stop")?.projectedUsd).toBeGreaterThan(cap * 0.5);
  }, 60000);
});
