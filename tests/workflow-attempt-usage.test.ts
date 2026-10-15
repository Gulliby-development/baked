import { z } from "zod";
import { afterEach, describe, expect, test } from "bun:test";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { codeWebSearchFor, NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, ProfileSchema } from "../src/core/workflows/schemas.js";
import { AttemptStepController, type AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { mergeToolBackends, runUsage, toolBackendLine } from "../src/core/workflows/usage.js";
import type { AgentExecutor, ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** One provider step: a tool call (or plain text) with the usage the provider reports. */
function step(input: number, output: number, call?: { name: string; input: unknown }): LanguageModelV3GenerateResult {
  return {
    content: call
      ? [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: call.name, input: JSON.stringify(call.input) }]
      : [{ type: "text", text: "thinking" }],
    finishReason: { unified: call ? "tool-calls" : "stop", raw: undefined },
    usage: {
      inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: output, text: output, reasoning: 0 },
    },
    warnings: [],
  };
}

/** Route `openai/*` to a scripted model; every script entry is one step, a function throws. */
function scriptModel(
  script: Array<LanguageModelV3GenerateResult | (() => never)>,
  providerId = "openai",
  calls: Array<Record<string, unknown> | undefined> = [],
): void {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`${providerId} provider missing`);
  const original = provider.createModel;
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push(options.providerOptions as Record<string, unknown> | undefined);
      const next = script[index++];
      if (!next) throw new Error("script exhausted");
      return typeof next === "function" ? next() : next;
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
}

async function nativeAttempt(
  policy = fixturePolicy,
  role: "research" | "implementation" = "research",
  task?: Task,
  model = "openai/fixture-model",
) {
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { store } = fixture.service;
  const run = await fixture.start();
  store.transaction(() => store.transition(run.runId, "running"));
  const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
  const researcher = profiles.find((p) => p.output === role);
  if (!researcher) throw new Error(`${role} profile missing`);
  const profile: AgentProfile = { ...researcher, model };
  const stepId = store.beginStep(run.runId, "fixture");
  const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, policy);
  const executor = new NativeAgentExecutor(store, new WorkspaceLeases(store), {
    ...fixture.config,
    repoMap: false,
  });
  cleanups.push(() => executor.dispose());
  const request: ExecutionRequest = {
    runId: run.runId,
    attemptId,
    profile,
    prompt: "Research the fixture",
    signal: new AbortController().signal,
    maxSteps: 10,
    ...(task ? { task } : {}),
  };
  const usageRecord = (): AttemptUsageRecord | undefined => {
    const row = store.latestArtifact(run.runId, `attempts/${attemptId}/usage.json`);
    return row ? (JSON.parse(store.readArtifact(run.runId, row.id)) as AttemptUsageRecord) : undefined;
  };
  return { fixture, store, run, attemptId, executor, request, usageRecord };
}

describe("attempt usage of a failing native attempt", () => {
  test("a loop that throws after model steps keeps their tokens and writes usage.json", async () => {
    scriptModel([
      step(1000, 100, { name: "unknown_tool", input: {} }),
      step(1500, 200, { name: "unknown_tool", input: {} }),
      () => {
        throw new Error("provider unavailable");
      },
    ]);
    const { store, run, attemptId, executor, request, usageRecord } = await nativeAttempt();
    await expect(executor.execute(request)).rejects.toThrow("provider unavailable");
    expect(store.recordedUsage(run.runId, attemptId)).toBe(2800);
    const usage = usageRecord();
    expect(usage?.stopReason).toBe("error");
    expect(usage?.totalTokens).toBe(2800);
    expect(usage?.steps.map((s) => [s.inputTokens, s.outputTokens])).toEqual([
      [1000, 100],
      [1500, 200],
    ]);
  });

  test("a budget refusal between steps keeps the spend of the steps that ran", async () => {
    // The first step fits; after it the cap (the 40,000 left of 50,000) is still above two such
    // steps, but the run limit refuses the next one once another attempt takes 25,000 more.
    const policy = { ...fixturePolicy, maxTotalTokens: 50_000 };
    scriptModel([
      step(12_000, 500, { name: "unknown_tool", input: {} }),
      step(12_000, 500, { name: "unknown_tool", input: {} }),
    ]);
    const { store, run, attemptId, executor, request, usageRecord } = await nativeAttempt(policy);
    const other = store.beginStep(run.runId, "other");
    const otherAttempt = store.reserve(run.runId, other, "openai/fixture-model", 10_000, policy);
    const original = store.recordAttemptUsage.bind(store);
    store.recordAttemptUsage = (runId, id, used) => {
      original(runId, id, used);
      if (id === attemptId && used > 0) store.expandReservation(run.runId, otherAttempt, 25_000, policy);
    };
    cleanups.push(() => {
      store.recordAttemptUsage = original;
    });
    await expect(executor.execute(request)).rejects.toThrow("Next model step exceeds remaining token budget");
    expect(store.recordedUsage(run.runId, attemptId)).toBe(12_500);
    expect(usageRecord()).toMatchObject({ stopReason: "error", totalTokens: 12_500 });
    store.transaction(() =>
      store.finishAttempt(run.runId, attemptId, "failed", store.recordedUsage(run.runId, attemptId)),
    );
    expect(store.attempts(run.runId).find((a) => a.id === attemptId)).toMatchObject({ used_tokens: 12_500, usage_complete: 1 });
  });

  test("a sized run at its ceiling blocks before an attempt its budget cannot cover (#747)", async () => {
    // 50,000 left of a 60,000 ceiling, below the default attempt cap: no model step runs.
    const policy = { ...fixturePolicy, maxTotalTokens: 60_000, sizing: { maxRunTokens: 60_000 } };
    scriptModel([step(12_000, 500, { name: "unknown_tool", input: {} })]);
    const { store, run, attemptId, executor, request } = await nativeAttempt(policy);
    const other = store.beginStep(run.runId, "other");
    store.reserve(run.runId, other, "openai/fixture-model", 10_000, policy);
    await expect(executor.execute(request)).rejects.toThrow("The next attempt needs more tokens than the run budget has left");
    expect(store.recordedUsage(run.runId, attemptId)).toBe(0);
  });

  test("an attempt that fails before any model step records zero tokens", async () => {
    scriptModel([
      () => {
        throw new Error("connection refused");
      },
    ]);
    const { store, run, attemptId, executor, request, usageRecord } = await nativeAttempt();
    await expect(executor.execute(request)).rejects.toThrow("connection refused");
    expect(store.recordedUsage(run.runId, attemptId)).toBe(0);
    expect(usageRecord()?.steps).toEqual([]);
  });

  test("the attempt cap shrinks to the remaining run budget so the agent finalizes in time", async () => {
    // 30,000 of the 60,000-token run are held by another attempt, below the default attempt cap
    // of 250,000: the attempt starts with the remaining 30,000 instead of being refused.
    const policy = { ...fixturePolicy, maxTotalTokens: 60_000 };
    const result = {
      schemaVersion: 1,
      summary: "Fixture researched",
      facts: [],
      unknowns: [],
      constraints: [],
      suggestedScope: [],
    };
    scriptModel([
      step(10_000, 100, { name: "unknown_tool", input: {} }),
      step(10_200, 100, { name: "submit_result", input: result }),
    ]);
    const { store, run, executor, request, usageRecord } = await nativeAttempt(policy);
    const other = store.beginStep(run.runId, "other");
    store.reserve(run.runId, other, "openai/fixture-model", 30_000, policy);
    await expect(executor.execute(request)).resolves.toMatchObject({ output: result });
    const usage = usageRecord();
    expect(usage?.maxTokens).toBe(30_000);
    // After the first step two more would pass the cap, so the second was the submit-only step.
    expect(usage).toMatchObject({ finalizedBy: "tokens", stopReason: "submitted", totalTokens: 20_400 });
  });
});

describe("an attempt at its token cap", () => {
  test("that ends without submitting stops with the attempt_cap reason and its numbers (#935)", async () => {
    // 70,000 of the 100,000-token run are held elsewhere, so the attempt's cap is the 30,000 left:
    // after the first step comes the finalizing step, which reaches the cap with text instead of
    // a result.
    const policy = { ...fixturePolicy, maxTotalTokens: 100_000 };
    scriptModel([
      step(9_900, 100, { name: "unknown_tool", input: {} }),
      step(19_900, 100),
    ]);
    const { store, run, executor, request, usageRecord } = await nativeAttempt(policy);
    const other = store.beginStep(run.runId, "other");
    store.reserve(run.runId, other, "openai/fixture-model", 70_000, policy);
    const error = await executor.execute(request).then(
      () => null,
      (e: unknown) => e,
    );
    expect(usageRecord()).toMatchObject({ stopReason: "tokens", maxTokens: 30_000, totalTokens: 30_000 });
    expect(error).toMatchObject({
      code: "BUDGET_EXHAUSTED",
      details: { reason: "attempt_cap", cap: 30_000 },
    });
    expect(String(error)).toContain("used 30000 tokens without submitting a result (attempt cap 30000)");
  });
});

/** A step whose input is mostly the cached prefix the earlier steps already sent. */
function cachedStep(input: number, cached: number, output: number, call: { name: string; input: unknown }): LanguageModelV3GenerateResult {
  const base = step(input, output, call);
  return { ...base, usage: { ...base.usage, inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: 0 } } };
}

describe("an attempt whose steps replay a cached context (#1070)", () => {
  test("counts its cap without the cache reads, so eight cached steps fit a cap that holds three uncached ones", async () => {
    // Bench round 21: 37 of 85 codex task attempts ended at the cap, cache reads were 71 percent
    // of their tokens (colfit 112fb4f9: 469,135 tokens in 10 steps, 84 percent cache read).
    const result = { schemaVersion: 1, summary: "Fixture researched", facts: [], unknowns: [], constraints: [], suggestedScope: [] };
    scriptModel([
      ...Array.from({ length: 7 }, () => cachedStep(40_000, 36_000, 500, { name: "unknown_tool", input: {} })),
      cachedStep(40_000, 36_000, 500, { name: "submit_result", input: result }),
    ]);
    const { executor, request, usageRecord } = await nativeAttempt();
    await expect(executor.execute({ ...request, attemptTokens: 160_000 })).resolves.toMatchObject({ output: result });
    const usage = usageRecord();
    expect(usage).toMatchObject({ stopReason: "submitted", finalizedBy: null, maxTokens: 160_000, totalTokens: 324_000, cappedTokens: 36_000 });
  });

  test("still finalizes before the run's free budget, which counts the cache reads", async () => {
    // 130,000 of the 200,000-token run are held elsewhere: the 70,000 left bound the attempt's
    // tokens, cache reads included, even though its cap counts only 3,500 a step.
    const policy = { ...fixturePolicy, maxTotalTokens: 200_000 };
    const result = { schemaVersion: 1, summary: "Fixture researched", facts: [], unknowns: [], constraints: [], suggestedScope: [] };
    scriptModel([
      cachedStep(30_000, 27_000, 500, { name: "unknown_tool", input: {} }),
      cachedStep(30_000, 27_000, 500, { name: "submit_result", input: result }),
    ]);
    const { store, run, executor, request, usageRecord } = await nativeAttempt(policy);
    const other = store.beginStep(run.runId, "other");
    store.reserve(run.runId, other, "openai/fixture-model", 130_000, policy);
    await expect(executor.execute(request)).resolves.toMatchObject({ output: result });
    expect(usageRecord()).toMatchObject({ stopReason: "submitted", finalizedBy: "tokens", totalTokens: 61_000, cappedTokens: 7_000 });
  });
});

// Bench round 31, md-site T012 (#1298): a corrective admitted on its cap (cache reads left out)
// was finalized by the run's free budget (cache reads counted) after one 186k step, with 546k
// left, and its "failed" result ended the run invalid_output with 7.3M of 15M used.
describe("scenario: a corrective admitted on its cap and finalized by the run budget (#1298)", () => {
  const corrective: Task = {
    id: "T012",
    title: "Fix closing markers",
    description: "Correct the reported findings",
    requirementIds: ["FR-001"],
    criterionIds: ["AC-001"],
    dependsOn: [],
    profileId: "implementer",
    writes: [{ path: "value.txt", action: "modify" }],
    readHints: [],
    checkIds: [],
    origin: "corrective",
    findingIds: [],
    rationale: "corrective",
  };
  const finished: Task = { ...corrective, id: "T001", title: "Parse input", origin: "planned", rationale: "parse" };
  const result = (outcome: "implemented" | "failed") => ({
    schemaVersion: 1,
    taskId: "T012",
    outcome,
    summary: outcome === "failed" ? "No corrective edits were completed before the work was stopped" : "Fixed",
    evidenceIds: [],
    unresolved: outcome === "failed" ? ["closing markers"] : [],
  });
  /** A sized run with 300k free for the attempt: each 120k step is mostly cache reads. */
  async function corrective31(withFinishedTask: boolean) {
    const policy = { ...fixturePolicy, maxTotalTokens: 1_000_000, sizing: { maxRunTokens: 4_000_000 } };
    const attempt = await nativeAttempt(policy, "implementation", corrective);
    const { store, run } = attempt;
    const graph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [finished, corrective] };
    store.transaction(() => store.syncTasks(run.runId, graph as never));
    if (withFinishedTask) store.transaction(() => store.taskStatus(run.runId, "T001", "implemented"));
    const other = store.beginStep(run.runId, "other");
    store.reserve(run.runId, other, "openai/fixture-model", 700_000, policy);
    return { ...attempt, request: { ...attempt.request, attemptTokens: 100_000 } };
  }
  const probe = () => cachedStep(120_000, 110_000, 500, { name: "unknown_tool", input: {} });

  test("the run budget grows so the attempt keeps working instead of submitting after one step", async () => {
    scriptModel([probe(), probe(), probe(), cachedStep(120_000, 110_000, 500, { name: "submit_result", input: result("implemented") })]);
    const { store, run, executor, request, usageRecord } = await corrective31(true);
    await expect(executor.execute(request)).resolves.toMatchObject({ output: { outcome: "implemented" } });
    expect(usageRecord()).toMatchObject({ stopReason: "submitted", finalizedBy: null, totalTokens: 482_000 });
    const growth = store
      .artifacts(run.runId)
      .filter((a) => a.logical_path.startsWith("policy-revisions/auto-"))
      .map((a) => JSON.parse(store.readArtifact(run.runId, a.id)));
    expect(growth[0]).toMatchObject({ kind: "auto-growth", previous: { maxTotalTokens: 1_000_000 } });
  });

  test("a budget that cannot grow stops the run on its budget, not on the task's failed result", async () => {
    scriptModel([probe(), cachedStep(120_000, 110_000, 500, { name: "submit_result", input: result("failed") })]);
    const { executor, request, usageRecord } = await corrective31(false);
    const error = await executor.execute(request).then(
      () => null,
      (e: unknown) => e,
    );
    expect(usageRecord()).toMatchObject({ stopReason: "submitted", finalizedBy: "tokens" });
    expect(error).toMatchObject({ code: "BUDGET_EXHAUSTED", details: { reason: "budget_exhausted" } });
    expect(String(error)).toContain("Task T012 was stopped by the run budget before its first edit");
  });
});

describe("attempts whose provider reports no tokens", () => {
  const result = {
    schemaVersion: 1,
    summary: "Fixture researched",
    facts: [],
    unknowns: [],
    constraints: [],
    suggestedScope: [],
  };

  test("a submit step that reports zero tokens is charged an estimate from the sizes (#1057)", async () => {
    // Codex reports a response's usage only after its tool call is answered, so an attempt that
    // ends at its only call (the submit) sees zero input and zero output tokens.
    scriptModel([step(0, 0, { name: "submit_result", input: result })]);
    const { executor, request, usageRecord } = await nativeAttempt();
    const response = await executor.execute(request);
    expect(response).toMatchObject({ output: result, usageComplete: false, usageEstimated: true });
    const promptTokens = Math.ceil(Buffer.byteLength(request.prompt) / 4);
    expect(response.inputTokens).toBe(promptTokens);
    expect(response.outputTokens).toBeGreaterThanOrEqual(Math.ceil(Buffer.byteLength(JSON.stringify(result)) / 4));
    expect(usageRecord()?.estimatedUsage).toEqual({ inputTokens: response.inputTokens ?? 0, outputTokens: response.outputTokens ?? 0 });
  });

  test("an attempt with reported tokens stays complete", async () => {
    scriptModel([
      step(0, 0, { name: "unknown_tool", input: {} }),
      step(5_000, 100, { name: "submit_result", input: result }),
    ]);
    const { executor, request } = await nativeAttempt();
    const response = await executor.execute(request);
    expect(response).toMatchObject({ inputTokens: 5_000, outputTokens: 100 });
    expect(response.usageComplete).toBeUndefined();
    expect(response.usageEstimated).toBeUndefined();
  });
});

describe("repair probes", () => {
  test("each run_probe call is journaled with the attempt", async () => {
    scriptModel([
      step(1000, 50, { name: "run_probe", input: { executable: "bun", args: ["-e", "console.log('probe-ok')"] } }),
      () => {
        throw new Error("provider unavailable");
      },
    ]);
    const repair: Task = {
      id: "T900",
      title: "Repair",
      description: "Repair the failing check",
      requirementIds: ["FR-001"],
      criterionIds: ["AC-001"],
      dependsOn: [],
      profileId: "implementer",
      writes: [{ path: "value.txt", action: "modify" }],
      readHints: [],
      checkIds: ["check"],
      origin: "repair",
      findingIds: [],
      rationale: "check failed",
    };
    const { store, run, attemptId, executor, request } = await nativeAttempt(fixturePolicy, "implementation", repair);
    await expect(executor.execute(request)).rejects.toThrow("provider unavailable");
    const row = store.latestArtifact(run.runId, `attempts/${attemptId}/probe-1.json`);
    expect(row?.kind).toBe("probe");
    const probe = JSON.parse(store.readArtifact(run.runId, row?.id ?? "")) as Record<string, unknown>;
    expect(probe).toMatchObject({ taskId: "T900", executable: "bun", status: "ran", exitCode: 0 });
    expect(String(probe.output)).toContain("probe-ok");
    const tools = store
      .events(run.runId)
      .filter((e) => e.type === "tool.finished")
      .map((e) => e.payload as { tool: string; status: string });
    expect(tools).toContainEqual(expect.objectContaining({ tool: "run_probe", status: "ok" }));
  });
});

describe("host tools", () => {
  // R10: a reviewer's run_repro calls were missing from the journal, so review cost had no owner.
  test("a host tool call is journaled with its attempt and result size", async () => {
    scriptModel([
      step(1000, 50, { name: "run_repro", input: { value: 1 } }),
      () => {
        throw new Error("provider unavailable");
      },
    ]);
    const { store, run, attemptId, executor, request } = await nativeAttempt();
    const answer = { status: "reproduced", output: "actual" };
    await expect(
      executor.execute({
        ...request,
        profile: { ...request.profile, allowedTools: [...request.profile.allowedTools, "run_repro"] },
        hostTools: {
          run_repro: {
            description: "Run a repro",
            inputSchema: z.object({ value: z.number() }),
            execute: async () => answer,
          },
        },
      }),
    ).rejects.toThrow("provider unavailable");
    const events = store.events(run.runId).filter((e) => e.type === "tool.started" || e.type === "tool.finished");
    expect(events.map((e) => [e.type, (e.payload as { tool: string }).tool])).toEqual([
      ["tool.started", "run_repro"],
      ["tool.finished", "run_repro"],
    ]);
    expect(events[1]?.payload).toMatchObject({
      attemptId,
      status: "ok",
      resultBytes: Buffer.byteLength(JSON.stringify(answer)),
    });
  });
});

describe("a failed tool call", () => {
  // R13, mdrefs T010: an apply_fix call failed after 8 ms and the journal did not say why.
  test("is journaled with its error message", async () => {
    scriptModel([
      step(1000, 50, { name: "run_repro", input: { value: 1 } }),
      () => {
        throw new Error("provider unavailable");
      },
    ]);
    const { store, run, executor, request } = await nativeAttempt();
    await expect(
      executor.execute({
        ...request,
        profile: { ...request.profile, allowedTools: [...request.profile.allowedTools, "run_repro"] },
        hostTools: {
          run_repro: {
            description: "Run a repro",
            inputSchema: z.object({ value: z.number() }),
            execute: async () => {
              throw new Error("the repro command is missing");
            },
          },
        },
      }),
    ).rejects.toThrow("provider unavailable");
    const finished = store.events(run.runId).find((e) => e.type === "tool.finished");
    expect(finished?.payload).toMatchObject({ tool: "run_repro", status: "error", error: "the repro command is missing" });
  });
});

describe("documentation probes", () => {
  const planned = (path: string): Task => ({
    id: "T004",
    title: "Write the README",
    description: "Document the CLI",
    requirementIds: ["FR-001"],
    criterionIds: ["AC-001"],
    dependsOn: [],
    profileId: "implementer",
    writes: [{ path, action: "modify" }],
    readHints: [],
    checkIds: ["check"],
    origin: "planned",
    findingIds: [],
    rationale: "docs",
  });
  const probeOnce = async (path: string) => {
    scriptModel([
      step(1000, 50, { name: "run_probe", input: { executable: "bun", args: ["-e", "console.log('usage: app <dir>/')"] } }),
      () => {
        throw new Error("provider unavailable");
      },
    ]);
    const { store, run, attemptId, executor, request } = await nativeAttempt(fixturePolicy, "implementation", planned(path));
    await expect(executor.execute(request)).rejects.toThrow("provider unavailable");
    return store.latestArtifact(run.runId, `attempts/${attemptId}/probe-1.json`);
  };

  // R09 propdrift 90c09da7: README examples were written from the spec and disagreed with the CLI.
  test("a planned task that writes a README can run the program to capture its output", async () => {
    expect((await probeOnce("README.md"))?.kind).toBe("probe");
  });

  test("a planned task that writes only code has no probe", async () => {
    expect(await probeOnce("value.txt")).toBeNull();
  });
});

describe("task-end check", () => {
  const implemented = (summary: string) => ({
    schemaVersion: 1,
    taskId: "T004",
    outcome: "implemented",
    summary,
    evidenceIds: [],
    unresolved: [],
  });
  const codeTask: Task = {
    id: "T004",
    title: "Parse input",
    description: "Parse the input",
    requirementIds: ["FR-001"],
    criterionIds: ["AC-001"],
    dependsOn: [],
    profileId: "implementer",
    writes: [{ path: "value.txt", action: "modify" }],
    readHints: [],
    checkIds: ["check"],
    origin: "planned",
    findingIds: [],
    rationale: "parse",
  };

  test("code web search reaches a Codex implementer attempt and its searches are counted (#1239)", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const searched = {
      ...step(1000, 50, { name: "submit_result", input: implemented("done") }),
      providerMetadata: { codex: { responses: 1, webSearches: 2, webSearchQueries: ["zod 4 refine", "bun:sqlite prepare"] } },
    };
    scriptModel([searched], "codex", calls);
    const { executor, request, usageRecord } = await nativeAttempt({ ...fixturePolicy, codeWebSearch: true }, "implementation", codeTask, "codex/fixture-model");
    await executor.execute(request);
    expect((calls[0]?.codex as { webSearch?: unknown } | undefined)?.webSearch).toBe(true);
    const usage = usageRecord();
    expect(usage?.webSearch).toBe(true);
    expect(usage?.webSearches).toBe(2);
    expect(usage?.webSearchQueries).toEqual(["zod 4 refine", "bun:sqlite prepare"]);
    expect(usage?.steps[0]?.webSearches).toBe(2);
  });

  test("code web search stays off without the policy setting and for other profiles (#1239)", async () => {
    const off: Array<Record<string, unknown> | undefined> = [];
    scriptModel([step(1000, 50, { name: "submit_result", input: implemented("done") })], "codex", off);
    const plain = await nativeAttempt(fixturePolicy, "implementation", codeTask, "codex/fixture-model");
    await plain.executor.execute(plain.request);
    expect((off[0]?.codex as { webSearch?: unknown } | undefined)?.webSearch).toBeUndefined();
    expect(plain.usageRecord()?.webSearch).toBeUndefined();
    expect(codeWebSearchFor({ codeWebSearch: true }, { role: "implementer", model: "codex/gpt-6-luna" })).toBe(true);
    expect(codeWebSearchFor({ codeWebSearch: true }, { role: "acceptance-writer", model: "codex/gpt-6-luna" })).toBe(true);
    expect(codeWebSearchFor({ codeWebSearch: true }, { role: "reviewer", model: "codex/gpt-6-luna" })).toBe(false);
    expect(codeWebSearchFor({ codeWebSearch: true }, { role: "implementer", model: "claude-code/sonnet" })).toBe(false);
    expect(codeWebSearchFor({}, { role: "implementer", model: "codex/gpt-6-luna" })).toBe(false);
  });

  test("its errors go back once, and the next submission is accepted without running it again", async () => {
    scriptModel([
      step(1000, 50, { name: "submit_result", input: implemented("first") }),
      step(1000, 50, { name: "submit_result", input: implemented("fixed") }),
    ]);
    const { executor, request } = await nativeAttempt(fixturePolicy, "implementation", codeTask);
    let runs = 0;
    const response = await executor.execute({
      ...request,
      taskEndCheck: async () => {
        runs++;
        return ["typecheck: src/app.ts: error TS2322: Type 'number' is not assignable to type 'string'."];
      },
    });
    expect(runs).toBe(1);
    expect(response.output).toMatchObject({ summary: "fixed" });
  });

  test("a blocked result after applied edits goes back once with the written files (#846)", async () => {
    const blocked = {
      ...implemented("Unable to edit value.txt: blocked by read-only sandbox settings. No changes were made."),
      outcome: "blocked",
      unresolved: ["value.txt"],
    };
    scriptModel([
      step(1000, 50, { name: "submit_result", input: blocked }),
      step(1000, 50, { name: "submit_result", input: implemented("value.txt is parsed") }),
    ]);
    const { store, run, attemptId, executor, request } = await nativeAttempt(
      fixturePolicy,
      "implementation",
      codeTask,
    );
    store.transaction(() => {
      const id = store.prepareEffect(run.runId, attemptId, "file_patch", { path: "value.txt", tool: "edit_file" }, null, null);
      store.finishFileEffect(run.runId, id, "a".repeat(64));
    });
    const response = await executor.execute(request);
    expect(response.output).toMatchObject({ outcome: "implemented", summary: "value.txt is parsed" });
  });

  test("a blocked result without applied edits is accepted as it is", async () => {
    const blocked = { ...implemented("The spec is missing a format."), outcome: "blocked", unresolved: ["format"] };
    scriptModel([step(1000, 50, { name: "submit_result", input: blocked })]);
    const { executor, request } = await nativeAttempt(fixturePolicy, "implementation", codeTask);
    const response = await executor.execute(request);
    expect(response.output).toMatchObject({ outcome: "blocked" });
  });

  // R24 stmtsplit-update T007/T008 (#1158): a correction closed a reproduced finding as
  // already_satisfied twice while its repro still showed the defect.
  test("an already_satisfied result goes back while a finding's repro still reproduces, a bounded number of times", async () => {
    const satisfied = (summary: string) => ({ ...implemented(summary), outcome: "already_satisfied" });
    scriptModel([
      step(1000, 50, { name: "submit_result", input: satisfied("first") }),
      step(1000, 50, { name: "submit_result", input: satisfied("second") }),
      step(1000, 50, { name: "submit_result", input: satisfied("third") }),
    ]);
    const { executor, request } = await nativeAttempt(fixturePolicy, "implementation", codeTask);
    let runs = 0;
    const response = await executor.execute({
      ...request,
      reproCheck: async () => {
        runs++;
        return ['Finding F1 still reproduces: `bun -e ...` prints "ready" where "fixed" is expected.'];
      },
    });
    expect(runs).toBe(2);
    expect(response.output).toMatchObject({ summary: "third" });
  });

  test("a result whose finding no longer reproduces is accepted", async () => {
    scriptModel([step(1000, 50, { name: "submit_result", input: implemented("first") })]);
    const { executor, request } = await nativeAttempt(fixturePolicy, "implementation", codeTask);
    const response = await executor.execute({ ...request, reproCheck: async () => [] });
    expect(response.output).toMatchObject({ summary: "first" });
  });

  // R28 leaguetab and cochange-update (#1250): tests that left out a case the criteria quote.
  test("a result whose tests leave out a quoted case goes back, and the same list is not refused twice", async () => {
    scriptModel([
      step(1000, 50, { name: "submit_result", input: implemented("first") }),
      step(1000, 50, { name: "submit_result", input: implemented("second") }),
      step(1000, 50, { name: "submit_result", input: implemented("third") }),
    ]);
    const { executor, request } = await nativeAttempt(fixturePolicy, "implementation", codeTask);
    let runs = 0;
    const response = await executor.execute({
      ...request,
      caseCheck: async () => {
        runs++;
        return ['AC-001 names "--path SRC", and no test file this task writes (tests/test_cli.py) contains it.'];
      },
    });
    expect(runs).toBe(2);
    expect(response.output).toMatchObject({ summary: "second" });
  });

  test("a clean check accepts the first submission", async () => {
    scriptModel([step(1000, 50, { name: "submit_result", input: implemented("first") })]);
    const { executor, request } = await nativeAttempt(fixturePolicy, "implementation", codeTask);
    const response = await executor.execute({ ...request, taskEndCheck: async () => [] });
    expect(response.output).toMatchObject({ summary: "first" });
  });
});

describe("model calls of an ended attempt (#863)", () => {
  test("the signal of every model call fires when the attempt ends, after its last step", async () => {
    const provider = getProvider("openai");
    if (!provider) throw new Error("openai provider missing");
    const original = provider.createModel;
    const signals: AbortSignal[] = [];
    const submit = {
      schemaVersion: 1,
      taskId: "T004",
      outcome: "implemented",
      summary: "done",
      evidenceIds: [],
      unresolved: [],
    };
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        if (options.abortSignal) signals.push(options.abortSignal);
        return step(1000, 50, { name: "submit_result", input: submit });
      },
    });
    provider.createModel = () => model as LanguageModelV3;
    cleanups.push(() => {
      provider.createModel = original;
    });
    const task: Task = {
      id: "T004",
      title: "Parse input",
      description: "Parse the input",
      requirementIds: ["FR-001"],
      criterionIds: ["AC-001"],
      dependsOn: [],
      profileId: "implementer",
      writes: [{ path: "value.txt", action: "modify" }],
      readHints: [],
      checkIds: ["check"],
      origin: "planned",
      findingIds: [],
      rationale: "parse",
    };
    const { executor, request } = await nativeAttempt(fixturePolicy, "implementation", task);
    // A provider that keeps a thread open at the submit call (Codex app-server) releases it on
    // this signal; the attempt's own signal never fires on a normal end.
    const response = await executor.execute(request);
    expect(response.output).toMatchObject({ outcome: "implemented" });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(request.signal.aborted).toBe(false);
  });
});

describe("code intelligence backends in attempt usage", () => {
  test("each tool call is counted under the backend that answered it", async () => {
    scriptModel([
      step(1000, 50, { name: "bake_find", input: { query: "value" } }),
      step(1000, 50, { name: "bake_find", input: { query: "fixture" } }),
      () => {
        throw new Error("provider unavailable");
      },
    ]);
    const { executor, request, usageRecord } = await nativeAttempt();
    await expect(executor.execute(request)).rejects.toThrow("provider unavailable");
    // Without a repo map bake_find lists files itself.
    expect(usageRecord()?.toolBackends).toEqual([
      { tool: "bake_find", backend: "file-list", server: null, calls: 2 },
    ]);
  });

  test("counts of the same tool, backend and server add up across attempts", () => {
    const merged = mergeToolBackends([
      { tool: "navigate", backend: "lsp", server: "rust-analyzer", calls: 2 },
      { tool: "navigate", backend: "tree-sitter", server: null, calls: 1 },
      { tool: "navigate", backend: "lsp", server: "rust-analyzer", calls: 3 },
    ]);
    expect(merged).toEqual([
      { tool: "navigate", backend: "lsp", server: "rust-analyzer", calls: 5 },
      { tool: "navigate", backend: "tree-sitter", server: null, calls: 1 },
    ]);
    expect(toolBackendLine(merged)).toBe("navigate lsp (rust-analyzer) 5, navigate tree-sitter 1");
    expect(toolBackendLine([])).toBeNull();
  });
});

describe("scheduler accounting of failed attempts", () => {
  test("a failed attempt is charged the usage its executor recorded and releases its reservation", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const failing: AgentExecutor = {
      async execute(request) {
        service.store.recordAttemptUsage(request.runId, request.attemptId, 4321);
        throw new Error("model rejected the request");
      },
    };
    (service as unknown as { scheduler: { executor: AgentExecutor } }).scheduler.executor = failing;
    const run = await fixture.start();
    await fixture.resume(run.runId);
    await service.drive(run.runId, new AbortController().signal).catch(() => {});
    const attempts = service.store.attempts(run.runId).filter((a) => a.model_id !== null);
    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts)
      expect(attempt).toMatchObject({ status: "failed", used_tokens: 4321, usage_complete: 1 });
    expect(service.store.run(run.runId).token_usage).toBe(4321 * attempts.length);
    expect(runUsage(service.store, run.runId).totalTokens).toBe(4321 * attempts.length);
  });
});

describe("next-step reservation", () => {
  const controller = () =>
    new AttemptStepController({
      maxSteps: 20,
      maxTokens: 250_000,
      submitTools: ["submit_result"],
      fallbackStepTokens: 1000,
      maxOutputTokens: 32_000,
    });
  const usage = (inputTokens: number, outputTokens: number) => ({
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    toolCalls: [{}],
  });

  test("grows from the reported input tokens instead of a fixed share of the bytes", () => {
    const budget = controller();
    const messages = [{ role: "user" as const, content: "x".repeat(300_000) }];
    budget.prepare({ stepNumber: 0, steps: [], messages });
    const done = [usage(90_000, 1000)];
    const longer = [...messages, { role: "user" as const, content: "y".repeat(3000) }];
    // Spend 91,000 + next input 90,000 + about 1,000 new + output estimate max(4096, 2*1000).
    const reserve = budget.reservation(done, longer);
    expect(reserve).toBeGreaterThan(91_000 + 90_000 + 4096);
    expect(reserve).toBeLessThan(91_000 + 90_000 + 1100 + 4096);
    // The former estimate charged half the bytes plus the whole output cap and a fixed slack.
    const former = 91_000 + Math.ceil(Buffer.byteLength(JSON.stringify(longer)) / 2) + 32_000 + 8192;
    expect(former - reserve).toBeGreaterThan(80_000);
  });

  test("before any usage it counts the messages at three bytes per token, and caps the output", () => {
    const budget = controller();
    const messages = [{ role: "user" as const, content: "x".repeat(30_000) }];
    const bytes = Buffer.byteLength(JSON.stringify(messages));
    expect(budget.reservation([], messages)).toBe(Math.ceil(bytes / 3) + 8192 + 4096);
    budget.prepare({ stepNumber: 0, steps: [], messages });
    expect(budget.reservation([usage(10_000, 30_000)], messages)).toBe(40_000 + 10_000 + 32_000);
  });

  test("records a failure as the stop reason", () => {
    const record = controller().record([usage(10, 1)], false, { profileId: "p", taskId: null }, "aborted");
    expect(record.stopReason).toBe("aborted");
    expect(record.totalTokens).toBe(11);
  });
});
