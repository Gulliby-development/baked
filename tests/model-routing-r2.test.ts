import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import {
  parseModelRouting,
  RoutingRecordSchema,
  resolveProfileModel,
  ROUTING_ARTIFACT,
} from "../src/core/llm/model-routing.js";
import { withRouteEffort } from "../src/core/llm/provider-options.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { providerReadiness } from "../src/core/workflows/doctor.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { explainRoute } from "../src/core/workflows/routing.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { runUsage } from "../src/core/workflows/usage.js";
import { formatRoute } from "../src/headless/workflow.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("route options", () => {
  const planner = { id: "planner", role: "planner" as const, model: "$active" };
  const run = { runModel: "run/model" };

  test("a class reference brings the class's effort and fallback; an object route overrides them", () => {
    const routing = parseModelRouting({
      classes: { deep: { model: "big/model", effort: "high", fallback: ["other/model"] } },
      roles: { planner: "$deep", researcher: { model: "$deep", effort: "low" } },
      profiles: { decomposer: { model: "own/model", fallback: ["spare/model"] } },
    });
    expect(resolveProfileModel(planner, { ...run, routing })).toEqual({
      model: "big/model",
      source: "modelRouting.classes.deep",
      effort: "high",
      fallback: ["other/model"],
    });
    expect(resolveProfileModel({ id: "researcher", role: "researcher", model: "$active" }, { ...run, routing })).toEqual({
      model: "big/model",
      source: "modelRouting.classes.deep",
      effort: "low",
      fallback: ["other/model"],
    });
    expect(resolveProfileModel({ ...planner, id: "decomposer" }, { ...run, routing })).toEqual({
      model: "own/model",
      source: "modelRouting.profiles.decomposer",
      fallback: ["spare/model"],
    });
  });

  test("fallback models name models, at most three, and effort uses the known levels", () => {
    expect(() => parseModelRouting({ roles: { planner: { model: "a/b", fallback: ["$fast"] } } })).toThrow(/not a class/);
    expect(() => parseModelRouting({ roles: { planner: { model: "a/b", fallback: ["c/1", "c/2", "c/3", "c/4"] } } })).toThrow(/Invalid modelRouting/);
    expect(() => parseModelRouting({ roles: { planner: { model: "a/b", effort: "extreme" } } })).toThrow(/Invalid modelRouting/);
    expect(() => parseModelRouting({ independentReview: "sometimes" })).toThrow(/Invalid modelRouting/);
  });

  test("routing records written before effort and fallback existed still parse", () => {
    const old = { schemaVersion: 1, runModel: "a/b", profiles: { planner: { model: "a/b", source: "run model" } }, stages: {} };
    expect(RoutingRecordSchema.parse(old)).toEqual(old);
  });
});

describe("route effort", () => {
  const config = { ...DEFAULT_CONFIG, performance: { effort: "medium" as const, openaiReasoningEffort: "low" as const } };

  test("replaces the Anthropic and OpenAI knobs for one call and leaves the config alone", () => {
    expect(withRouteEffort("anthropic/claude-opus-5", config, undefined)).toBe(config);
    const high = withRouteEffort("openai/gpt-5", config, "high");
    expect(high.performance).toMatchObject({ effort: "high", openaiReasoningEffort: "high" });
    expect(config.performance).toEqual({ effort: "medium", openaiReasoningEffort: "low" });
  });

  test("walks an OpenAI level the model lacks down to a supported one", () => {
    expect(withRouteEffort("openai/gpt-5", config, "max").performance?.openaiReasoningEffort).toBe("high");
    expect(withRouteEffort("openai/gpt-4o", config, "high").performance?.openaiReasoningEffort).toBe("off");
  });

  test("default sends no effort knob", () => {
    expect(withRouteEffort("anthropic/claude-opus-5", config, "default").performance).toMatchObject({
      effort: "off",
      openaiReasoningEffort: "off",
    });
  });
});

const overloaded = () =>
  Object.assign(new Error("overloaded"), { statusCode: 503, responseHeaders: { "retry-after": "120" } });

function routedRun(modelRouting: unknown, fail: (request: ExecutionRequest) => unknown = () => undefined) {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  fixture.config.modelRouting = parseModelRouting(modelRouting);
  const calls: { output: string; model: string; effort: string | undefined }[] = [];
  const base = fixture.executor.execute.bind(fixture.executor);
  fixture.executor.execute = async (request: ExecutionRequest) => {
    calls.push({ output: request.profile.output, model: request.profile.model, effort: request.effort });
    const error = fail(request);
    if (error) throw error;
    return base(request);
  };
  const start = (routes?: Record<string, string>) =>
    fixture.service.start({
      commandId: newId(),
      featureId: "fixture",
      workflowId: "sdd",
      prompt: "Create ready value",
      ownerLabel: "test",
      policy: fixture.policy,
      ...(routes ? { routes } : {}),
    });
  const drive = (runId: string) => fixture.service.drive(runId, new AbortController().signal);
  const record = (runId: string) => {
    const row = fixture.service.store.latestArtifact(runId, ROUTING_ARTIFACT);
    if (!row) throw new Error("routing artifact missing");
    return RoutingRecordSchema.parse(JSON.parse(fixture.service.store.readArtifact(runId, row.id)));
  };
  return { fixture, calls, start, drive, record };
}

describe("fallback models", () => {
  test("a model that keeps failing hands the step to the next model of its route", async () => {
    const { fixture, calls, start, drive } = routedRun(
      { roles: { researcher: { model: "primary/model", fallback: ["backup/model"], effort: "high" } } },
      (request) => (request.profile.model === "primary/model" ? overloaded() : undefined),
    );
    const run = await start();
    await drive(run.runId);
    const research = calls.filter((call) => call.output === "research");
    // A retry-after longer than the fallback threshold skips the primary's retries.
    expect(research).toEqual([
      { output: "research", model: "primary/model", effort: "high" },
      { output: "research", model: "backup/model", effort: "high" },
    ]);
    const usage = runUsage(fixture.service.store, run.runId);
    expect(usage.models.map((m) => m.model)).toContain("backup/model");
    expect(usage.attempts.find((a) => a.model === "primary/model")?.status).toBe("failed");
    expect(calls.find((call) => call.output === "spec")?.effort).toBeUndefined();
  });

  test("when every model fails the error names the primary's failure and the last one", async () => {
    const { fixture, calls, start, drive } = routedRun(
      { roles: { researcher: { model: "primary/model", fallback: ["backup/model"] } } },
      (request) => (request.profile.output === "research" ? overloaded() : undefined),
    );
    const run = await start();
    await drive(run.runId);
    expect(calls.filter((call) => call.output === "research").map((call) => call.model)).toEqual([
      "primary/model",
      "backup/model",
    ]);
    const state = await fixture.service.get(run.runId);
    expect(state.status).not.toBe("completed");
    const events = JSON.stringify(fixture.service.store.artifacts(run.runId).map((a) => fixture.service.store.readArtifact(run.runId, a.id)));
    expect(events).toContain("primary/model failed: overloaded; last fallback backup/model failed: overloaded");
  });

  test("a request the provider refuses, or a workflow fault, does not fall back", async () => {
    for (const error of [
      // A refused account goes to a fallback on another provider (workflow-provider-account.test.ts).
      Object.assign(new Error("invalid request"), { statusCode: 400 }),
      new WorkflowFault("OUTPUT_INVALID", "bad output"),
    ]) {
      const { calls, start, drive } = routedRun(
        { roles: { researcher: { model: "primary/model", fallback: ["backup/model"] } } },
        (request) => (request.profile.output === "research" ? error : undefined),
      );
      const run = await start();
      await drive(run.runId);
      expect(calls.filter((call) => call.output === "research").map((call) => call.model)).toEqual(["primary/model"]);
    }
  });

  test("a stage route's chain applies to the stage and its effort reaches the executor", async () => {
    const { calls, start, drive, record } = routedRun(
      { workflows: { sdd: { stages: { research: { model: "stage/model", fallback: ["stage/backup"], effort: "low" } } } } },
      (request) => (request.profile.model === "stage/model" ? overloaded() : undefined),
    );
    const run = await start();
    expect(record(run.runId).stages.research).toEqual({
      model: "stage/model",
      source: "modelRouting.workflows.sdd.stages.research",
      effort: "low",
      fallback: ["stage/backup"],
    });
    await drive(run.runId);
    expect(calls.filter((call) => call.output === "research")).toEqual([
      { output: "research", model: "stage/model", effort: "low" },
      { output: "research", model: "stage/backup", effort: "low" },
    ]);
  });
});

describe("independent review", () => {
  test("warns once routing is configured, refuses with require and is silent when off", async () => {
    const warned = routedRun({ classes: { fast: "cheap/model" } });
    const run = await warned.start();
    const warnings = warned.record(run.runId).warnings ?? [];
    expect(warnings.some((w) => /Review is not independent: .* uses fixture\/model/.test(w))).toBe(true);

    const required = routedRun({ independentReview: "require" });
    await expect(required.start()).rejects.toThrow(/independentReview is "require"/);

    const off = routedRun({ independentReview: "off" });
    expect(off.record((await off.start()).runId).warnings).toBeUndefined();

    const unconfigured = routedRun(undefined);
    expect(unconfigured.record((await unconfigured.start()).runId).warnings).toBeUndefined();
  });

  test("a review on another model is independent", async () => {
    const { start, record } = routedRun({
      classes: { review: "other/model" },
      profiles: { skeptic: "other/model", "spec-auditor": "other/model" },
    });
    expect(record((await start()).runId).warnings).toBeUndefined();
  });

  test("route explains effort, fallback and warnings", () => {
    const { fixture } = routedRun({
      roles: { researcher: { model: "a/model", effort: "high", fallback: ["b/model"] } },
    });
    const explained = explainRoute(fixture.root, fixture.config, { workflowId: "sdd" });
    expect(explained.profiles.researcher).toMatchObject({ effort: "high", fallback: ["b/model"] });
    expect(explained.warnings.length).toBeGreaterThan(0);
    const table = formatRoute(explained);
    expect(table).toMatch(/research\s+research\s+a\/model\s+modelRouting\.roles\.researcher via researcher\s+high\s+b\/model/);
    expect(table).toContain("warning: Review is not independent");
  });
});

describe("preflight", () => {
  const keyless = async (id: string) =>
    id === "nokey" ? { known: true, ready: false, envVar: "NOKEY_API_KEY" } : { known: true, ready: true };

  test("refuses a start when a bound model's provider has no credentials", async () => {
    const { fixture, start } = routedRun({ independentReview: "off", roles: { researcher: "nokey/model" } });
    fixture.service.providerReady = keyless;
    const refused = start();
    await expect(refused).rejects.toThrow(/No credentials for nokey \(nokey\/model\); Used by profile researcher; fix: .*NOKEY_API_KEY/);
    await expect(refused).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    expect((await fixture.service.list({ limit: 10 })).items).toHaveLength(0);
  });

  test("fallback models, unbound profiles, unknown providers and unanswered probes only warn", async () => {
    const { fixture, start, record } = routedRun({
      independentReview: "off",
      roles: { researcher: { model: "slow/model", fallback: ["nokey/backup"] }, planner: "nowhere/model", reporter: "nokey/reporter" },
    });
    fixture.service.providerReady = async (id) =>
      id === "slow"
        ? { known: true, ready: false, timedOut: true }
        : id === "nowhere"
          ? { known: false, ready: false }
          : keyless(id);
    const warnings = record((await start()).runId).warnings ?? [];
    expect(warnings).toContainEqual(expect.stringContaining("No credentials for nokey (nokey/backup); Used by profile researcher (fallback)"));
    expect(warnings).toContainEqual(expect.stringContaining("No credentials for nokey (nokey/reporter); Used by profile reporter"));
    expect(warnings).toContainEqual(expect.stringContaining("Unknown provider for nowhere/model; Used by profile planner"));
    expect(warnings).toContainEqual(expect.stringContaining("slow did not answer its availability check (slow/model)"));
  });
});

describe("provider readiness", () => {
  test("an unknown provider is not known", async () => {
    expect(await providerReadiness("nowhere")).toEqual({ known: false, ready: false });
  });

  test("an availability check that does not answer in time is reported as timed out, not as missing credentials", async () => {
    const provider = getProvider("copilot");
    if (!provider) throw new Error("copilot provider missing");
    const original = provider.checkAvailability;
    provider.checkAvailability = () => new Promise<boolean>(() => {});
    try {
      expect(await providerReadiness("copilot", 20)).toMatchObject({ ready: false, timedOut: true });
      provider.checkAvailability = async () => false;
      const answered = await providerReadiness("copilot", 20);
      expect(answered).toMatchObject({ known: true, ready: false });
      expect(answered.timedOut).toBeUndefined();
    } finally {
      provider.checkAvailability = original;
    }
  });
});
