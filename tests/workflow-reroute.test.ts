import { afterEach, describe, expect, test } from "bun:test";
import { startApiServer } from "../src/core/api/server.js";
import { type RoutingRecord, RoutingRecordSchema } from "../src/core/llm/model-routing.js";
import { rerouteRecord, routeChanges } from "../src/core/workflows/routing.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const noCredits = Object.assign(new Error("You have no credits remaining. Add credits to continue."), { statusCode: 429 });

/** The fixture flow, with every call on `refused` failing as an account without credits. */
class RefusingExecutor extends FixtureExecutor {
  models: { output: string; model: string }[] = [];
  refused = new Set<string>();
  override async execute(request: ExecutionRequest) {
    this.models.push({ output: request.profile.output, model: request.profile.model });
    if (this.refused.has(request.profile.model) && request.profile.output === "implementation") throw noCredits;
    return super.execute(request);
  }
}

function fixture() {
  const f = workflowFixture({ executor: (root) => new RefusingExecutor(root) });
  cleanups.push(f.dispose);
  return f;
}

const routingOf = (service: ReturnType<typeof workflowFixture>["service"], runId: string): RoutingRecord => {
  const row = service.store.latestArtifact(runId, "routing.json");
  if (!row) throw new Error("No routing record");
  return RoutingRecordSchema.parse(JSON.parse(service.store.readArtifact(runId, row.id)));
};

async function blockedRun(f: ReturnType<typeof fixture>) {
  f.executor.refused.add("fixture/model");
  const run = await f.start();
  await f.service.drive(run.runId, new AbortController().signal);
  await f.approve(run.runId);
  const blocked = await f.service.drive(run.runId, new AbortController().signal);
  expect(blocked.status).toBe("blocked");
  expect(blocked.reason).toBe("provider_account");
  return blocked;
}

describe("workflow reroute", () => {
  test("a run blocked by its provider continues on another model and keeps finished work", async () => {
    const f = fixture();
    const blocked = await blockedRun(f);
    const before = f.executor.models.length;
    const rerouted = await f.service.reroute(blocked.runId, { commandId: newId(), expectedRevision: blocked.revision }, { model: "spare/model" });
    expect(rerouted.status).toBe("blocked");
    const record = routingOf(f.service, blocked.runId);
    expect(record.runModel).toBe("spare/model");
    expect(record.profiles.implementer?.model).toBe("spare/model");
    expect(f.service.store.latestArtifact(blocked.runId, "routing.json")?.revision).toBe(2);
    const event = f.service.store.events(blocked.runId).find((e) => e.type === "run.rerouted");
    expect(event?.type === "run.rerouted" && event.payload.runModel).toEqual({ from: "fixture/model", to: "spare/model" });
    expect(event?.type === "run.rerouted" && event.payload.changes.some((c) => c.target === "profile implementer")).toBe(true);

    await f.resume(blocked.runId);
    const final = await f.service.drive(blocked.runId, new AbortController().signal);
    expect(final.status).toBe("completed");
    const after = f.executor.models.slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((call) => call.model === "spare/model")).toBe(true);
    // Research, spec, plan and analysis ran once, before the switch.
    expect(after.some((call) => ["research", "spec", "plan", "analysis"].includes(call.output))).toBe(false);
  });

  test("refuses a running or finished run, and a switch that changes nothing", async () => {
    const f = fixture();
    const blocked = await blockedRun(f);
    const command = () => ({ commandId: newId(), expectedRevision: f.service.store.run(blocked.runId).revision });
    await expect(f.service.reroute(blocked.runId, command(), { model: "fixture/model" })).rejects.toThrow("already uses these models");
    await expect(f.service.reroute(blocked.runId, command(), {})).rejects.toThrow("Name a model");
    f.service.store.transition(blocked.runId, "running");
    await expect(f.service.reroute(blocked.runId, command(), { model: "spare/model" })).rejects.toThrow("pause it");
    f.service.store.transition(blocked.runId, "cancelled");
    await expect(f.service.reroute(blocked.runId, command(), { model: "spare/model" })).rejects.toThrow("Terminal runs");
  });

  test("a repeated command returns the first result", async () => {
    const f = fixture();
    const blocked = await blockedRun(f);
    const command = { commandId: newId(), expectedRevision: blocked.revision };
    const first = await f.service.reroute(blocked.runId, command, { model: "spare/model" });
    const again = await f.service.reroute(blocked.runId, command, { model: "spare/model" });
    expect(again.revision).toBe(first.revision);
    expect(f.service.store.events(blocked.runId).filter((e) => e.type === "run.rerouted")).toHaveLength(1);
  });

  test("independentReview require refuses a switch that puts reviews on the implementation model", async () => {
    const f = fixture();
    const blocked = await blockedRun(f);
    f.service.config.modelRouting = { roles: { reviewer: "review/model" }, independentReview: "require" };
    await expect(
      f.service.reroute(blocked.runId, { commandId: newId(), expectedRevision: blocked.revision }, { model: "spare/model", routes: { review: "spare/model" } }),
    ).rejects.toThrow("independentReview");
  });

  test("start routes stay, and one on the old run model moves", () => {
    const previous: RoutingRecord = {
      schemaVersion: 1,
      runModel: "old/model",
      profiles: { implementer: { model: "old/model", source: "run model" }, ghost: { model: "old/model", source: "profile ghost" } },
      stages: {
        plan: { model: "old/model", source: "route override plan" },
        review: { model: "other/model", source: "route override review" },
      },
    };
    const next = rerouteRecord(process.cwd(), { defaultModel: "old/model" } as never, previous, "sdd", ["research", "plan", "review"], ["implementer", "ghost"], { model: "new/model" });
    expect(next.runModel).toBe("new/model");
    expect(next.stages.plan?.model).toBe("new/model");
    expect(next.stages.review?.model).toBe("other/model");
    expect(next.profiles.implementer?.model).toBe("new/model");
    expect(next.profiles.ghost?.model).toBe("new/model");
    expect(routeChanges(previous, next).map((c) => c.target)).toEqual(["stage plan", "profile ghost", "profile implementer"]);
  });

  test("CLI and API accept reroute", async () => {
    const parsed = parseWorkflowArgs(["reroute", "RUN", "--model", "a/b", "--route", "review=c/d", "--expected-revision", "3", "--resume"]);
    expect(parsed.flags).toMatchObject({ model: "a/b", route: "review=c/d", resume: true });
    expect(() => parseWorkflowArgs(["reroute", "RUN", "--expected-revision", "3", "--events"])).toThrow("--resume");

    const f = fixture();
    const blocked = await blockedRun(f);
    const server = await startApiServer({ service: f.service, pollMs: 20, log: () => undefined });
    cleanups.push(() => server.stop());
    const response = await fetch(`${server.url}/v1/workflow/runs/${blocked.runId}/reroute`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: newId(), expectedRevision: blocked.revision, model: "spare/model" }),
    });
    expect(response.status).toBe(200);
    expect(routingOf(f.service, blocked.runId).runModel).toBe("spare/model");
  });
});
