import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { startApiServer } from "../src/core/api/server.js";
import { type RoutingRecord, RoutingRecordSchema } from "../src/core/llm/model-routing.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { readWorkflowView } from "../src/core/workflows/view.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// #2960: a reroute from a provider that hit its usage limit kept the class routes that still named
// that provider, said nothing, and the run blocked again at its first review (R102 tailcut).

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const usageLimit = Object.assign(new Error("You have hit your usage limit."), { statusCode: 429 });

/** Every call on a model in `refused` fails as an account at its usage limit. */
class LimitedExecutor extends FixtureExecutor {
  calls: { output: string; model: string }[] = [];
  refused = new Set<string>();
  override async execute(request: ExecutionRequest) {
    this.calls.push({ output: request.profile.output, model: request.profile.model });
    if (this.refused.has(request.profile.model)) throw usageLimit;
    return super.execute(request);
  }
}

function fixture() {
  const f = workflowFixture({ executor: (root) => new LimitedExecutor(root) });
  cleanups.push(f.dispose);
  // The R102 configuration: the review class names the same provider as the run model.
  f.service.config.modelRouting = { classes: { review: "fixture/model" } };
  return f;
}

const routingOf = (f: ReturnType<typeof fixture>, runId: string): RoutingRecord => {
  const row = f.service.store.latestArtifact(runId, "routing.json");
  if (!row) throw new Error("No routing record");
  return RoutingRecordSchema.parse(JSON.parse(f.service.store.readArtifact(runId, row.id)));
};

/** A run started with an explicit model, blocked when that provider hits its usage limit. */
async function limitedRun(f: ReturnType<typeof fixture>) {
  const run = await f.service.start({
    commandId: newId(),
    featureId: "fixture",
    workflowId: "sdd",
    prompt: "Create ready value",
    ownerLabel: "test",
    policy: f.policy,
    model: "fixture/model",
  });
  await f.service.drive(run.runId, new AbortController().signal);
  await f.approve(run.runId);
  f.executor.refused.add("fixture/model");
  const blocked = await f.service.drive(run.runId, new AbortController().signal);
  expect(blocked.status).toBe("blocked");
  return blocked;
}

const reviewers = (record: RoutingRecord): string[] =>
  Object.entries(record.profiles)
    .filter(([, entry]) => entry.source === "modelRouting.classes.review")
    .map(([id]) => id);

describe("workflow reroute: configured routes on the old model (#2960)", () => {
  test("the reroute warns about class routes it left on the old model and names the stage routes that move them", async () => {
    const f = fixture();
    const blocked = await limitedRun(f);
    const planned = await f.service.planReroute(blocked.runId, { model: "spare/model" });
    if (!planned) throw new Error("No reroute planned");
    expect(planned.after.explicitModel).toBe(true);
    // The review class still names the old model after the reroute.
    expect(reviewers(planned.after).length).toBeGreaterThan(0);
    for (const id of reviewers(planned.after)) expect(planned.after.profiles[id]?.model).toBe("fixture/model");
    const warning = (planned.after.warnings ?? []).find((line) => line.includes("modelRouting.classes.review"));
    expect(warning).toContain("fixture/model");
    expect(warning).toContain("--route review=spare/model");

    // The warning reaches the operator through the stored record the CLI, TUI and API print.
    const rerouted = await f.service.reroute(blocked.runId, { commandId: newId(), expectedRevision: blocked.revision }, { model: "spare/model" });
    expect(rerouted.status).toBe("blocked");
    expect(routingOf(f, blocked.runId).warnings?.some((line) => line.includes("--route review=spare/model"))).toBe(true);
    // The TUI and desktop run views read it from the run view's routing summary.
    expect(readWorkflowView(f.service, blocked.runId).routing?.warnings.some((line) => line.includes("--route review=spare/model"))).toBe(true);
  });

  test("following the warning moves the whole run off the old provider, which then finishes", async () => {
    const f = fixture();
    const blocked = await limitedRun(f);
    const planned = await f.service.planReroute(blocked.runId, { model: "spare/model" });
    const routes = Object.fromEntries(
      (planned?.after.warnings ?? []).flatMap((line) => [...line.matchAll(/--route (\S+)=(\S+?)(?=[ ,.]|$)/g)].map((m) => [m[1], m[2]])),
    );
    expect(routes.review).toBe("spare/model");
    const staged = await f.service.reroute(blocked.runId, { commandId: newId(), expectedRevision: blocked.revision }, { model: "spare/model", routes });
    // The stage routes cover the review stage's profiles; the critic never takes a stage route, so
    // the warning still names it, with its configured route as the only way to move it.
    const left = (routingOf(f, blocked.runId).warnings ?? []).filter((line) => line.includes("applies to the active class only"));
    expect(left).toHaveLength(1);
    expect(left[0]).toContain("critic");
    expect(left[0]).not.toContain("spec-reviewer");
    expect(left[0]).not.toContain("--route");
    expect(left[0]).toContain("set modelRouting.classes.review to spare/model");

    f.service.config.modelRouting = { classes: { review: "spare/model" } };
    const moved = await f.service.reroute(blocked.runId, { commandId: newId(), expectedRevision: staged.revision }, { model: "spare/model" });
    expect((routingOf(f, blocked.runId).warnings ?? []).filter((line) => line.includes("applies to the active class only"))).toEqual([]);
    const before = f.executor.calls.length;
    await f.resume(moved.runId);
    const final = await f.service.drive(moved.runId, new AbortController().signal);
    expect(final.status).toBe("completed");
    expect(f.executor.calls.slice(before).filter((call) => call.model === "fixture/model")).toEqual([]);
  });

  test("the headless CLI prints the warning, and the serve API's run status carries it", async () => {
    const f = fixture();
    const blocked = await limitedRun(f);
    const args = parseWorkflowArgs(["reroute", blocked.runId, "--model", "spare/model", "--expected-revision", String(blocked.revision)]);
    const written: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);
    try {
      await executeWorkflowCommand(f.service, args, new AbortController().signal);
    } finally {
      stderr.mockRestore();
    }
    expect(written.some((line) => line.startsWith("warning: ") && line.includes("--route review=spare/model"))).toBe(true);

    const server = await startApiServer({ service: f.service, pollMs: 20, log: () => undefined });
    cleanups.push(() => server.stop());
    const response = await fetch(`${server.url}/v1/workflow/runs/${blocked.runId}`, { headers: { Authorization: `Bearer ${server.token}` } });
    const status = (await response.json()) as { routing?: { warnings: string[] } };
    expect(status.routing?.warnings.some((line) => line.includes("--route review=spare/model"))).toBe(true);
  });

  test("a run without an explicit model follows its configured routes and gets no such warning", async () => {
    const f = fixture();
    f.executor.refused.add("other/model");
    const run = await f.start();
    await f.service.drive(run.runId, new AbortController().signal);
    const planned = await f.service.planReroute(run.runId, { routes: { review: "spare/model" } });
    expect((planned?.after.warnings ?? []).filter((line) => line.includes("applies to the active class only"))).toEqual([]);
  });
});
