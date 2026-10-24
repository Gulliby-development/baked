import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { AttemptStepController, MIN_ATTEMPT_STEPS, type StepUsageLike } from "../src/core/workflows/step-budget.js";
import { openTrace } from "../src/core/workflows/trace.js";

// #1987: the attempt cap's step floor on the recorded rounds. Each model attempt's `usage.json`
// keeps its steps' tokens and its sized cap, so the floor the attempt had can be recomputed.
const ROOT = join(import.meta.dir, "fixtures", "bench-traces");

interface RecordedStep {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}
interface Recorded {
  round: string;
  app: string;
  taskId: string | null;
  maxSteps: number;
  maxTokens: number;
  ceilingTokens?: number;
  finalizedBy: string | null;
  steps: { usage: StepUsageLike }[];
}

function recordedAttempts(): Recorded[] {
  const out: Recorded[] = [];
  for (const round of readdirSync(ROOT).filter((r) => /^R\d+$/.test(r)).sort())
    for (const file of readdirSync(join(ROOT, round)).filter((f) => f.endsWith(".sqlite.gz"))) {
      const trace = openTrace(join(ROOT, round, file));
      try {
        for (const { id } of trace.store.connection.query("SELECT id FROM runs").all() as { id: string }[])
          for (const artifact of trace.store.artifacts(id)) {
            if (artifact.kind !== "usage" || !artifact.logical_path.startsWith("attempts/")) continue;
            const usage = JSON.parse(trace.store.readArtifact(id, artifact.id)) as {
              taskId?: string | null; maxSteps?: number; maxTokens?: number; ceilingTokens?: number;
              finalizedBy?: string | null; steps?: RecordedStep[];
            };
            if (!usage.steps?.length || !usage.maxTokens || !usage.maxSteps) continue;
            out.push({
              round,
              app: file.replace(".sqlite.gz", ""),
              taskId: usage.taskId ?? null,
              maxSteps: usage.maxSteps,
              maxTokens: usage.maxTokens,
              ...(usage.ceilingTokens !== undefined ? { ceilingTokens: usage.ceilingTokens } : {}),
              finalizedBy: usage.finalizedBy ?? null,
              steps: usage.steps.map((s) => ({
                usage: {
                  inputTokens: s.inputTokens ?? 0,
                  outputTokens: s.outputTokens ?? 0,
                  inputTokenDetails: { cacheReadTokens: s.cacheReadTokens ?? 0 },
                },
              })),
            });
          }
      } finally {
        trace.dispose();
      }
    }
  return out;
}

/** The two caps the attempt had after its steps, with the floor counting every step as before. */
function caps(attempt: Recorded, perRequest: boolean) {
  const controller = new AttemptStepController({
    maxSteps: attempt.maxSteps,
    maxTokens: attempt.maxTokens,
    minSteps: Math.min(attempt.maxSteps, MIN_ATTEMPT_STEPS),
    ...(attempt.ceilingTokens !== undefined ? { ceilingTokens: attempt.ceilingTokens } : {}),
    submitTools: ["submit_result"],
    fallbackStepTokens: 0,
  });
  // A step with a missing record counts as a reported step in both readings.
  const steps = perRequest ? attempt.steps : attempt.steps.map((s) => ({ usage: { ...s.usage, inputTokens: s.usage.inputTokens || 0.000001 } }));
  return { tokens: controller.tokenCap(steps), all: controller.allTokensCap(steps) };
}

describe("attempt step floor on the recorded rounds (#1987)", () => {
  const attempts = recordedAttempts();

  test("counting model requests never lowers a recorded attempt's caps", () => {
    expect(attempts.length).toBeGreaterThan(500);
    for (const attempt of attempts) {
      const before = caps(attempt, false);
      const after = caps(attempt, true);
      expect(after.tokens).toBeGreaterThanOrEqual(before.tokens);
      expect(after.all).toBeGreaterThanOrEqual(before.all);
    }
  }, 120000);

  test("R63 md-site T012's first corrective attempt gets room for ten model requests", () => {
    // 10 steps, 7 requests of about 110k tokens: the floor priced 10 steps at 76k, and the attempt
    // stopped at 764k without a submission; its continuation re-read the project for 1.36M.
    const stopped = attempts.find((a) => a.round === "R63" && a.app === "md-site" && a.taskId === "T012" && a.finalizedBy === "tokens");
    expect(stopped).toBeDefined();
    const before = caps(stopped!, false);
    const after = caps(stopped!, true);
    const consumed = stopped!.steps.reduce((sum, s) => sum + (s.usage.inputTokens ?? 0) + (s.usage.outputTokens ?? 0), 0);
    expect(before.all).toBeLessThanOrEqual(consumed + 1);
    expect(after.all).toBeGreaterThan(consumed * 1.3);
  }, 120000);
});
