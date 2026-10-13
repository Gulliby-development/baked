import { afterEach, describe, expect, test } from "bun:test";
import { runReport } from "../src/core/workflows/run-report.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

class CriticExecutor extends FixtureExecutor {
  critiques: ExecutionRequest[] = [];
  constructor(
    root: string,
    private fail = false,
  ) {
    super(root);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output !== "critique") return super.execute(request);
    this.calls.push("critique");
    this.critiques.push(request);
    if (this.fail) throw new Error("critic unavailable");
    const item = (score: number, note: string) => ({ score, note });
    return {
      output: {
        schemaVersion: 1,
        taskId: "T001",
        score: 0.72,
        rubric: {
          intent: item(0.9, "Writes the value the task asks for"),
          instructions: item(0.8, "Follows the plan"),
          scope: item(0.95, "Only value.txt changes"),
          testIntegrity: item(0.6, "No test covers the value"),
          completeness: item(0.85, "Task is done"),
        },
        summary: "A small, focused change",
      },
      inputTokens: 10,
      outputTokens: 10,
    };
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function run(policy: RunPolicy, fail = false) {
  const fx = workflowFixture({ policy, executor: (root) => new CriticExecutor(root, fail) });
  cleanups.push(() => fx.dispose());
  const started = await fx.start();
  await fx.service.drive(started.runId, new AbortController().signal);
  await fx.approve(started.runId);
  const done = await fx.service.drive(started.runId, new AbortController().signal);
  return { fx, runId: started.runId, status: done.status };
}

describe("critic", () => {
  test("advise scores each task attempt; the run report lists the score and the weakest item", async () => {
    const { fx, runId, status } = await run({ ...fixturePolicy, critic: "advise" });
    expect(status).toBe("completed");
    expect(fx.executor.critiques).toHaveLength(1);
    const input = fx.executor.critiques[0]?.prompt ?? "";
    expect(input).toContain("value.txt");
    const stored = fx.service.store.latestArtifact(runId, "tasks/T001/critique.json");
    expect(stored).not.toBeNull();
    const body = JSON.parse(fx.service.store.readArtifact(runId, stored?.id ?? "")) as {
      attempt: number;
      critique: { score: number };
    };
    expect(body).toMatchObject({ attempt: 1, critique: { score: 0.72 } });
    const report = runReport(fx.service.store, runId);
    expect(report).toContain("## Critic");
    expect(report).toContain("| T001 | 1 | 0.72 | testIntegrity 0.60: No test covers the value |");
  }, 60000);

  test("without a setting the critic stays off when it would share the implementation's vendor", async () => {
    const { fx, status } = await run(fixturePolicy);
    expect(status).toBe("completed");
    expect(fx.executor.critiques).toHaveLength(0);
  }, 60000);

  test("a critic that fails is recorded and the run goes on", async () => {
    const { fx, runId, status } = await run({ ...fixturePolicy, critic: "advise" }, true);
    expect(status).toBe("completed");
    const stored = fx.service.store.latestArtifact(runId, "tasks/T001/critique.json");
    expect(JSON.parse(fx.service.store.readArtifact(runId, stored?.id ?? ""))).toMatchObject({
      error: "critic unavailable",
    });
    expect(runReport(fx.service.store, runId)).toContain("critic failed: critic unavailable");
  }, 60000);
});
