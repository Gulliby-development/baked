/**
 * Workflow agents on the Claude API use the prompt cache: the request body carries a breakpoint
 * on the system prompt and the request-level automatic breakpoint, every step extends the
 * previous request byte for byte, and cache reads and writes reach the attempt's usage.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { findPricing } from "../src/core/llm/pricing.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, ProfileSchema } from "../src/core/workflows/schemas.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { runUsage } from "../src/core/workflows/usage.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const MODEL = "claude-sonnet-4-6";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Body = {
  cache_control?: unknown;
  system?: Array<{ cache_control?: unknown }>;
  messages: unknown[];
};

/** One Messages API response per entry; returns the request bodies BAKED sent. */
function scriptAnthropic(contents: unknown[][]): Body[] {
  const provider = getProvider("anthropic");
  if (!provider) throw new Error("anthropic provider missing");
  const original = provider.createModel;
  const bodies: Body[] = [];
  const fetchMock = async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Body);
    const content = contents[bodies.length - 1];
    if (!content) throw new Error("script exhausted");
    return Response.json({
      id: `msg_${bodies.length}`,
      type: "message",
      role: "assistant",
      model: MODEL,
      content,
      stop_reason: "tool_use",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: bodies.length === 1 ? 0 : 4000,
      },
    });
  };
  provider.createModel = (id) =>
    createAnthropic({ apiKey: "test-key", fetch: fetchMock as typeof fetch })(id);
  cleanups.push(() => {
    provider.createModel = original;
  });
  return bodies;
}

async function researchAttempt(ttl?: "5m" | "1h") {
  const fixture = workflowFixture({ policy: fixturePolicy });
  cleanups.push(fixture.dispose);
  const { store } = fixture.service;
  const run = await fixture.start();
  store.transaction(() => store.transition(run.runId, "running"));
  const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
  const researcher = profiles.find((p) => p.output === "research");
  if (!researcher) throw new Error("research profile missing");
  const profile: AgentProfile = { ...researcher, model: `anthropic/${MODEL}` };
  const stepId = store.beginStep(run.runId, "fixture");
  const attemptId = store.reserve(run.runId, stepId, profile.model, 50_000, fixturePolicy);
  const executor = new NativeAgentExecutor(store, new WorkspaceLeases(store), {
    ...fixture.config,
    repoMap: false,
    ...(ttl ? { cache: { ttl } } : {}),
  });
  cleanups.push(() => executor.dispose());
  await executor.execute({
    runId: run.runId,
    attemptId,
    profile,
    prompt: "Research the fixture",
    signal: new AbortController().signal,
    maxSteps: 4,
  });
  const row = store.latestArtifact(run.runId, `attempts/${attemptId}/usage.json`);
  const usage = row
    ? (JSON.parse(store.readArtifact(run.runId, row.id)) as AttemptUsageRecord)
    : undefined;
  return { store, runId: run.runId, usage };
}

const toolUse = (name: string, input: unknown) => [
  { type: "tool_use", id: `toolu_${crypto.randomUUID().slice(0, 8)}`, name, input },
];
const research = {
  schemaVersion: 1,
  summary: "A fixture workspace",
  facts: [],
  unknowns: [],
  constraints: [],
  suggestedScope: [],
};

describe("workflow agents on the Claude API", () => {
  test("mark the system prompt and the conversation tail for the prompt cache", async () => {
    const bodies = scriptAnthropic([
      toolUse("list_dir", { path: "." }),
      toolUse("submit_result", research),
    ]);
    const { store, runId, usage } = await researchAttempt();
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
      expect(body.system?.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    }
    // The second step re-sends the first request unchanged, so it can read it from the cache.
    const [first, second] = bodies;
    expect(second?.system).toEqual(first?.system);
    expect(second?.messages.slice(0, first?.messages.length)).toEqual(first?.messages ?? []);

    expect(usage?.steps.map((s) => [s.inputTokens, s.cacheReadTokens, s.cacheWriteTokens])).toEqual([
      [1100, 0, 1000],
      [5100, 4000, 1000],
    ]);
    const report = runUsage(store, runId);
    const attempt = report.attempts.find((a) => a.model === `anthropic/${MODEL}`);
    expect(attempt).toMatchObject({ cacheReadTokens: 4000, cacheWriteTokens: 2000 });
    expect(report.totals.cacheWriteTokens).toBe(2000);
    const price = findPricing(MODEL)?.pricing;
    if (!price) throw new Error("price missing");
    const expected =
      (200 * price.input + 4000 * price.cacheRead + 2000 * price.cacheWrite + 100 * price.output) /
      1e6;
    expect(attempt?.costUsd).toBeCloseTo(expected, 10);
  }, 30_000);

  test("use the configured cache lifetime", async () => {
    const bodies = scriptAnthropic([toolUse("submit_result", research)]);
    await researchAttempt("1h");
    expect(bodies[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(bodies[0]?.system?.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  }, 30_000);
});
