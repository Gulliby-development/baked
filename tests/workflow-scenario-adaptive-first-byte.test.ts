import { afterEach, expect, test } from "bun:test";
import { createClaudeCodeLanguageModel } from "../src/core/llm/providers/claude-code/index.js";
import { createCodexLanguageModel } from "../src/core/llm/providers/codex/runner.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import type { CallTiming } from "../src/core/llm/provider-health.js";
import { canonical } from "../src/core/specs/hash.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { executionClock } from "../src/core/workflows/execution-clock.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { awakeClock } from "./helpers/awake-clock.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 52, srcwhere: a specify call that never answered waited the flat 10 minutes of a
// planning stage on the initiative's critical path, while the round's other specify calls
// answered in 66 to 166 s (#1766). With earlier answers of the same call shape recorded, the
// deadline is twice their p95 (at least 3 minutes), and the retry answers.
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

for (const adapterId of ["codex", "claude-code"] as const) {
  test(`scenario #1766: ${adapterId} plan call that hangs after three 50 s answers is an outage at 3 minutes, then retried`, async () => {
    const model = `${adapterId}/${adapterId === "codex" ? "gpt-6-astra" : "opus"}`;
    let output: unknown;
    let calls = 0;
    const hungFor: number[] = [];
    const answer = async (signal?: AbortSignal) => {
      calls++;
      const started = executionClock.now();
      if (calls === 1)
        await new Promise<never>((_, reject) => signal?.addEventListener("abort", () => { hungFor.push(executionClock.now() - started); reject(signal.reason); }, { once: true }));
      await new Promise<void>((resolve) => setTimeout(resolve, 50_000));
      return { text: "", toolCalls: [{ toolName: "submit_result", input: output }], finishReason: "tool-calls" };
    };
    const codex = createCodexLanguageModel("gpt-6-astra", { run: async (call: { abortSignal?: AbortSignal }) => ({
      text: JSON.stringify(await answer(call.abortSignal)), usage: { inputTokens: 25, outputTokens: 25, totalTokens: 50 },
    }) } as never);
    const claude = createClaudeCodeLanguageModel("opus", { run: async (call: { abortSignal?: AbortSignal }) => ({
      structured: await answer(call.abortSignal), text: "", usage: { inputTokens: { total: 25 }, outputTokens: { total: 25 } },
    }) } as never);
    // The effort each adapter sends for "max": codex has no "max" and sends "xhigh".
    const sent = adapterId === "codex" ? "xhigh" : "max";
    let seeded = false;
    const fixture = workflowFixture({ executor: (root) => new (class ScriptedExecutor extends FixtureExecutor {
      override async execute(request: ExecutionRequest) {
        const expected = await super.execute(request);
        if (request.profile.output !== "plan") return expected;
        output = expected.output;
        const store = fixture.service.store;
        // The spec attempt stands in for three earlier plan calls of this model that answered in 50 s.
        const seed = store.attempts(request.runId).find((a) => a.status === "completed");
        if (seed && !seeded) {
          seeded = true;
          const answered: CallTiming[] = [1, 2, 3].map(() => ({ provider: adapterId, stage: "plan", effort: sent, firstByteMs: 50_000, durationMs: 60_000 }));
          store.connection.run("UPDATE attempts SET model_id=? WHERE run_id=? AND id=?", [model, request.runId, seed.id]);
          const path = `attempts/${seed.id}/usage.json`;
          const saved = store.latestArtifact(request.runId, path);
          const usage = saved
            ? (JSON.parse(store.readArtifact(request.runId, saved.id)) as Record<string, unknown>)
            : { schemaVersion: 1, profileId: "planner", taskId: null, maxSteps: 10, maxTokens: 1000, stopReason: "submitted", finalizedBy: null, totalTokens: 0, steps: [] };
          store.artifact(request.runId, "usage", path, canonical({ ...usage, calls: answered }));
        }
        const native = new NativeAgentExecutor(store, fixture.service.leases, {
          ...fixture.config, repoMap: false,
          workflows: { ...fixture.config.workflows, stall: { ...fixture.config.workflows.stall, stepStallMs: 20 * 60_000 } },
        });
        try {
          return await native.execute({ ...request, effort: "max", profile: { ...request.profile, model } });
        } finally { native.dispose(); }
      }
    })(root) });
    cleanups.push(fixture.dispose);
    const adapter = getProvider(adapterId);
    if (!adapter) throw new Error("Missing provider");
    const original = adapter.createModel;
    adapter.createModel = () => (adapterId === "codex" ? codex : claude);
    cleanups.push(() => { adapter.createModel = original; });
    fixture.service.providerProbe = async () => ({ inputTokens: 1, outputTokens: 1 });
    const run = await fixture.start();
    const clock = awakeClock();
    let finished = false;
    try {
      const driving = fixture.service.drive(run.runId, new AbortController().signal).finally(() => { finished = true; });
      for (let tick = 0; tick < 1500 && !finished; tick++) { clock.advance(1000); await Bun.sleep(1); }
      expect(await driving).toMatchObject({ status: "waiting", reason: "approval" });
    } finally { clock.restore(); }
    expect(calls).toBe(2);
    // Twice the 50 s p95 is under the 3 minute floor; the flat planning deadline was 10 minutes.
    expect(hungFor).toHaveLength(1);
    expect(hungFor[0]).toBeGreaterThanOrEqual(180_000);
    expect(hungFor[0]).toBeLessThan(190_000);
    const store = fixture.service.store;
    const failed = store.attempts(run.runId).find((a) => a.status === "failed");
    expect(failed).toBeDefined();
    const usage = store.latestArtifact(run.runId, `attempts/${failed?.id}/usage.json`);
    const recorded = JSON.parse(store.readArtifact(run.runId, usage?.id ?? "")) as { calls?: CallTiming[] };
    expect(recorded.calls?.[0]).toMatchObject({ firstByteMs: null, limitMs: 180_000 });
  }, 60_000);
}
