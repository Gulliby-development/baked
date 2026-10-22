import { afterEach, describe, expect, test } from "bun:test";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";
import { providerResponded } from "../src/core/llm/provider-health.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, ProfileSchema } from "../src/core/workflows/schemas.js";
import {
  DEFAULT_STALL_SETTINGS,
  forgetProgress,
  isStall,
  recordModelSilence,
  SILENCE_FLOOR_MS,
  SILENCE_SAMPLES,
  silenceLimitMs,
} from "../src/core/workflows/stall.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";
import { awakeClock } from "./helpers/awake-clock.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const listStep = (): LanguageModelV3GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: "list_dir", input: JSON.stringify({ path: "." }) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
  warnings: [],
});

describe("adaptive silence limit", () => {
  test("stays at stepStallMs until the run has enough calls, then follows its longest healthy silence", () => {
    const runId = crypto.randomUUID();
    cleanups.push(() => forgetProgress(runId));
    const settings = DEFAULT_STALL_SETTINGS;
    for (let i = 1; i < SILENCE_SAMPLES; i++) recordModelSilence(runId, 1000);
    expect(silenceLimitMs(settings, runId)).toBe(settings.stepStallMs);
    recordModelSilence(runId, 143_000);
    // sketchfold: 143 s healthy calls; four times that is under the 10 minute floor.
    expect(silenceLimitMs(settings, runId)).toBe(SILENCE_FLOOR_MS);
    recordModelSilence(runId, 200_000);
    expect(silenceLimitMs(settings, runId)).toBe(800_000);
    recordModelSilence(runId, 569_000);
    expect(silenceLimitMs(settings, runId)).toBe(settings.stepStallMs);
    expect(silenceLimitMs({ ...settings, adaptiveSilence: false }, runId)).toBe(settings.stepStallMs);
    forgetProgress(runId);
    expect(silenceLimitMs(settings, runId)).toBe(settings.stepStallMs);
  });

  // Bench round 34, sketchfold T004 (#1342): after the Codex app replaced its binary, a model call
  // stayed silent for 16 min 50 s while the run's healthy calls answered within 143 s; the attempt
  // was only stopped at the fixed 20 minute stepStallMs.
  test("a call that goes silent after quick healthy calls is stopped at the run's own limit", async () => {
    let index = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        if (index++ < SILENCE_SAMPLES + 1) return listStep();
        // The provider process stays up and never answers.
        return await new Promise<never>((_, reject) =>
          options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason)),
        );
      },
    });
    const provider = getProvider("openai");
    if (!provider) throw new Error("openai provider missing");
    const original = provider.createModel;
    provider.createModel = () => model as LanguageModelV3;
    cleanups.push(() => {
      provider.createModel = original;
    });
    const fixture = workflowFixture({ policy: fixturePolicy });
    cleanups.push(fixture.dispose);
    const stepStallMs = 8000;
    const { store } = fixture.service;
    const run = await fixture.start();
    cleanups.push(() => forgetProgress(run.runId));
    store.transaction(() => store.transition(run.runId, "running"));
    const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
    const researcher = profiles.find((p) => p.output === "research");
    if (!researcher) throw new Error("research profile missing");
    const profile: AgentProfile = { ...researcher, model: "openai/fixture-model" };
    const stepId = store.beginStep(run.runId, "fixture");
    const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, fixturePolicy);
    const executor = new NativeAgentExecutor(store, new WorkspaceLeases(store), {
      ...fixture.config,
      repoMap: false,
      workflows: { ...fixture.config.workflows, stall: { stepStallMs } },
    } as typeof fixture.config);
    cleanups.push(() => executor.dispose());
    const request: ExecutionRequest = {
      runId: run.runId,
      attemptId,
      profile,
      prompt: "Research the fixture",
      signal: new AbortController().signal,
      maxSteps: 20,
    };
    const started = Date.now();
    const error = await executor.execute(request).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(isStall(error)).toBe(true);
    expect(String((error as Error).message)).toContain("from the run's own model calls");
    // Half of stepStallMs, the floor of a lowered limit, plus the watchdog's check interval.
    expect(Date.now() - started).toBeLessThan(stepStallMs);
  });

  test.each(["codex", "claude-code"])("%s uses adaptive silence after reporting activity", async (adapterId) => {
    let started!: () => void;
    const activity = new Promise<void>((resolve) => { started = resolve; });
    const model = new MockLanguageModelV3({
      provider: adapterId,
      doGenerate: async (options) => {
        providerResponded(options.abortSignal);
        started();
        return await new Promise<never>((_, reject) =>
          options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason)),
        );
      },
    });
    const provider = getProvider(adapterId);
    if (!provider) throw new Error(`${adapterId} provider missing`);
    const original = provider.createModel;
    provider.createModel = () => model as LanguageModelV3;
    cleanups.push(() => { provider.createModel = original; });
    const fixture = workflowFixture({ policy: fixturePolicy });
    cleanups.push(fixture.dispose);
    const { store } = fixture.service;
    const run = await fixture.start();
    cleanups.push(() => forgetProgress(run.runId));
    for (let i = 0; i < SILENCE_SAMPLES; i++) recordModelSilence(run.runId, 1000);
    store.transaction(() => store.transition(run.runId, "running"));
    const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
    const researcher = profiles.find((p) => p.output === "research");
    if (!researcher) throw new Error("research profile missing");
    const profile: AgentProfile = { ...researcher, model: `${adapterId}/fixture-model` };
    const stepId = store.beginStep(run.runId, "fixture");
    const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, fixturePolicy);
    const executor = new NativeAgentExecutor(store, new WorkspaceLeases(store), {
      ...fixture.config,
      repoMap: false,
      workflows: { ...fixture.config.workflows, stall: { stepStallMs: 120_000 } },
    } as typeof fixture.config);
    cleanups.push(() => executor.dispose());
    const settled: boolean[] = [];
    const clock = awakeClock();
    try {
      const pending = executor.execute({
        runId: run.runId, attemptId, profile, prompt: "Research the fixture",
        signal: new AbortController().signal, maxSteps: 20,
        providerPending: () => (responded) => { settled.push(responded); },
      }).catch((error: unknown) => error);
      await activity;
      expect(settled).toEqual([true]);
      clock.advance(61_000);
      const error = await pending;
      expect(isStall(error)).toBe(true);
      expect(String((error as Error).message)).toContain("from the run's own model calls");
    } finally { clock.restore(); }
  });
});
