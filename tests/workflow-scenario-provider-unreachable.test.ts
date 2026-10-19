import { afterEach, describe, expect, test } from "bun:test";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { startApiServer } from "../src/core/api/server.js";
import { headline } from "../src/components/workflow/format.js";
import { ProviderUnreachableError, probeProvider } from "../src/core/llm/provider-health.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { awakeClock } from "./helpers/awake-clock.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function model(online: () => boolean): LanguageModelV4 {
  return {
    specificationVersion: "v4", provider: "fixture", modelId: "model", supportedUrls: {},
    doGenerate: async (options) => new Promise((_, reject) => {
      options.abortSignal?.throwIfAborted();
      options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason), { once: true });
    }),
    doStream: async () => {
      if (!online()) return new Promise(() => {});
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "ok" });
        controller.enqueue({ type: "text-delta", id: "ok", delta: "OK" });
        controller.enqueue({ type: "text-end", id: "ok" });
        controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 },
        } });
        controller.close();
      } }) };
    },
  };
}

describe("scenario: an awake host loses the provider for eleven minutes (#1613)", () => {
  test("waits and probes without spending active time or recovery resumes, then completes", async () => {
    let attempts = 0;
    let online = false;
    let probedOnline = false;
    const provider = model(() => online);
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, maxActiveMs: 60_000 },
      executor: (root) => new (class ScriptedExecutor extends FixtureExecutor {
        override async execute(request: ExecutionRequest) {
          if (request.profile.output === "implementation" && attempts++ === 0) {
            const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, {
              ...fixture.config, repoMap: false,
            });
            try { await native.execute({ ...request, profile: { ...request.profile, model: "openai/fixture-model" } }); }
            finally { native.dispose(); }
          }
          return super.execute(request);
        }
      })(root),
    });
    cleanups.push(fixture.dispose);
    const adapter = getProvider("openai");
    if (!adapter) throw new Error("OpenAI provider missing");
    const original = adapter.createModel;
    adapter.createModel = () => provider;
    cleanups.push(() => { adapter.createModel = original; });
    fixture.service.providerProbe = async (id, signal) => {
      const result = await probeProvider(provider, id, signal);
      probedOnline = true;
      return result.usage;
    };
    const run = await fixture.start();
    const signal = new AbortController().signal;
    await fixture.service.drive(run.runId, signal);
    await fixture.approve(run.runId);
    const clock = awakeClock();
    let finished = false;
    const snapshots: string[] = [];
    try {
      const driving = fixture.service.drive(run.runId, signal).finally(() => { finished = true; });
      let simulated = 0;
      for (let ticks = 0; ticks < 1800 && !finished && !probedOnline; ticks++) {
        clock.advance(1000);
        simulated += 1000;
        if (simulated >= 11 * 60_000) online = true;
        const snapshot = fixture.service.store.snapshot(run.runId);
        if (snapshot.reason === "provider") {
          snapshots.push(snapshot.status);
          expect(snapshot.activeMs).toBeLessThan(60_000);
          expect(snapshot.providerWait?.modelId).toBe("openai/fixture-model");
          expect(headline(snapshot, [], true).now).toContain("health probe");
          expect(fixture.service.store.state(run.runId).stallResumes).toBe(0);
          expect(fixture.service.store.state(run.runId).providerResumes).toBe(0);
        }
        await Bun.sleep(1);
      }
      const done = await driving;
      expect(done).toMatchObject({ status: "completed", reason: "none" });
      expect(snapshots.length).toBeGreaterThan(0);
      expect(simulated).toBeGreaterThanOrEqual(11 * 60_000);
      expect(probedOnline).toBe(true);
      expect(done.status).toBe("completed");
      expect(done.activeMs).toBeLessThan(60_000);
      expect(attempts).toBe(2);
      const events = fixture.service.store.events(run.runId, 0, 10000);
      expect(events.some((e) => e.type === "run.state_changed" && e.payload.reason === "provider")).toBe(true);
      expect(JSON.stringify(events)).not.toContain("budget_exhausted");
      expect(JSON.stringify(events)).not.toContain("step_stalled");
      expect(fixture.service.store.latestArtifact(run.runId, "provider/healthy.json")).not.toBeNull();
    } finally { clock.restore(); }
  }, 30_000);

  test.each(["pause", "cancel", "shutdown", "restart"] as const)("a durable provider wait supports %s", async (action) => {
    let failed = false;
    const fixture = workflowFixture({ executor: (root) => new (class ScriptedExecutor extends FixtureExecutor {
      override async execute(request: ExecutionRequest) {
        if (request.profile.output === "implementation" && !failed) {
          failed = true;
          throw new ProviderUnreachableError(request.profile.model, "ECONNREFUSED");
        }
        return super.execute(request);
      }
    })(root) });
    cleanups.push(fixture.dispose);
    let probing!: () => void;
    const started = new Promise<void>((resolve) => { probing = resolve; });
    fixture.service.providerProbe = async (_, signal) => {
      probing();
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const run = await fixture.start();
    const controller = new AbortController();
    await fixture.service.drive(run.runId, controller.signal);
    await fixture.approve(run.runId);
    const driving = fixture.service.drive(run.runId, controller.signal);
    await Promise.race([started, driving.then(() => { throw new Error("Run stopped instead of probing"); })]);
    const waiting = fixture.service.store.snapshot(run.runId);
    expect(waiting).toMatchObject({ status: "waiting", reason: "provider", pendingRequestIds: [] });
    if (action === "pause") {
      const status = await executeWorkflowCommand(fixture.service, parseWorkflowArgs(["status", run.runId]), controller.signal);
      expect(status).toMatchObject({ status: "waiting", reason: "provider", providerWait: waiting.providerWait });
      const server = await startApiServer({ service: fixture.service, pollMs: 20, log: () => {} });
      cleanups.push(() => server.stop());
      const response = await fetch(`${server.url}/v1/workflow/runs/${run.runId}`, { headers: { Authorization: `Bearer ${server.token}` } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "waiting", reason: "provider", providerWait: waiting.providerWait });
    }
    if (action === "pause" || action === "cancel") await fixture.service[action](run.runId, { commandId: newId(), expectedRevision: waiting.revision });
    else if (action === "shutdown") await fixture.service.shutdown();
    else {
      // The durable row remains waiting when its driver leaves, so another driver can recover it.
      fixture.service.store.transition(run.runId, "paused", "user_pause");
      controller.abort();
    }
    await driving;
    expect(fixture.service.store.run(run.runId).status).toBe(action === "cancel" ? "cancelled" : "paused");
    if (action === "restart") {
      fixture.service.store.transition(run.runId, "waiting", "provider");
      fixture.service.providerProbe = async () => ({});
      expect((await fixture.service.drive(run.runId, new AbortController().signal)).status).toBe("completed");
    }
    expect(fixture.service.store.state(run.runId).stallResumes).toBe(0);
    expect(fixture.service.store.state(run.runId).providerResumes).toBe(0);
  }, 30_000);
});
