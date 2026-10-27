import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import {
  mergeModelRouting,
  parseModelRouting,
  isClaudeCodeOpus,
  parseRouteOverrides,
  RoutingRecordSchema,
  resolveProfileModel,
  resolveStageRoutes,
  ROUTING_ARTIFACT,
} from "../src/core/llm/model-routing.js";
import { explainRoute } from "../src/core/workflows/routing.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { formatRoute } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const planner = { id: "planner", role: "planner" as const, model: "$active" };
const run = { runModel: "run/model" };

describe("resolving a profile's model", () => {
  test("the profile's class falls back to the legacy slot, then the run model", () => {
    expect(resolveProfileModel(planner, run)).toEqual({ model: "run/model", source: "run model" });
    const reviewer = { id: "reviewer", role: "reviewer" as const, model: "$review" };
    expect(resolveProfileModel(reviewer, { ...run, legacy: { review: "slot/review" } })).toEqual({
      model: "slot/review",
      source: "taskRouter.verify",
    });
    expect(resolveProfileModel(reviewer, run).model).toBe("run/model");
    expect(resolveProfileModel({ ...planner, model: "fixed/model" }, run)).toEqual({
      model: "fixed/model",
      source: "profile planner",
    });
  });

  test("a profile route wins over a role route, which wins over the profile's class", () => {
    const routing = parseModelRouting({
      classes: { deep: "big/model", review: "class/review" },
      roles: { planner: "$deep", reviewer: "role/review" },
      profiles: { planner: "only/planner" },
    });
    expect(resolveProfileModel(planner, { ...run, routing })).toEqual({
      model: "only/planner",
      source: "modelRouting.profiles.planner",
    });
    expect(resolveProfileModel({ ...planner, id: "decomposer" }, { ...run, routing })).toEqual({
      model: "big/model",
      source: "modelRouting.classes.deep",
    });
    const auditor = { id: "spec-auditor", role: "spec-auditor" as const, model: "$review" };
    expect(
      resolveProfileModel(auditor, { ...run, routing, legacy: { review: "slot/review" } }),
    ).toEqual({ model: "class/review", source: "modelRouting.classes.review" });
  });

  test("unknown classes, classes naming classes and malformed sections are refused", () => {
    expect(() => resolveProfileModel({ ...planner, model: "$deep" }, run)).toThrow(/Unknown model class \$deep/);
    expect(() => parseModelRouting({ classes: { fast: "$deep" } })).toThrow(/Name a model here, not a class/);
    expect(() => parseModelRouting({ classes: { fast: { model: "$deep" } } })).toThrow(/Name a model here, not a class/);
    expect(() => parseModelRouting({ roles: { wizard: "a/b" } })).toThrow(/Invalid modelRouting/);
    expect(() => parseModelRouting({ roles: { planner: "$Bad Name" } })).toThrow(/Invalid modelRouting/);
    expect(parseModelRouting(undefined)).toBeUndefined();
  });
});

describe("stage routes", () => {
  const routing = parseModelRouting({
    classes: { fast: "small/model" },
    workflows: { sdd: { stages: { research: "$fast", review: "config/review" } } },
  });
  const stages = ["research", "plan", "review"];

  test("a start override wins over the configured route of the same stage", () => {
    expect(resolveStageRoutes("sdd", stages, { review: "cli/review" }, { ...run, routing })).toEqual([
      { stageId: "research", model: "small/model", source: "modelRouting.classes.fast" },
      { stageId: "review", model: "cli/review", source: "route override review" },
    ]);
    expect(resolveStageRoutes("other", stages, undefined, { ...run, routing })).toEqual([]);
  });

  test("a route naming a stage the workflow does not have is refused", () => {
    expect(() => resolveStageRoutes("sdd", stages, { reserch: "a/b" }, run)).toThrow(/stage reserch/);
    const typo = parseModelRouting({ workflows: { sdd: { stages: { implemnt: "a/b" } } } });
    expect(() => resolveStageRoutes("sdd", stages, undefined, { ...run, routing: typo })).toThrow(
      /modelRouting\.workflows\.sdd\.stages names stage implemnt/,
    );
  });

  test("command-line routes parse as STAGE=MODEL pairs", () => {
    expect(parseRouteOverrides("research=$fast, review=openai/gpt-5")).toEqual({
      research: "$fast",
      review: "openai/gpt-5",
    });
    expect(() => parseRouteOverrides("research")).toThrow(/STAGE=MODEL/);
    expect(() => parseRouteOverrides("=a/b")).toThrow(/STAGE=MODEL/);
    expect(() => parseWorkflowArgs(["run", "--feature", "f", "--prompt", "p", "--route", "plan="])).toThrow(/STAGE=MODEL/);
    expect(parseWorkflowArgs(["route", "sdd", "--route", "plan=$deep"]).flags.route).toBe("plan=$deep");
    expect(() => parseWorkflowArgs(["route", "a", "b"])).toThrow(/at most one workflow/);
  });
});

describe("specify on Sonnet (#1173)", () => {
  const stages = ["research", "specify", "plan"];
  const opus = { runModel: "claude-code/opus" };
  const on = parseModelRouting({ specifyOnSonnet: true });

  test("is on by default: an unset flag moves a Claude Code Opus run's specify to Sonnet", () => {
    expect(resolveStageRoutes("sdd", stages, undefined, opus)).toEqual([
      { stageId: "specify", model: "claude-code/sonnet", source: "modelRouting.specifyOnSonnet" },
    ]);
  });

  test("specifyOnSonnet false keeps Opus for specify", () => {
    const off = parseModelRouting({ specifyOnSonnet: false });
    expect(resolveStageRoutes("sdd", stages, undefined, { ...opus, routing: off })).toEqual([]);
  });

  test("when on, only the specify stage of a Claude Code Opus run moves to Sonnet", () => {
    for (const runModel of ["claude-code/opus", "claude-code/claude-opus-5-5", "claude-code/opus[1m]"])
      expect(resolveStageRoutes("sdd", stages, undefined, { runModel, routing: on })).toEqual([
        { stageId: "specify", model: "claude-code/sonnet", source: "modelRouting.specifyOnSonnet" },
      ]);
    for (const runModel of ["claude-code/sonnet", "anthropic/claude-opus-4-8", "codex/gpt-5.5", "claude-code/fable"])
      expect(resolveStageRoutes("sdd", stages, undefined, { runModel, routing: on })).toEqual([]);
    // A workflow without a specify stage is untouched.
    expect(resolveStageRoutes("quick", ["plan", "implement"], undefined, { ...opus, routing: on })).toEqual([]);
  });

  test("a configured stage route or --route still decides the specify model", () => {
    const configured = parseModelRouting({ specifyOnSonnet: true, workflows: { sdd: { stages: { specify: "claude-code/haiku" } } } });
    expect(resolveStageRoutes("sdd", stages, undefined, { ...opus, routing: configured })).toEqual([
      { stageId: "specify", model: "claude-code/haiku", source: "modelRouting.workflows.sdd.stages.specify" },
    ]);
    expect(resolveStageRoutes("sdd", stages, { specify: "claude-code/opus" }, { ...opus, routing: on })).toEqual([
      { stageId: "specify", model: "claude-code/opus", source: "route override specify" },
    ]);
  });

  test("strict ignores specifyOnSonnet, set or unset, and --route specify still wins (#2217)", () => {
    const strict = { ...opus, strict: true };
    expect(resolveStageRoutes("sdd", stages, undefined, strict)).toEqual([]);
    expect(resolveStageRoutes("sdd", stages, undefined, { ...strict, routing: on })).toEqual([]);
    expect(resolveStageRoutes("sdd", stages, { specify: "claude-code/sonnet" }, strict)).toEqual([
      { stageId: "specify", model: "claude-code/sonnet", source: "route override specify" },
    ]);
  });

  test("the project layer overrides the global one, and Opus models are recognized", () => {
    expect(mergeModelRouting({ specifyOnSonnet: true }, { specifyOnSonnet: false })?.specifyOnSonnet).toBe(false);
    expect(mergeModelRouting({ specifyOnSonnet: true }, { critic: "off" })?.specifyOnSonnet).toBe(true);
    expect(mergeModelRouting({ codeWebSearch: true }, { codeWebSearch: false })?.codeWebSearch).toBe(false);
    expect(mergeModelRouting({ codeWebSearch: true }, { critic: "off" })?.codeWebSearch).toBe(true);
    expect(parseModelRouting({ codeWebSearch: true })?.codeWebSearch).toBe(true);
    expect(isClaudeCodeOpus("claude-code/claude-opus-4-8")).toBe(true);
    expect(isClaudeCodeOpus("claude-code/sonnet")).toBe(false);
    expect(isClaudeCodeOpus("openrouter/anthropic/claude-opus-4")).toBe(false);
  });
});

test("a project layer merges into the global routing section by section", () => {
  const merged = mergeModelRouting(
    { classes: { fast: "g/fast", deep: "g/deep" }, roles: { planner: "$deep" }, workflows: { sdd: { stages: { plan: "g/plan" } } } },
    { classes: { fast: "p/fast" }, workflows: { sdd: { stages: { review: "p/review" } } } },
  );
  expect(merged).toEqual({
    classes: { fast: "p/fast", deep: "g/deep" },
    roles: { planner: "$deep" },
    profiles: {},
    workflows: { sdd: { stages: { plan: "g/plan", review: "p/review" } } },
  });
});

describe("a workflow run", () => {
  function routedFixture() {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    fixture.config.taskRouter = { ...emptyRouter, verify: "slot/review" };
    fixture.config.modelRouting = {
      classes: { fast: "cheap/model" },
      roles: { researcher: "$fast" },
      workflows: { sdd: { stages: { implement: "coder/model" } } },
    };
    const models: Record<string, string[]> = {};
    const base = fixture.executor.execute.bind(fixture.executor);
    fixture.executor.execute = async (request: ExecutionRequest) => {
      (models[request.profile.output] ??= []).push(request.profile.model);
      return base(request);
    };
    return { fixture, models };
  }
  async function complete(fixture: ReturnType<typeof workflowFixture>, runId: string) {
    for (let i = 0; i < 12; i++) {
      const state = await fixture.service.get(runId);
      if (state.status === "completed") return state;
      if (state.pendingRequestIds.length) await fixture.approve(runId);
      else if (state.status === "paused" || state.status === "created") await fixture.resume(runId);
      await fixture.service.drive(runId, new AbortController().signal);
    }
    return fixture.service.get(runId);
  }

  test("uses the routed models per role and stage and freezes them at start", async () => {
    const { fixture, models } = routedFixture();
    const started = await fixture.service.start({
      commandId: newId(),
      featureId: "fixture",
      workflowId: "sdd",
      prompt: "Create ready value",
      ownerLabel: "test",
      policy: fixture.policy,
      routes: { review: "$fast" },
    });
    const row = fixture.service.store.latestArtifact(started.runId, ROUTING_ARTIFACT);
    if (!row) throw new Error("routing artifact missing");
    const record = RoutingRecordSchema.parse(JSON.parse(fixture.service.store.readArtifact(started.runId, row.id)));
    expect(record.runModel).toBe("fixture/model");
    expect(record.profiles.researcher).toEqual({ model: "cheap/model", source: "modelRouting.classes.fast" });
    expect(record.profiles["spec-auditor"]).toEqual({ model: "slot/review", source: "taskRouter.verify" });
    expect(record.stages).toEqual({
      implement: { model: "coder/model", source: "modelRouting.workflows.sdd.stages.implement" },
      review: { model: "cheap/model", source: "modelRouting.classes.fast" },
    });
    // A later config change does not move a started run.
    fixture.config.modelRouting = { roles: { researcher: "changed/model" } };
    expect((await complete(fixture, started.runId)).status).toBe("completed");
    expect(models).toMatchObject({
      research: ["cheap/model"],
      spec: ["fixture/model"],
      plan: ["fixture/model"],
      implementation: ["coder/model"],
      review: ["cheap/model"],
      convergence: ["slot/review"],
    });
    const attempts = fixture.service.store.attempts(started.runId).map((a) => a.model_id);
    expect(attempts).toContain("coder/model");
  });

  test("a fork keeps the routing its parent froze", async () => {
    const { fixture } = routedFixture();
    const started = await fixture.service.start({
      commandId: newId(),
      featureId: "fixture",
      workflowId: "sdd",
      prompt: "Create ready value",
      ownerLabel: "test",
      policy: fixture.policy,
    });
    const parent = await fixture.service.get(started.runId);
    const fork = await fixture.service.fork(started.runId, { commandId: newId(), expectedRevision: parent.revision });
    const read = (id: string) => {
      const row = fixture.service.store.latestArtifact(id, ROUTING_ARTIFACT);
      return row ? fixture.service.store.readArtifact(id, row.id) : null;
    };
    expect(read(fork.runId)).toBe(read(started.runId));
  });

  test("a start with a route for an unknown stage is refused before the run exists", async () => {
    const { fixture } = routedFixture();
    await expect(
      fixture.service.start({
        commandId: newId(),
        featureId: "fixture",
        workflowId: "sdd",
        prompt: "Create ready value",
        ownerLabel: "test",
        policy: fixture.policy,
        routes: { deploy: "a/b" },
      }),
    ).rejects.toThrow(/stage deploy/);
    expect((await fixture.service.list({ limit: 10 })).items).toHaveLength(0);
  });

  test("route explains each stage's model and its source", () => {
    const { fixture } = routedFixture();
    const explained = explainRoute(fixture.root, fixture.config, { workflowId: "sdd", routes: { plan: "$fast" } });
    const byStage = Object.fromEntries(explained.stages.map((s) => [s.stageId, s]));
    expect(byStage.research).toMatchObject({ kind: "research", profileId: "researcher", model: null });
    expect(byStage.plan).toMatchObject({ model: "cheap/model", source: "modelRouting.classes.fast" });
    expect(byStage.implement).toMatchObject({ kind: "task-graph", model: "coder/model" });
    const table = formatRoute(explained);
    expect(table).toContain("Workflow sdd, run model fixture/model");
    expect(table).toMatch(/research\s+research\s+cheap\/model\s+modelRouting\.classes\.fast via researcher/);
    expect(table).toMatch(/implementer\s+fixture\/model\s+run model \(class \$coding not set\)/);
    expect(() => explainRoute(fixture.root, { ...DEFAULT_CONFIG }, { workflowId: "sdd" })).toThrow(/Select a model/);
  });
});

const emptyRouter = {
  spark: null,
  ember: null,
  webSearch: null,
  desloppify: null,
  verify: null,
  compact: null,
  semantic: null,
  default: null,
};
