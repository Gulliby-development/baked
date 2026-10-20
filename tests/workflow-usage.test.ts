import { describe, expect, test } from "bun:test";
import type { ArtifactRow, AttemptRow, StepRow, WorkflowStore } from "../src/core/workflows/store.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { findPricing } from "../src/core/llm/pricing.js";
import { runUsage, toolTokensLine, usageSummary } from "../src/core/workflows/usage.js";
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

function makeAttempt(
  id: string,
  usedTokens: number | null,
  modelId: string | null = "fixture/model",
): AttemptRow {
  return {
    id,
    step_id: `step-${id}`,
    model_id: modelId,
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
    attemptTaskGenerations: () => new Map(),
    latestArtifact: (_id, path) => artifacts.get(path) ?? null,
    latestArtifacts: (_id: string, pattern: string) => [...artifacts.values()].filter((a) => likePath(pattern).test(a.logical_path)),
    readArtifact: (_id, id) => {
      const content = contents.get(id);
      if (content === undefined) throw new Error(`Missing fixture artifact ${id}`);
      return content;
    },
    readArtifactJson: (_id: string, row: ArtifactRow) => JSON.parse(contents.get(row.id) ?? "null"),
  } as unknown as WorkflowStore;
}

describe("runUsage totals", () => {
  test("attributes step tokens to the tools each step called (#750)", () => {
    const step = (input: number, output: number, tools?: string[]) => ({
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: 0,
      toolCalls: tools?.length ?? 0,
      ...(tools ? { tools } : {}),
      compactedBytes: 0,
    });
    const store = makeStore(
      [makeAttempt("review", 1_000), makeAttempt("older", 500)],
      new Map([
        [
          "review",
          makeUsage([
            step(90, 10, ["run_repro"]),
            step(200, 0, ["read", "run_repro"]),
            step(300, 0),
          ]),
        ],
        ["older", makeUsage([{ ...step(400, 100), toolCalls: 2 }])],
      ]),
    );
    const report = runUsage(store, runId);
    expect(report.attempts.find((a) => a.attemptId === "review")?.tools).toEqual([
      { tool: "run_repro", calls: 2, tokens: 200 },
      { tool: "read", calls: 1, tokens: 100 },
    ]);
    // A record written before tool names has its count only, and attributes nothing.
    expect(report.attempts.find((a) => a.attemptId === "older")?.tools).toEqual([]);
    expect(report.tools).toEqual([
      { tool: "run_repro", calls: 2, tokens: 200 },
      { tool: "read", calls: 1, tokens: 100 },
    ]);    expect(toolTokensLine(report.tools)).toBe(
      "run_repro 2 calls 200 tokens, read 1 call 100 tokens",
    );
    expect(toolTokensLine([])).toBeNull();
  });

  test("accepts stage and positive top values for usage arguments", () => {
    expect(
      parseWorkflowArgs([
          "usage",
          runId,
          "--model",
          "fixture/model",
          "--stage",
        "planning",
        "--top",
        "2",
      ]),
      ).toMatchObject({
      command: "usage",
      positional: [runId],
      flags: { model: "fixture/model", stage: "planning", top: "2" },
      });
      expect(() => parseWorkflowArgs(["usage", runId, "--stage"])).toThrow();
      expect(workflowHelp).toContain("usage RUN_ID [--model ID] [--stage NAME] [--top N]");
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

  test("filters attempts and aggregates to an exact model", () => {
    const attempts = [
      makeAttempt("planning-a", 7, "model/a"),
      makeAttempt("review-a", 11, "model/a"),
      makeAttempt("planning-b", 100, "model/b"),
    ];
    const store = makeStore(
      attempts,
      new Map(),
      new Map([
        ["planning-a", "planning"],
        ["review-a", "review"],
        ["planning-b", "planning"],
      ]),
    );

    const report = runUsage(store, runId, undefined, undefined, "model/a");

    expect(report.attempts.map(({ attemptId }) => attemptId)).toEqual(["planning-a", "review-a"]);
    expect(report.stages).toEqual([
      { stage: "planning", attempts: 1, tokens: 7, steps: null },
      { stage: "review", attempts: 1, tokens: 11, steps: null },
    ]);
    expect(report.models).toEqual([{ model: "model/a", attempts: 2, tokens: 18, steps: null }]);
    expect(report.totalTokens).toBe(18);
    expect(report.totals.tokens).toBe(18);
  });

  test("selects only attempts without a model for the host filter", () => {
    const store = makeStore([
      makeAttempt("host", 4, null),
      makeAttempt("modelled", 9, "model/a"),
    ]);

    const report = runUsage(store, runId, undefined, undefined, "(host)");

    expect(report.attempts.map(({ attemptId }) => attemptId)).toEqual(["host"]);
    expect(report.stages).toEqual([
      { stage: "implementation", attempts: 1, tokens: 4, steps: null },
    ]);
    expect(report.models).toEqual([{ model: "(host)", attempts: 1, tokens: 4, steps: null }]);
    expect(report.totalTokens).toBe(4);
    expect(report.totals.tokens).toBe(4);
  });

  test("combines model, stage, and top while aggregating all matching attempts", () => {
    const store = makeStore(
      [
        makeAttempt("planning-small", 7, "model/a"),
        makeAttempt("planning-large", 9, "model/a"),
        makeAttempt("review", 11, "model/a"),
        makeAttempt("other-model", 100, "model/b"),
      ],
      new Map(),
      new Map([
        ["planning-small", "planning"],
        ["planning-large", "planning"],
        ["review", "review"],
        ["other-model", "planning"],
      ]),
    );

    const report = runUsage(store, runId, "planning", 1, "model/a");

    expect(report.attempts.map(({ attemptId }) => attemptId)).toEqual(["planning-large"]);
    expect(report.stages).toEqual([
      { stage: "planning", attempts: 2, tokens: 16, steps: null },
    ]);
    expect(report.models).toEqual([{ model: "model/a", attempts: 2, tokens: 16, steps: null }]);
    expect(report.totalTokens).toBe(16);
    expect(report.totals.tokens).toBe(16);
  });

  test("returns an empty report when no attempts match the model", () => {
    const report = runUsage(makeStore([makeAttempt("first", 7)]), runId, undefined, undefined, "missing/model");

    expect(report.stages).toEqual([]);
    expect(report.models).toEqual([]);
    expect(report.attempts).toEqual([]);
    expect(report.totalTokens).toBe(0);
    expect(report.totals).toEqual({
      tokens: null,
      steps: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      compactedBytes: null,
    });
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
      cacheWriteTokens: 0,
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
      cacheWriteTokens: null,
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
      cacheWriteTokens: 0,
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
      cacheWriteTokens: 0,
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
      cacheWriteTokens: null,
      compactedBytes: null,
    });
    expect(report.totalTokens).toBe(0);
  });
});

describe("usage cost and input/output split", () => {
  const step = (inputTokens: number, outputTokens: number, cacheReadTokens: number) => ({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    toolCalls: 0,
    compactedBytes: 0,
  });

  test("prices uncached input, cache reads and output; host attempts cost nothing", () => {
    const store = makeStore(
      [
        makeAttempt("priced", 1_100_000, "anthropic/claude-sonnet-4-6"),
        makeAttempt("unknown", 500, "local/unknown-thing"),
        makeAttempt("host", null, null),
        makeAttempt("legacy", 70, "anthropic/claude-sonnet-4-6"),
      ],
      new Map([
        ["priced", makeUsage([step(600_000, 50_000, 200_000), step(400_000, 50_000, 200_000)])],
        ["unknown", makeUsage([step(400, 100, 0)])],
        ["host", makeUsage([])],
      ]),
    );
    const pricing = findPricing("anthropic/claude-sonnet-4-6")?.pricing;
    if (!pricing) throw new Error("No fixture price");
    const expected = (600_000 * pricing.input + 400_000 * pricing.cacheRead + 100_000 * pricing.output) / 1e6;

    const rows = new Map(runUsage(store, runId).attempts.map((row) => [row.attemptId, row]));

    expect(rows.get("priced")).toMatchObject({ inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(rows.get("priced")?.costUsd).toBeCloseTo(expected, 9);
    expect(findPricing("local/unknown-thing")).toBeNull();
    expect(rows.get("unknown")).toMatchObject({ inputTokens: 400, outputTokens: 100, costUsd: null });
    expect(rows.get("host")?.costUsd).toBe(0);
    expect(rows.get("legacy")).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null });
  });

  test("summaries add cost and count unpriced tokens per group and in total", () => {
    const attempts = [
      { ...makeAttempt("a", 1_100, "anthropic/claude-sonnet-4-6"), started_at: 1_000 },
      { ...makeAttempt("b", 70, "anthropic/claude-sonnet-4-6"), started_at: 2_000 },
    ];
    const store = Object.assign(makeStore(attempts, new Map([["a", makeUsage([step(1_000, 100, 0)])]])), {
      runIdsWithAttemptsSince: () => [runId],
    });

    const summary = usageSummary(store, { days: 1, groupBy: ["model", "stage"], now: 10_000 });

    expect(summary.tokens).toBe(1_170);
    expect(summary.inputTokens).toBe(1_000);
    expect(summary.outputTokens).toBe(100);
    expect(summary.unpricedTokens).toBe(70);
    expect(summary.costUsd).toBeGreaterThan(0);
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]).toMatchObject({
      key: "anthropic/claude-sonnet-4-6 / implementation",
      keys: { model: "anthropic/claude-sonnet-4-6", stage: "implementation" },
      attempts: 2,
      costUsd: summary.costUsd,
    });
  });
});

/** A SQL LIKE pattern with `%` wildcards as a regular expression. */
function likePath(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("%").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}
