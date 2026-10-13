import { afterEach, describe, expect, test } from "bun:test";
import { extendToOf, type RunPolicy } from "../src/core/workflows/schemas.js";
import { stopDetail } from "../src/core/workflows/stop-detail.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 16 (#974). A plan priced above the run's token ceiling started without a
// word at approval, and 4 of 10 runs stopped at 87-99% of the ceiling with a corrective half done:
// `sizing.extendToTokens` was unset, so a run under `clarification: assume` could not grow past
// the ceiling even while it made progress.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The fixture's plan with a second task after the first, so a stop can leave one unfinished. */
class TwoTaskExecutor extends FixtureExecutor {
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output !== "plan") return result;
    const graph = (result.output as { taskGraph: { tasks: Record<string, unknown>[] } }).taskGraph;
    const first = graph.tasks[0] ?? {};
    graph.tasks.push({
      ...first,
      id: "T002",
      title: "Create notes",
      writes: [{ path: "notes.txt", action: "create" }],
      dependsOn: ["T001"],
    });
    return result;
  }
}

function fixture(policy: RunPolicy, tokensPerCall?: (output: string) => number, twoTasks = false) {
  const made = workflowFixture({
    policy,
    tokensPerCall,
    ...(twoTasks ? { executor: (root: string) => new TwoTaskExecutor(root, tokensPerCall) } : {}),
  });
  cleanups.push(made.dispose);
  return made;
}

async function drive(made: ReturnType<typeof fixture>, runId: string) {
  for (let i = 0; i < 12; i++) {
    const run = await made.service.get(runId);
    if (run.status === "blocked" || run.status === "completed") return run;
    if (run.pendingRequestIds.length) await made.approve(runId);
    else if (run.status === "paused" || run.status === "created") await made.resume(runId);
    await made.service.drive(runId, new AbortController().signal);
  }
  return made.service.get(runId);
}

const assume = (sizing: NonNullable<RunPolicy["sizing"]>): RunPolicy => ({
  ...fixturePolicy,
  clarification: "assume",
  maxTotalTokens: 300_000,
  sizing,
});

describe("scenario: a plan priced above the run's ceiling (#974)", () => {
  test("the approval says the plan needs more than the ceiling and where the run should stop", async () => {
    // Review and convergence alone are priced at 210k; the plan and its reserve need more than 220k.
    const made = fixture({ ...assume({ maxRunTokens: 220_000 }), maxTotalTokens: 100_000 });
    const run = await made.start();
    await made.service.drive(run.runId, new AbortController().signal);
    const { store } = made.service;
    const approval = store.requests(run.runId).find((r) => r.kind === "approval");
    if (!approval) throw new Error("No approval request");
    const body = JSON.parse(approval.body_json) as { budgetWarning?: string };
    expect(body.budgetWarning).toMatch(
      /^Plan and reserve need \d+ tokens, ceiling is 220000; the run is expected to stop at about 0 of 1 tasks unless it grows on progress, up to 330000$/,
    );
    const sizing = store
      .artifacts(run.runId)
      .filter((a) => a.logical_path.startsWith("sizing/plan-"))
      .map((a) => JSON.parse(store.readArtifact(run.runId, a.id)))
      .at(-1);
    expect(sizing.overCeiling).toMatchObject({
      ceilingTokens: 220_000,
      expectedTasks: 0,
      totalTasks: 1,
      extendToTokens: 330_000,
      warning: body.budgetWarning,
    });
    expect(sizing.reasons).toContain(body.budgetWarning);
  });

  test("a plan within the ceiling has no warning", async () => {
    const made = fixture(assume({ maxRunTokens: 4_000_000 }));
    const run = await made.start();
    await made.service.drive(run.runId, new AbortController().signal);
    const approval = made.service.store.requests(run.runId).find((r) => r.kind === "approval");
    expect(JSON.parse(approval?.body_json ?? "{}").budgetWarning).toBeUndefined();
  });

  test("under assume a run without extendToTokens grows past its ceiling while it makes progress", async () => {
    // Implementation and review each take 500k: the run needs more than its 1M ceiling.
    const heavy = (output: string) =>
      ["implementation", "review", "convergence"].includes(output) ? 500_000 : 50;
    const made = fixture(assume({ maxRunTokens: 1_000_000 }), heavy);
    const run = await made.start();
    const last = await drive(made, run.runId);
    expect(last.status).toBe("completed");
    const { store } = made.service;
    const extensions = store
      .artifacts(run.runId)
      .filter((a) => a.logical_path.startsWith("policy-revisions/auto-"))
      .map((a) => JSON.parse(store.readArtifact(run.runId, a.id)))
      .filter((b) => b.kind === "auto-extend");
    expect(extensions[0]).toMatchObject({ hardCeiling: 1_500_000 });
    expect(JSON.parse(store.run(run.runId).policy_json).maxTotalTokens).toBeLessThanOrEqual(1_500_000);
  });

  test("the default applies only under assume, and an explicit extendToTokens wins", () => {
    const ceiling = { maxRunTokens: 1_000_000 };
    expect(extendToOf(assume(ceiling))).toBe(1_500_000);
    expect(extendToOf(assume({ ...ceiling, extendToTokens: 1_200_000 }))).toBe(1_200_000);
    expect(extendToOf({ ...fixturePolicy, sizing: ceiling })).toBeNull();
    expect(extendToOf(assume({}))).toBeNull();
  });

  test("a run stopped on its budget names the tasks it left unfinished", async () => {
    // Without assume nothing grows past the ceiling; the attempt is refused before it starts.
    const heavy = (output: string) => (output === "implementation" ? 1_200_000 : 50);
    const made = fixture(
      { ...fixturePolicy, maxTotalTokens: 300_000, sizing: { maxRunTokens: 1_000_000 } },
      heavy,
      true,
    );
    const run = await made.start();
    const last = await drive(made, run.runId);
    expect(last).toMatchObject({ status: "blocked", reason: "budget_exhausted" });
    expect(stopDetail(made.service.store, run.runId)).toContain(
      "Stopped on the budget with 1 of 2 tasks unfinished: T002.",
    );
  });
});
