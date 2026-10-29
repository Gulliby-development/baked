import { afterEach, expect, test } from "bun:test";
import { createClaudeCodeLanguageModel } from "../src/core/llm/providers/claude-code/index.js";
import { createCodexLanguageModel } from "../src/core/llm/providers/codex/runner.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { executionClock } from "../src/core/workflows/execution-clock.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { awakeClock } from "./helpers/awake-clock.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// R76 (#2414): hintsieve `patterns` resumed with 444,867 ms used of an 852,416 ms limit; its plan
// call reported activity once and then stayed silent until the active deadline cancelled it with
// 0 tokens, and 555 s of that silence was counted (1,000,216 ms). schemamask `io`'s plan call
// answered after 505 s of silence, which was counted in full and nowhere recorded.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const MINUTE = 60_000;

async function scenario(adapterId: "codex" | "claude-code", call: "stalls" | "answers") {
  let output: unknown;
  let silence = 0;
  // The adapter reports model activity at once (a Codex reasoning item, a Claude Code content
  // block start), then nothing: no output, no tool call.
  const answer = async (onResponse: (() => void) | undefined, signal: AbortSignal | undefined) => {
    const started = executionClock.now();
    if (call === "stalls") onResponse?.();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, call === "stalls" ? 60 * MINUTE : 3 * MINUTE);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    silence = executionClock.now() - started;
    return { text: "", toolCalls: [{ toolName: "submit_result", input: output }], finishReason: "tool-calls" };
  };
  const codex = createCodexLanguageModel("gpt-6-astra", { run: async (c) => ({
    text: JSON.stringify(await answer(c.onResponse, c.abortSignal)), usage: { inputTokens: 25, outputTokens: 25, totalTokens: 50 },
  }) });
  const claude = createClaudeCodeLanguageModel("opus", { run: async (c) => ({
    structured: await answer(c.onResponse, c.abortSignal), text: "", usage: { inputTokens: { total: 25 }, outputTokens: { total: 25 } },
  }) });
  const fixture = workflowFixture({
    policy: { ...fixturePolicy, maxActiveMs: 14 * MINUTE },
    executor: (root) => new (class ScriptedExecutor extends FixtureExecutor {
      override async execute(request: ExecutionRequest) {
        const expected = await super.execute(request);
        if (request.profile.output !== "spec") return expected;
        output = expected.output;
        const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, {
          ...fixture.config, repoMap: false,
          workflows: { ...fixture.config.workflows, stall: { ...fixture.config.workflows.stall, stepStallMs: 60 * MINUTE } },
        });
        try {
          return await native.execute({ ...request, profile: {
            ...request.profile, model: `${adapterId}/${adapterId === "codex" ? "gpt-6-astra" : "opus"}`,
          } });
        } finally { native.dispose(); }
      }
    })(root),
  });
  cleanups.push(fixture.dispose);
  const adapter = getProvider(adapterId);
  if (!adapter) throw new Error("Missing provider");
  const original = adapter.createModel;
  adapter.createModel = () => adapterId === "codex" ? codex : claude;
  cleanups.push(() => { adapter.createModel = original; });
  fixture.service.providerProbe = async () => ({ inputTokens: 1, outputTokens: 1 });
  const run = await fixture.start();
  const store = fixture.service.store;
  // Five minutes used before the drive: the deadline falls nine minutes into the silent call.
  store.addActiveTime(run.runId, 5 * MINUTE);
  const clock = awakeClock();
  let finished = false;
  try {
    const driving = fixture.service.drive(run.runId, new AbortController().signal).finally(() => { finished = true; });
    for (let tick = 0; tick < 1800 && !finished; tick++) { clock.advance(1000); await Bun.sleep(1); }
    const snapshot = await driving;
    const usage = store.artifacts(run.runId)
      .filter((a) => a.logical_path.endsWith("/usage.json"))
      .map((a) => JSON.parse(store.readArtifact(run.runId, a.id)) as AttemptUsageRecord);
    return { snapshot, activeMs: store.run(run.runId).active_ms, silence, usage };
  } finally { clock.restore(); }
}

for (const adapterId of ["codex", "claude-code"] as const) {
  test(`scenario #2414: a ${adapterId} call silent until the 14 minute deadline is not charged to active time`, async () => {
    const { snapshot, activeMs } = await scenario(adapterId, "stalls");
    expect(snapshot).toMatchObject({ status: "blocked", reason: "budget_exhausted" });
    // On main the nine silent minutes were charged: 14 minutes, above the silent interval.
    expect(activeMs).toBeLessThan(9 * MINUTE);
    expect(activeMs).toBeGreaterThanOrEqual(5 * MINUTE);
  });

  test(`scenario #2414: a ${adapterId} call that answers after 3 silent minutes is charged and records its silence`, async () => {
    const { snapshot, activeMs, silence, usage } = await scenario(adapterId, "answers");
    expect(snapshot.status).not.toBe("blocked");
    expect(silence).toBeGreaterThanOrEqual(3 * MINUTE);
    expect(activeMs).toBeGreaterThanOrEqual(8 * MINUTE);
    const silentMs = usage.reduce((sum, u) => sum + (u.silentMs ?? 0), 0);
    expect(silentMs).toBeGreaterThanOrEqual(3 * MINUTE);
    expect(silentMs).toBeLessThan(4 * MINUTE);
  });
}
