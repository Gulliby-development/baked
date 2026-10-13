import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import {
  calibrateCritic,
  criticExamples,
  outcomeLabel,
  selectAttempt,
} from "../src/core/workflows/critic-calibration.js";
import type { CriticOutcomes } from "../src/core/workflows/critic-outcomes.js";
import { runReport } from "../src/core/workflows/run-report.js";
import type { CriticOutcomeRow, WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const row = (score: number, fields: Partial<CriticOutcomeRow> = {}): CriticOutcomeRow => ({
  run_id: "r",
  task_id: "T001",
  attempt: 1,
  model: null,
  score,
  rubric_json: JSON.stringify({ scope: { score: 0.4, note: "touched a file" } }),
  task_result: "passed",
  acceptance: null,
  delivery: null,
  survival: null,
  survival_final: 0,
  created_at: 0,
  updated_at: 0,
  ...fields,
});
const good = (score: number) => row(score);
const bad = (score: number) => row(score, { task_result: "repaired" });

describe("critic calibration", () => {
  test("labels an attempt by its checks, run end, delivery and final survival", () => {
    expect(outcomeLabel(good(0.5))).toBe("good");
    expect(outcomeLabel(bad(0.5))).toBe("bad");
    expect(outcomeLabel(row(0.5, { acceptance: "rejected" }))).toBe("bad");
    expect(outcomeLabel(row(0.5, { delivery: "reverted" }))).toBe("bad");
    expect(outcomeLabel(row(0.5, { survival: 0.2, survival_final: 1 }))).toBe("bad");
    // Survival so far does not label; neither does an attempt whose checks never ran.
    expect(outcomeLabel(row(0.5, { survival: 0.2 }))).toBe("good");
    expect(outcomeLabel(row(0.5, { task_result: null }))).toBeNull();
  });

  test("needs enough attempts of both labels and scores that separate them", () => {
    const few = calibrateCritic([good(0.9), bad(0.2)]);
    expect(few).toMatchObject({ calibrated: false, threshold: null, auc: 1 });
    expect(few.reason).toContain("2 of 20");
    const oneSided = calibrateCritic(Array.from({ length: 20 }, () => good(0.9)));
    expect(oneSided.reason).toContain("(20 and 0)");
    const random = calibrateCritic([
      ...Array.from({ length: 10 }, (_, i) => good(i / 10)),
      ...Array.from({ length: 10 }, (_, i) => bad(i / 10)),
    ]);
    expect(random).toMatchObject({ calibrated: false, auc: 0.5 });
    expect(random.reason).toContain("AUC 0.50");
  });

  test("picks the threshold with the best Youden index", () => {
    const rows = [
      ...[0.9, 0.85, 0.8, 0.75, 0.7, 0.7, 0.65, 0.6, 0.55, 0.4].map(good),
      ...[0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1].map(bad),
    ];
    const calibration = calibrateCritic(rows);
    expect(calibration).toMatchObject({ samples: 20, good: 10, bad: 10, calibrated: true });
    expect(calibration.auc).toBeGreaterThan(0.9);
    expect(calibration.threshold).toBe(0.55);
  });

  test("examples show the latest attempts of each label with the weakest rubric item", () => {
    const examples = criticExamples([good(0.9), good(0.8), good(0.7), bad(0.3)], 2);
    expect(examples.map((e) => [e.score, e.outcome])).toEqual([
      [0.7, "held up"],
      [0.8, "held up"],
      [0.3, "did not hold up"],
    ]);
    expect(examples[0]?.weakest).toBe("scope 0.40: touched a file");
  });

  test("select keeps the highest-scored attempt and ignores unscored ones", () => {
    expect(selectAttempt([{ id: 1, score: 0.4 }, { id: 2, score: null }, { id: 3, score: 0.8 }])?.id).toBe(3);
    expect(selectAttempt([{ id: 1, score: null }])).toBeNull();
  });
});

/** Scores every attempt 0.72 and has convergence report one medium finding in its first round. */
class EarlyStopExecutor extends FixtureExecutor {
  convergence = 0;
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "critique") {
      const item = (score: number) => ({ score, note: "fine" });
      return {
        output: {
          schemaVersion: 1,
          taskId: request.task?.id ?? "T001",
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
    const result = await super.execute(request);
    if (request.profile.output === "convergence" && this.convergence++ === 0) {
      const output = result.output as {
        coverage: { evidenceIds: string[] }[];
        findings: unknown[];
        verdict: string;
      };
      const evidenceIds = output.coverage[0]?.evidenceIds ?? [];
      result.output = {
        ...output,
        verdict: "changes_requested",
        coverage: output.coverage.map((c) => ({ ...c, verdict: "fail" })),
        findings: [
          {
            id: "F-wording",
            kind: "partial",
            severity: "medium",
            requirementIds: ["FR-001"],
            criterionIds: ["AC-001"],
            file: "value.txt",
            symbol: null,
            evidenceIds: evidenceIds.length ? evidenceIds : ["missing"],
            claim: "The value lacks a trailing newline",
            impact: "Tools that read lines may miss it",
            suggestedFix: "Add a newline",
          },
        ],
      };
    }
    return result;
  }
}

/** Earlier runs of the project: scores at 0.7 and above held up, those below did not. */
function seedOutcomes(store: WorkflowStore) {
  const scores = [
    ...[0.95, 0.9, 0.85, 0.8, 0.8, 0.75, 0.75, 0.7, 0.7, 0.7].map((s) => [s, "passed"] as const),
    ...[0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.1].map((s) => [s, "repaired"] as const),
  ];
  scores.forEach(([score, result], i) => {
    store.recordCriticScore(`earlier-${String(i)}`, "T001", 1, null, score, {});
    store.criticTaskResult(`earlier-${String(i)}`, "T001", result);
  });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

async function earlyStopRun(seed: boolean) {
  const policy = { ...fixturePolicy, critic: "earlyStop" as const };
  const fx = workflowFixture({ policy, executor: (root) => new EarlyStopExecutor(root) });
  cleanups.push(() => fx.dispose());
  if (seed) seedOutcomes(fx.service.store);
  const started = await fx.start();
  await fx.service.drive(started.runId, signal());
  await fx.approve(started.runId);
  const final = await fx.service.drive(started.runId, signal());
  return { fx, runId: started.runId, final };
}

describe("critic earlyStop", () => {
  test("a calibrated critic accepts a passing run's remaining findings instead of a repair", async () => {
    const { fx, runId, final } = await earlyStopRun(true);
    expect(final.status).toBe("completed");
    const store = fx.service.store;
    expect(store.latestArtifact(runId, "critic/calibration.json")).not.toBeNull();
    const stop = store.artifacts(runId).find((a) => a.kind === "critic-early-stop");
    expect(stop).toBeDefined();
    const body = JSON.parse(store.readArtifact(runId, stop?.id ?? "")) as {
      threshold: number;
      scores: Record<string, number>;
    };
    expect(body.threshold).toBe(0.7);
    expect(body.scores).toEqual({ T001: 0.72 });
    // No repair task ran: the only implementation is the planned one.
    expect(fx.executor.prompts.implementation).toHaveLength(1);
    expect(runReport(store, runId)).toContain("critic early stop");
  }, 120000);

  test("without a calibration the critic only advises and the finding goes to a repair", async () => {
    const { fx, runId } = await earlyStopRun(false);
    const store = fx.service.store;
    expect(store.artifacts(runId).some((a) => a.kind === "critic-early-stop")).toBe(false);
    expect(store.tasks(runId).some((t) => t.task_id !== "T001")).toBe(true);
  }, 120000);
});

describe("critic outcomes over the local API", () => {
  test("GET /v1/workflow/critic returns the log and its calibration", async () => {
    const fixture = workflowFixture();
    const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
    const homeDir = mkdtempSync(join(tmpdir(), "baked-api-home-"));
    const server = await startApiServer({
      service: fixture.service,
      pollMs: 20,
      configDir,
      homeDir,
      log: () => {},
    });
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
      await removeTempDir(configDir);
      await removeTempDir(homeDir);
    });
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${server.token}` },
      });
    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("critic-outcomes");
    seedOutcomes(fixture.service.store);
    const view = (await (await call("/v1/workflow/critic")).json()) as CriticOutcomes;
    expect(view.summary.scored).toBe(20);
    expect(view.calibration).toMatchObject({ calibrated: true, threshold: 0.7, auc: 1 });
    const one = (await (await call("/v1/workflow/critic?runId=earlier-0")).json()) as CriticOutcomes;
    expect(one.criticOutcomes).toHaveLength(1);
    expect(one.calibration.samples).toBe(20);
    expect((await call("/v1/workflow/critic", { method: "POST" })).status).toBe(405);
  });
});
