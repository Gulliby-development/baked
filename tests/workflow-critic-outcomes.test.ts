import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "../src/core/specs/hash.js";
import {
  addedLines,
  criticOutcomesView,
  formatCriticOutcomes,
  lineSurvival,
  refreshCriticOutcomes,
  SURVIVAL_DAYS,
} from "../src/core/workflows/critic-outcomes.js";
import { git } from "../src/core/workflows/delivery-git.js";
import { runReport } from "../src/core/workflows/run-report.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

class CriticExecutor extends FixtureExecutor {
  override async execute(request: ExecutionRequest) {
    if (request.profile.output !== "critique") return super.execute(request);
    const item = (score: number) => ({ score, note: "fine" });
    return {
      output: {
        schemaVersion: 1,
        taskId: "T001",
        score: 0.72,
        rubric: {
          intent: item(0.9),
          instructions: item(0.8),
          scope: item(0.95),
          testIntegrity: item(0.6),
          completeness: item(0.85),
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
const DAY = 24 * 60 * 60 * 1000;

async function scoredRun() {
  const policy = { ...fixturePolicy, critic: "advise" as const };
  const fx = workflowFixture({ policy, executor: (root) => new CriticExecutor(root) });
  cleanups.push(() => fx.dispose());
  const started = await fx.start();
  await fx.service.drive(started.runId, new AbortController().signal);
  await fx.approve(started.runId);
  const done = await fx.service.drive(started.runId, new AbortController().signal);
  expect(done.status).toBe("completed");
  return { fx, runId: started.runId };
}

describe("line survival", () => {
  test("counts the non-blank lines a patch adds that the files still hold", () => {
    const added = addedLines(
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,3 @@\n-old\n+const a = 1;\n+\n+export { a };\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x",
    );
    expect([...added.entries()]).toEqual([["src/a.ts", ["const a = 1;", "export { a };"]]]);
    expect(lineSurvival(added, () => "  const a = 1;\nexport const b = 2;")).toBe(0.5);
    expect(lineSurvival(added, () => null)).toBe(0);
    expect(lineSurvival(new Map(), () => "")).toBeNull();
  });
});

describe("critic outcome log", () => {
  test("a score is labelled by its task checks, the run's end and line survival", async () => {
    const { fx, runId } = await scoredRun();
    let [row] = fx.service.store.criticOutcomes(runId);
    expect(row).toMatchObject({
      task_id: "T001",
      attempt: 1,
      score: 0.72,
      task_result: "passed",
      acceptance: "accepted",
      survival: null,
    });

    // Survival so far, then final after the survival window; a final value no longer changes.
    await refreshCriticOutcomes(fx.service.store);
    [row] = fx.service.store.criticOutcomes(runId);
    expect(row).toMatchObject({ survival: 1, survival_final: 0 });
    writeFileSync(join(fx.root, "value.txt"), "rewritten");
    await refreshCriticOutcomes(fx.service.store, Date.now() + (SURVIVAL_DAYS + 1) * DAY);
    writeFileSync(join(fx.root, "value.txt"), "ready");
    await refreshCriticOutcomes(fx.service.store, Date.now() + (SURVIVAL_DAYS + 2) * DAY);
    [row] = fx.service.store.criticOutcomes(runId);
    expect(row).toMatchObject({ survival: 0, survival_final: 1 });

    const view = criticOutcomesView(fx.service.store);
    expect(view.summary).toMatchObject({
      scored: 1,
      passed: { count: 1, meanScore: 0.72 },
      accepted: 1,
      meanSurvival: 0,
    });
    expect(formatCriticOutcomes(view)).toContain("T001");
    expect(runReport(fx.service.store, runId)).toContain("checks passed, accepted");
  }, 120000);

  test("a delivered commit is merged once its branch holds it, reverted once reverted", async () => {
    const { fx, runId } = await scoredRun();
    const run = (args: string[]) => git(fx.root, args);
    await run(["init", "-q", "-b", "main"]);
    await run(["-c", "user.name=t", "-c", "user.email=t@example.com", "add", "value.txt"]);
    await run(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "value"]);
    const commit = (await run(["rev-parse", "HEAD"])).stdout.trim();
    fx.service.store.transaction(() => {
      fx.service.store.artifact(
        runId,
        "delivery-plan",
        "delivery/p1/plan.json",
        canonical({ base: { branch: "main", commit } }),
      );
      fx.service.store.artifact(
        runId,
        "delivery",
        "delivery/p1/result.json",
        canonical({ planId: "p1", commit }),
      );
    });
    await refreshCriticOutcomes(fx.service.store);
    expect(fx.service.store.criticOutcomes(runId)[0]?.delivery).toBe("merged");
    await run([
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "revert",
      "--no-edit",
      commit,
    ]);
    await refreshCriticOutcomes(fx.service.store);
    expect(fx.service.store.criticOutcomes(runId)[0]?.delivery).toBe("reverted");
  }, 120000);
});
