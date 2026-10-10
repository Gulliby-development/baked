import { describe, expect, test } from "bun:test";
import type { ArtifactRow, AttemptRow, StepRow, WorkflowStore } from "../src/core/workflows/store.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { runUsage } from "../src/core/workflows/usage.js";
import { parseWorkflowArgs, workflowHelp } from "../src/headless/workflow-parse.js";

const runId = "run-1";

function expectInvalidDefinition(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code: "INVALID_DEFINITION" });
    return;
  }
  throw new Error("Expected an INVALID_DEFINITION error");
}

function makeAttempt(id: string, usedTokens: number | null): AttemptRow {
  return {
    id,
    step_id: `step-${id}`,
    status: "completed",
    reserved_tokens: 0,
    used_tokens: usedTokens,
    usage_complete: usedTokens === null ? 0 : 1,
    input_hash: "input-hash",
  };
}

function makeUsage(steps: AttemptUsageRecord["steps"]): AttemptUsageRecord {
  return {
    schemaVersion: 1,
    profileId: "implementer",
    taskId: null,
    maxSteps: 10,
    maxTokens: 1000,
    stopReason: "submitted",
    finalizedBy: null,
    totalTokens: 0,
    steps,
  };
}

function makeStore(
  attempts: AttemptRow[],
  usageByAttempt: Map<string, AttemptUsageRecord> = new Map(),
  stageByAttempt: Map<string, string> = new Map(),
): WorkflowStore {
  const steps: StepRow[] = attempts.map((attempt) => ({
    id: attempt.step_id,
    stage_id: stageByAttempt.get(attempt.id) ?? "implementation",
    parent_step_id: null,
    generation: 0,
    status: "completed",
  }));
  const artifacts = new Map<string, ArtifactRow>();
  const contents = new Map<string, string>();
  for (const [attemptId, usage] of usageByAttempt) {
    const path = `attempts/${attemptId}/usage.json`;
    const id = `artifact-${attemptId}`;
    const content = JSON.stringify(usage);
    artifacts.set(path, {
      run_id: runId,
      id,
      kind: "usage",
      logical_path: path,
      revision: 1,
      content_hash: "fixture-hash",
      byte_length: Buffer.byteLength(content),
      inline_content: content,
      blob_path: null,
    });
    contents.set(id, content);
  }
  return {
    steps: () => steps,
    attempts: () => attempts,
    latestArtifact: (_id, path) => artifacts.get(path) ?? null,
    readArtifact: (_id, id) => {
      const content = contents.get(id);
      if (content === undefined) throw new Error(`Missing fixture artifact ${id}`);
      return content;
    },
  } as unknown as WorkflowStore;
}

describe("runUsage totals", () => {
  test("accepts stage and positive top values for usage arguments", () => {
    expect(parseWorkflowArgs(["usage", runId, "--stage", "planning", "--top", "2"])).toMatchObject({
      command: "usage",
      positional: [runId],
      flags: { stage: "planning", top: "2" },
    });
    expect(() => parseWorkflowArgs(["usage", runId, "--stage"])).toThrow();
      expect(workflowHelp).toContain("usage RUN_ID [--stage NAME] [--top N]");
  });

  test("rejects missing or invalid top values and top on other commands", () => {
    for (const argv of [
      ["usage", runId, "--top"],
      ["usage", runId, "--top", "1.5"],
      ["usage", runId, "--top", "0"],
      ["usage", runId, "--top", "-1"],
    ])
      expectInvalidDefinition(() => parseWorkflowArgs(argv));
    expectInvalidDefinition(() => parseWorkflowArgs(["status", runId, "--top", "2"]));
    expect(() => parseWorkflowArgs(["usage", runId, "--top", "0"])).toThrow(
      "--top requires a positive integer",
    );
  });

  test("limits only attempts and preserves full-run aggregates", () => {
    const store = makeStore([
      makeAttempt("low", 5),
      makeAttempt("high", 15),
      makeAttempt("middle", 7),
    ]);

    const report = runUsage(store, runId, undefined, 2);

    expect(report.attempts.map(({ attemptId, usedTokens }) => ({ attemptId, usedTokens }))).toEqual([
      { attemptId: "high", usedTokens: 15 },
      { attemptId: "middle", usedTokens: 7 },
    ]);
    expect(report.stages).toEqual([{ stage: "implementation", attempts: 3, tokens: 27, steps: null }]);
    expect(report.totalTokens).toBe(27);
    expect(report.totals.tokens).toBe(27);
  });

  test("returns all attempts in descending order when top exceeds the count", () => {
    const store = makeStore([makeAttempt("low", 5), makeAttempt("high", 15)]);

    const report = runUsage(store, runId, undefined, 5);

    expect(report.attempts.map(({ attemptId }) => attemptId)).toEqual(["high", "low"]);
    expect(report.stages[0]).toMatchObject({ attempts: 2, tokens: 20 });
    expect(report.totalTokens).toBe(20);
  });

  test("filters attempts and totals to the selected stage", () => {
    const first = makeAttempt("first", 7);
    const second = makeAttempt("second", 5);
    const usage = new Map([
      [
        "first",
          makeUsage([
            {
              inputTokens: 10,
              outputTokens: 4,
              cacheReadTokens: 3,
            toolCalls: 0,
            compactedBytes: 8,
          },
        ]),
      ],
      [
        "second",
        makeUsage([
          {
            inputTokens: 20,
            outputTokens: 6,
            cacheReadTokens: 9,
            toolCalls: 1,
            compactedBytes: 12,
          },
        ]),
      ],
    ]);
    const store = makeStore(
      [first, second],
      usage,
      new Map([
        ["first", "planning"],
        ["second", "review"],
      ]),
    );

    const report = runUsage(store, runId, "planning");

    expect(report.stages).toEqual([{ stage: "planning", attempts: 1, tokens: 7, steps: 1 }]);
    expect(report.attempts.map((attempt) => attempt.attemptId)).toEqual(["first"]);
    expect(report.totalTokens).toBe(7);
    expect(report.totals).toEqual({
      tokens: 7,
      steps: 1,
      cacheReadTokens: 3,
      compactedBytes: 8,
    });
  });

  test("returns existing empty-report totals when no attempts match a stage", () => {
    const store = makeStore([makeAttempt("first", 7)]);

    const report = runUsage(store, runId, "missing-stage");

    expect(report.stages).toEqual([]);
    expect(report.attempts).toEqual([]);
    expect(report.totalTokens).toBe(0);
    expect(report.totals).toEqual({
      tokens: null,
      steps: null,
      cacheReadTokens: null,
      compactedBytes: null,
    });
  });

  test("aggregates artifact-backed usage and excludes attempts without usage artifacts", () => {
    const first = makeAttempt("first", 7);
    const second = makeAttempt("second", 5);
    const store = makeStore(
      [first, second],
        new Map([
        [
            "first",
            makeUsage([
            { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, toolCalls: 0, compactedBytes: 8 },
            { inputTokens: 12, outputTokens: 6, cacheReadTokens: 2, toolCalls: 1, compactedBytes: 4 },
          ]),
        ],
      ]),
    );

    const report = runUsage(store, runId);

    expect(report.totals).toEqual({
      tokens: 12,
      steps: 2,
      cacheReadTokens: 5,
      compactedBytes: 12,
    });
    expect(report.attempts.map(({ steps, cacheReadTokens, compactedBytes }) => ({
      steps,
      cacheReadTokens,
      compactedBytes,
    }))).toEqual([
      { steps: 2, cacheReadTokens: 5, compactedBytes: 12 },
      { steps: null, cacheReadTokens: null, compactedBytes: null },
    ]);
    expect(report.totalTokens).toBe(12);
  });

  test("keeps reported zero numeric while null-only fields remain null", () => {
    const reportedZero = makeAttempt("zero", 0);
    const noUsage = makeAttempt("missing", null);
    const store = makeStore(
      [reportedZero, noUsage],
        new Map([["zero", makeUsage([])]]),
    );

    const report = runUsage(store, runId);

    expect(report.totals).toEqual({
      tokens: 0,
      steps: 0,
      cacheReadTokens: 0,
      compactedBytes: 0,
    });
    expect(report.totalTokens).toBe(0);
  });

  test("returns null when no attempt reports a total and preserves totalTokens zero fallback", () => {
    const store = makeStore([makeAttempt("missing", null)]);

    const report = runUsage(store, runId);

    expect(report.totals).toEqual({
      tokens: null,
      steps: null,
      cacheReadTokens: null,
      compactedBytes: null,
    });
    expect(report.totalTokens).toBe(0);
  });
});
