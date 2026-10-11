import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPricing } from "../src/core/llm/pricing.js";
import {
  checkModels,
  type DoctorDeps,
  preRunEstimate,
  runDoctor,
} from "../src/core/workflows/doctor.js";
import { estimatePreRun, type PastRun } from "../src/core/workflows/estimate.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { formatDoctor, formatEstimate } from "../src/headless/workflow-pre-run.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Every provider ready, every command found, a clean Git repository. */
const healthy = (overrides: Partial<DoctorDeps> = {}): DoctorDeps => ({
  providerReady: async () => ({ known: true, ready: true }),
  which: (command) => `/usr/bin/${command}`,
  git: async (args) =>
    args[0] === "rev-parse" ? { code: 0, stdout: "true\n" } : { code: 0, stdout: "" },
  ...overrides,
});

function fixture(policy = fixturePolicy) {
  const f = workflowFixture({ policy });
  cleanups.push(f.dispose);
  return f;
}

const past = (over: Partial<PastRun>): PastRun => ({
  runId: "r",
  workflowId: "standard",
  status: "completed",
  tokens: 0,
  calls: 0,
  activeMs: 0,
  taskCount: 0,
  stageTokens: {},
  taskTokens: 0,
  ...over,
});
const price = { input: 2, cacheRead: 0.5, output: 10, match: "table" as const };

describe("doctor", () => {
  test("a valid workspace with keys and commands is ready, with an estimate", async () => {
    const { root, config } = fixture();
    const report = await runDoctor(root, config, {}, healthy());
    expect(report.ready).toBe(true);
    expect(report.runModel).toBe("fixture/model");
    expect(report.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(report.checks.map((c) => c.id)).toContain("commands.executable");
    expect(report.estimate?.workflowId).toBe("sdd");
    expect(formatDoctor(report)).toContain("Ready to run");
  });

  test("workflows that are disabled or would be refused at start fail, and later checks skip", async () => {
    const { root, config } = fixture();
    const disabled = { ...config, workflows: { ...config.workflows, enabled: false } };
    const off = await runDoctor(root, disabled, {}, healthy());
    expect(off.ready).toBe(false);
    expect(off.checks.find((c) => c.id === "config.enabled")?.status).toBe("fail");

    const refused = await runDoctor(root, config, { workflowId: "missing" }, healthy());
    const start = refused.checks.find((c) => c.id === "start");
    expect(start?.status).toBe("fail");
    expect(start?.detail).toContain("Unknown workflow missing");
    expect(refused.checks.find((c) => c.status === "skip")).toBeDefined();
    expect(refused.estimate).toBeNull();

    const badRoute = await runDoctor(
      root,
      config,
      { routes: { research: "$nope" } },
      healthy(),
    );
    expect(badRoute.checks.find((c) => c.id === "start")?.detail).toContain("$nope");
  });

  test("a routed model without credentials fails, one without a known provider warns, and both name who uses it", async () => {
    const { root, config } = fixture();
    const routed = { ...config, modelRouting: { roles: { researcher: "other/model" } } };
    const report = await runDoctor(
      root,
      routed,
      {},
      healthy({
        providerReady: async (id) =>
          id === "fixture"
            ? { known: true, ready: false, envVar: "FIXTURE_API_KEY" }
            : { known: false, ready: false },
      }),
    );
    expect(report.ready).toBe(false);
    const key = report.checks.find((c) => c.id === "models.key" && c.status === "fail");
    expect(key?.subject).toBe("fixture/model");
    expect(key?.fix).toContain("FIXTURE_API_KEY");
    const provider = report.checks.find((c) => c.id === "models.provider");
    expect(provider).toMatchObject({ status: "warn", subject: "other/model" });
    expect(provider?.detail).toContain("profile researcher");
  });

  test("checkModels warns about a model ID without a provider", async () => {
    const checks = await checkModels([{ model: "bare", usedBy: ["stage plan"] }], async () => ({
      known: true,
      ready: true,
    }));
    expect(checks[0]).toMatchObject({ id: "models.provider", status: "warn", title: "bare is not a provider/model ID" });
  });

  test("a missing required check command fails; an optional one warns", async () => {
    const policy = {
      ...fixturePolicy,
      checks: [
        ...fixturePolicy.checks,
        { ...fixturePolicy.checks[0]!, id: "lint", executable: "nolint", required: false },
      ],
    };
    const { root, config } = fixture(policy);
    const report = await runDoctor(
      root,
      config,
      {},
      healthy({ which: () => null }),
    );
    const commands = report.checks.filter((c) => c.id === "commands.executable");
    expect(commands.map((c) => [c.subject, c.status])).toEqual([
      ["check", "fail"],
      ["lint", "warn"],
    ]);
  });

  test("Git state: no repository and uncommitted changes warn", async () => {
    const { root, config } = fixture();
    const none = await runDoctor(root, config, {}, healthy({ git: async () => ({ code: 128, stdout: "" }) }));
    expect(none.checks.find((c) => c.id === "git.repo")?.status).toBe("warn");
    expect(none.ready).toBe(true);
    const dirty = await runDoctor(
      root,
      config,
      {},
      healthy({
        git: async (args) =>
          args[0] === "rev-parse"
            ? { code: 0, stdout: "true\n" }
            : args[0] === "status"
              ? { code: 0, stdout: " M src/a.ts\n?? .baked/x\n" }
              : { code: 0, stdout: "worktree /w/.baked/worktrees/r1/main\nprunable gitdir file points to non-existent location\n" },
      }),
    );
    expect(dirty.checks.find((c) => c.id === "git.clean")).toMatchObject({
      status: "warn",
      title: "1 uncommitted change",
    });
    expect(dirty.checks.find((c) => c.id === "git.worktrees")?.status).toBe("warn");
  });

  test("a live run holding the workspace fails the doctor", async () => {
    const { root, config, service } = fixture();
    service.store.putLease({
      resource: "execution",
      owner_id: "someone",
      owner_epoch: 1,
      run_id: null,
      expires_at: Date.now() + 15000,
      process_identity_json: JSON.stringify({ pid: process.pid, startedAt: 0, instance: "x" }),
    });
    const report = await runDoctor(root, config, {}, healthy());
    expect(report.checks.find((c) => c.id === "workspace.busy")).toMatchObject({
      status: "fail",
      subject: "someone",
    });
  });

  test("a budget below the estimate warns but does not block", async () => {
    const { root, config } = fixture({ ...fixturePolicy, maxTotalTokens: 1000 });
    const report = await runDoctor(root, config, {}, healthy());
    expect(report.checks.find((c) => c.id === "budget")?.status).toBe("warn");
    expect(report.ready).toBe(true);
  });

  test("worktree mode with more writers than allowed is refused like a start", async () => {
    const { root, config } = fixture();
    const report = await runDoctor(root, config, { writers: 3 }, healthy());
    expect(report.checks.find((c) => c.id === "start")?.status).toBe("fail");
  });
});

describe("pre-run estimate", () => {
  test("follows the definition's stages: quick-fix has no research and prices tasks", () => {
    const estimate = estimatePreRun({
      history: [],
      workflowId: "quick-fix",
      stages: [
        { id: "plan", type: "agent", models: ["a/m"] },
        { id: "approve", type: "approval", models: [] },
        { id: "implement", type: "tasks", models: ["a/m"] },
        { id: "checks", type: "check", models: [] },
      ],
      maxTotalTokens: 2_000_000,
      price: () => price,
    });
    expect(estimate.stages.map((s) => s.stageId)).toEqual(["plan", "approve", "implement", "checks"]);
    expect(estimate.stages[1]?.tokens).toEqual({ low: 0, high: 0 });
    expect(estimate.stages[2]?.tokens).toEqual({ low: 30_000, high: 480_000 });
    expect(estimate.basis).toBe("defaults");
    expect(estimate.budget.fits).toBe("yes");
    expect(estimate.costComplete).toBe(true);
  });

  test("prefers runs of the same workflow, falls back per stage to other runs", () => {
    const history = [
      past({ runId: "a", workflowId: "standard", stageTokens: { research: 100_000 } }),
      past({ runId: "b", workflowId: "spike", stageTokens: { research: 10_000, report: 40_000 } }),
    ];
    const estimate = estimatePreRun({
      history,
      workflowId: "standard",
      stages: [
        { id: "research", type: "agent", models: ["a/m"] },
        { id: "report", type: "agent", models: ["a/m"] },
        { id: "plan", type: "agent", models: ["a/m"] },
      ],
      maxTotalTokens: 1_000_000,
      price: () => price,
    });
    expect(estimate.stages.map((s) => s.basis)).toEqual(["workflow-history", "history", "defaults"]);
    expect(estimate.stages[0]?.tokens).toEqual({ low: 70_000, high: 140_000 });
    expect(estimate.basis).toBe("workflow-history");
    expect(estimate.label).toContain("of standard");
  });

  test("prices tokens per model with the mix and reports unknown prices as partial", () => {
    const estimate = estimatePreRun({
      history: [],
      workflowId: "spike",
      stages: [
        { id: "research", type: "agent", models: ["known/m"] },
        { id: "report", type: "agent", models: ["unknown/m"] },
      ],
      maxTotalTokens: 1000,
      price: (model) => (model === "known/m" ? price : null),
    });
    // 20k–150k research tokens at 0.6×2 + 0.3×0.5 + 0.1×10 = $2.35 per million.
    expect(estimate.costUsd?.low).toBeCloseTo(0.047, 5);
    expect(estimate.costUsd?.high).toBeCloseTo(0.3525, 5);
    expect(estimate.costComplete).toBe(false);
    expect(estimate.models.find((m) => m.model === "unknown/m")?.price).toBe("unknown");
    expect(estimate.notes.join(" ")).toContain("unknown/m");
    expect(estimate.label).toContain("(partial)");
    expect(estimate.budget.fits).toBe("no");
  });

  test("splits a review stage's tokens across its models", () => {
    const estimate = estimatePreRun({
      history: [],
      workflowId: "review-only",
      stages: [{ id: "review", type: "review", models: ["a/m", "b/m"] }],
      maxTotalTokens: 1_000_000,
      price: () => price,
    });
    expect(estimate.models.map((m) => m.tokens)).toEqual([
      { low: 10_000, high: 40_000 },
      { low: 10_000, high: 40_000 },
    ]);
  });

  test("on a workspace: routing decides the model of each stage", async () => {
    const { root, config } = fixture();
    const estimate = await preRunEstimate(root, config, {
      workflowId: "standard",
      routes: { research: "anthropic/claude-haiku-4-5" },
    });
    expect(estimate.stages.find((s) => s.stageId === "research")?.models).toEqual([
      "anthropic/claude-haiku-4-5",
    ]);
    expect(estimate.stages.find((s) => s.stageId === "plan")?.models).toEqual(["fixture/model"]);
    expect(estimate.models.find((m) => m.model === "anthropic/claude-haiku-4-5")?.price).toBe(
      "table",
    );
    expect(formatEstimate(estimate)).toContain("research");
  });

  test("a policy file is read like `workflow run` reads it", async () => {
    const { root, config } = fixture();
    writeFileSync(join(root, "policy.json"), JSON.stringify({ ...fixturePolicy, maxTotalTokens: 5000 }));
    const args = parseWorkflowArgs(["estimate", "spike", "--policy", "policy.json"]);
    const { preRunRequest } = await import("../src/headless/workflow-pre-run.js");
    const estimate = await preRunEstimate(root, config, preRunRequest(args, root));
    expect(estimate.workflowId).toBe("spike");
    expect(estimate.budget.maxTotalTokens).toBe(5000);
  });
});

describe("pricing", () => {
  test("table entries, family guesses and unknown models are told apart", () => {
    expect(findPricing("anthropic/claude-haiku-4-5")?.match).toBe("table");
    expect(findPricing("openai/gpt-99")?.match).toBe("approximate");
    expect(findPricing("acme/unknown-model")).toBeNull();
    expect(findPricing("local/model:free")?.pricing.input).toBe(0);
  });
});

describe("command line", () => {
  test("doctor and estimate take the run options that change a start", () => {
    expect(parseWorkflowArgs(["doctor", "standard", "--model", "a/b", "--json"])).toMatchObject({
      command: "doctor",
      positional: ["standard"],
      flags: { model: "a/b", json: true },
    });
    expect(() => parseWorkflowArgs(["estimate", "--feature", "x"])).toThrow(/not valid/);
    expect(() => parseWorkflowArgs(["doctor", "a", "b"])).toThrow(/at most one/);
    expect(() => parseWorkflowArgs(["doctor", "--writers", "2"])).toThrow(/requires --worktree/);
  });
});
