import { afterEach, describe, expect, test } from "bun:test";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// R65 seqmill-update (#2036): a quick run's plan priced split-tasks in sizing/plan-0.json and went
// to approval unsplit. The replan back to the planner ran only for v1 definitions (sdd); every v2
// preset skipped it.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const code = ["src/sim.ts", "src/rates.ts", "src/main.ts"];

/** The first plan has one task writing three code files; every later plan has one task per file. */
class SplitExecutor extends FixtureExecutor {
  plans = 0;
  prompts: string[] = [];
  constructor(
    root: string,
    private stop: AbortController,
  ) {
    super(root);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "implementation") {
      // Approval is the assertion boundary.
      this.stop.abort();
      throw new DOMException("Stopped after approval", "AbortError");
    }
    const out = await super.execute(request);
    if (request.profile.output === "plan") {
      this.plans++;
      this.prompts.push(request.prompt);
      const graph = (out.output as { taskGraph: TaskGraph }).taskGraph;
      const [first] = graph.tasks;
      if (!first) throw new Error("fixture plan has no task");
      const writes = (paths: string[]) => paths.map((path) => ({ path, action: "create" as const }));
      graph.tasks =
        this.plans === 1
          ? [{ ...first, writes: writes(code) }]
          : code.map((path, i) => ({
              ...first,
              id: `T${String(i + 1).padStart(3, "0")}`,
              title: `Create ${path}`,
              writes: writes([path]),
            }));
    }
    return out;
  }
}

async function sized(workflowId: "quick" | "standard" | "sdd", extra: Partial<RunPolicy> = {}) {
  const stop = new AbortController();
  const policy: RunPolicy = {
    ...fixturePolicy,
    clarification: "assume",
    sizing: { maxAttemptTokens: 10_000 },
    ...extra,
  };
  const fixture = workflowFixture({ policy, executor: (root) => new SplitExecutor(root, stop) });
  cleanups.push(fixture.dispose);
  const { service } = fixture;
  const run = await service.start({
    commandId: newId(),
    featureId: "fixture",
    workflowId,
    prompt: "Create the simulator",
    ownerLabel: "test",
    policy,
  });
  let current = await service.drive(run.runId, stop.signal).catch(() => service.store.run(run.runId));
  for (let i = 0; i < 5 && current.status === "waiting" && !stop.signal.aborted; i++) {
    const pending = service.store.requests(run.runId).find((r) => r.status === "pending");
    if (pending?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await service.drive(run.runId, stop.signal).catch(() => service.store.run(run.runId));
  }
  const store = service.store;
  const report = (path: string) => {
    const artifact = store.latestArtifact(run.runId, path);
    return artifact ? (JSON.parse(store.readArtifact(run.runId, artifact.id)) as { decision: string }) : null;
  };
  return { fixture, store, runId: run.runId, report };
}

describe("scenario: sizing sends an oversized plan back to the planner on v2 definitions (#2036)", () => {
  for (const workflowId of ["quick", "standard", "sdd"] as const) {
    test(`${workflowId}: split-tasks replans once and approval sees the split plan`, async () => {
      const { fixture, store, runId, report } = await sized(workflowId);
      expect(report("sizing/plan-0.json")?.decision).toBe("split-tasks");
      expect(fixture.executor.plans).toBe(2);
      expect(fixture.executor.prompts[1]).toContain("Keep each code task to at most");
      expect(report("sizing/plan-1.json")?.decision).not.toBe("split-tasks");
      const state = store.state(runId);
      expect(state.sizingReplans).toBe(1);
      expect(state.graph?.tasks.map((t) => t.writes.map((w) => w.path))).toEqual(code.map((p) => [p]));
    }, 60_000);
  }
  test("quick: a plan above the run ceiling asks once, naming the sizing report it was priced in", async () => {
    const { fixture, store, runId } = await sized("quick", {
      clarification: "ask",
      sizing: { maxAttemptTokens: 10_000, maxRunTokens: 10_000 },
    });
    expect(fixture.executor.plans).toBe(2);
    const ask = store.requests(runId).find((r) => r.kind === "clarification");
    const body = JSON.parse(ask?.body_json ?? "{}") as { findings?: { id: string; refs: string[] }[] };
    const sizing = body.findings?.find((f) => f.id === "SIZING-1");
    const ref = sizing?.refs.find((r) => r.startsWith("sizing/"));
    expect(ref).toBeDefined();
    expect(store.latestArtifact(runId, ref ?? "")).toBeDefined();
  }, 60_000);
});
