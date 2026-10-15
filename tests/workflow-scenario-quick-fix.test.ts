import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench rounds 17 to 24 (#1001): a correction of one small finding starts cold with the whole
// budget of the task it corrects (stmtsplit-update cae4291d: 546k tokens for one low README
// sentence). With `quickFix: "on"` its first attempt is small, and an unfinished one falls back.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Seen {
  taskId: string | undefined;
  maxSteps: number;
  attemptTokens: number | undefined;
}

/** T001 reports its own test failing (a one-file finding); the correction's first attempt does not finish. */
class QuickFixExecutor extends FixtureExecutor {
  seen: Seen[] = [];
  constructor(private dir: string) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output !== "implementation") return super.execute(request);
    const taskId = request.task?.id;
    this.seen.push({ taskId, maxSteps: request.maxSteps, attemptTokens: request.attemptTokens });
    const corrections = this.seen.filter((s) => s.taskId !== "T001").length;
    const unresolved =
      taskId === "T001"
        ? ["test_value_ready fails: AssertionError, value.txt holds partial"]
        : corrections === 1
          ? ["value.txt still needs the rest of the change"]
          : null;
    if (!unresolved) return super.execute(request);
    writeFileSync(join(this.dir, "value.txt"), taskId === "T001" ? "partial" : "partial, more");
    return {
      output: { schemaVersion: 1, taskId, outcome: "implemented", summary: "Part of it", evidenceIds: [], unresolved },
      inputTokens: 25,
      outputTokens: 25,
    };
  }
}

async function drive(policy: RunPolicy) {
  const fixture = workflowFixture({ policy, executor: (root) => new QuickFixExecutor(root) });
  cleanups.push(fixture.dispose);
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  const outcome = await fixture.service.drive(run.runId, new AbortController().signal);
  const executor = fixture.executor as QuickFixExecutor;
  return { fixture, run, outcome, corrections: executor.seen.filter((s) => s.taskId !== "T001") };
}

describe("scenario: a small correction starts as a quick fix (#1001)", () => {
  test("its first attempt has the quick caps, and an unfinished one falls back to the usual budget", async () => {
    const { outcome, corrections, fixture, run } = await drive({ ...fixturePolicy, quickFix: "on" });
    expect(outcome.status).toBe("completed");
    expect(corrections).toHaveLength(2);
    expect(corrections[0]).toMatchObject({ maxSteps: Math.min(16, fixturePolicy.maxAgentSteps), attemptTokens: 150_000 });
    expect(corrections[1]?.attemptTokens).not.toBe(150_000);
    expect(corrections[1]?.maxSteps).not.toBe(corrections[0]?.maxSteps);
    const state = fixture.service.store.state(run.runId);
    expect(Object.values(state.quickFixes)).toEqual(["full"]);
  }, 60000);

  test("without the setting a correction gets the usual budget from its first attempt", async () => {
    const { corrections, fixture, run } = await drive(fixturePolicy);
    expect(corrections[0]?.attemptTokens).not.toBe(150_000);
    expect(fixture.service.store.state(run.runId).quickFixes).toEqual({});
  }, 60000);
});
