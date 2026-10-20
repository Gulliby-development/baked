import { afterEach, expect, test } from "bun:test";
import { headline } from "../src/components/workflow/format.js";
import { ProviderUnreachableError } from "../src/core/llm/provider-health.js";
import { createClaudeCodeLanguageModel } from "../src/core/llm/providers/claude-code/index.js";
import { createCodexLanguageModel } from "../src/core/llm/providers/codex/runner.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { executionClock } from "../src/core/workflows/execution-clock.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { awakeClock } from "./helpers/awake-clock.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

for (const adapterId of ["codex", "claude-code"] as const) {
  test.each(["spec", "plan", "plan-with-short-watchdog"])(`scenario #1639: ${adapterId} buffers a maximum-effort %s answer past 60 seconds`, async (kind) => {
    const stage = kind.startsWith("plan") ? "plan" : "spec";
    let output: unknown;
    let calls = 0;
    let probes = 0;
    let silence = 0;
    let firstResponseMs = -1;
    const answer = async () => {
      calls++;
      const started = executionClock.now();
      // No model traffic or handshake is invented while the CLI buffers its response.
      await new Promise<void>((resolve) => setTimeout(resolve, 90_000));
      silence = executionClock.now() - started;
      return { text: "", toolCalls: [{ toolName: "submit_result", input: output }], finishReason: "tool-calls" };
    };
    const codex = createCodexLanguageModel("gpt-6-astra", { run: async () => ({
      text: JSON.stringify(await answer()), usage: { inputTokens: 25, outputTokens: 25, totalTokens: 50 },
    }) });
    const claude = createClaudeCodeLanguageModel("opus", { run: async () => ({
      structured: await answer(), text: "", usage: { inputTokens: { total: 25 }, outputTokens: { total: 25 } },
    }) });
    const fixture = workflowFixture({ executor: (root) => new (class ScriptedExecutor extends FixtureExecutor {
      override async execute(request: ExecutionRequest) {
        const expected = await super.execute(request);
        if (request.profile.output !== stage) return expected;
        output = expected.output;
        const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, {
          ...fixture.config, repoMap: false,
          workflows: { ...fixture.config.workflows, stall: {
            ...fixture.config.workflows.stall, stepStallMs: kind.endsWith("watchdog") ? 60_000 : 20 * 60_000,
          } },
        });
        try {
          return await native.execute({ ...request, providerPending: () => {
            const start = executionClock.now();
            const settle = request.providerPending?.();
            return (responded) => {
              firstResponseMs = executionClock.now() - start;
              settle?.(responded);
            };
          }, effort: "max", profile: {
            ...request.profile, model: `${adapterId}/${adapterId === "codex" ? "gpt-6-astra" : "opus"}`,
          } });
        } finally { native.dispose(); }
      }
    })(root) });
    cleanups.push(fixture.dispose);
    const adapter = getProvider(adapterId);
    if (!adapter) throw new Error("Missing provider");
    const original = adapter.createModel;
    adapter.createModel = () => adapterId === "codex" ? codex : claude;
    cleanups.push(() => { adapter.createModel = original; });
    fixture.service.providerProbe = async () => { probes++; throw new Error("Healthy buffered call must not need a probe"); };
    const run = await fixture.start();
    const clock = awakeClock();
    let finished = false;
    try {
      const driving = fixture.service.drive(run.runId, new AbortController().signal).finally(() => { finished = true; });
      for (let tick = 0; tick < 1200 && !finished; tick++) { clock.advance(1000); await Bun.sleep(1); }
      expect(await driving).toMatchObject({ status: "waiting", reason: "approval" });
      expect(calls).toBe(1);
      expect(silence).toBeGreaterThanOrEqual(90_000);
      expect(firstResponseMs).toBeGreaterThanOrEqual(90_000);
      expect(probes).toBe(0);
      expect(fixture.service.store.attempts(run.runId).some((a) => a.status === "failed")).toBe(false);
    } finally { clock.restore(); }
    await fixture.approve(run.runId);
    expect((await fixture.service.drive(run.runId, new AbortController().signal)).status).toBe("completed");
  }, 30_000);
}

test.each(["spec", "plan", "implementation", "review"])("scenario #1639: healthy probes cannot restart an empty %s stage forever", async (stage) => {
  let attempts = 0;
  let probes = 0;
  let recovered = false;
  const fixture = workflowFixture({ executor: (root) => new (class ScriptedExecutor extends FixtureExecutor {
    override async execute(request: ExecutionRequest) {
      if (request.profile.output === stage && !recovered) {
        attempts++;
        fixture.service.store.recordAttemptUsage(request.runId, request.attemptId, 0);
        // Bound the old loop so failure on main returns a snapshot instead of hanging the test.
        if (attempts > 5) throw new Error("Provider retry loop did not stop");
        throw new ProviderUnreachableError(request.profile.model);
      }
      return super.execute(request);
    }
  })(root) });
  cleanups.push(fixture.dispose);
  fixture.service.providerProbe = async () => { probes++; return { inputTokens: 1, outputTokens: 1 }; };
  const run = await fixture.start();
  let snapshot = await fixture.service.drive(run.runId, new AbortController().signal);
  if (snapshot.reason === "approval") {
    await fixture.approve(run.runId);
    snapshot = await fixture.service.drive(run.runId, new AbortController().signal);
  }
  expect(snapshot).toMatchObject({ status: "blocked", reason: "no_progress" });
  expect(snapshot.providerWait).toBeUndefined();
  expect(attempts).toBe(3);
  expect(probes).toBe(2);
  expect(headline(snapshot, [], true).now).toContain("stopped making progress");
  const diagnostic = fixture.service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/")).at(-1);
  expect(diagnostic).toBeDefined();
  expect(fixture.service.store.readArtifact(run.runId, diagnostic!.id)).toContain("Automatic retries stopped");
  expect(fixture.service.store.state(run.runId).providerResumes).toBe(0);
  const revision = snapshot.revision;
  expect((await fixture.service.drive(run.runId, new AbortController().signal)).revision).toBe(revision);
  const restarted = new NativeWorkflowService(fixture.root, fixture.config, fixture.executor);
  try {
    expect((await restarted.drive(run.runId, new AbortController().signal)).revision).toBe(revision);
    expect(attempts).toBe(3);
  } finally { await restarted.shutdown(); restarted.close(); }
  recovered = true;
  await fixture.resume(run.runId);
  snapshot = await fixture.service.drive(run.runId, new AbortController().signal);
  if (snapshot.reason === "approval") {
    await fixture.approve(run.runId);
    snapshot = await fixture.service.drive(run.runId, new AbortController().signal);
  }
  expect(snapshot.status).toBe("completed");
}, 30_000);
