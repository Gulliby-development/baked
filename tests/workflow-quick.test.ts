import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { resolveProfileModel } from "../src/core/llm/model-routing.js";
import { humanApprovalReason } from "../src/core/workflows/auto-approval.js";
import { scopedPlanBudget } from "../src/core/workflows/clarification.js";
import { runDoctor } from "../src/core/workflows/doctor.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { uniqueFeatureId } from "../src/core/workflows/feature-id.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { executeWorkflowCommand, quickRunArgs } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

function quickFixture() {
  const fixture = workflowFixture();
  disposals.push(fixture.dispose);
  const requests: ExecutionRequest[] = [];
  const execute = fixture.executor.execute.bind(fixture.executor);
  fixture.executor.execute = (request: ExecutionRequest) => {
    requests.push(request);
    return execute(request);
  };
  const start = (workflowId: string, prompt = "Create ready value") =>
    fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId, prompt, ownerLabel: "test", policy: fixture.policy });
  const complete = async (runId: string) => {
    for (let round = 0; round < 4; round++) {
      const snapshot = await fixture.service.drive(runId, new AbortController().signal);
      if (snapshot.status !== "waiting") return snapshot;
      await fixture.approve(runId);
    }
    return fixture.service.get(runId);
  };
  return { ...fixture, requests, start, complete };
}

const quickPlanner = builtinProfiles.find((p) => p.id === "quick-planner");

describe("quick workflow", () => {
  test("plans, waits for approval, implements, checks and reviews without writing specs/", async () => {
    const { start, complete, executor, service, root } = quickFixture();
    const run = await start("quick");
    const final = await complete(run.runId);
    expect(final.status).toBe("completed");
    expect(executor.calls).toEqual(["plan", "implementation", "review"]);
    expect(service.store.state(run.runId).position?.stageId).toBe("done");
    expect(existsSync(join(root, "specs"))).toBe(false);
    expect(service.store.artifacts(run.runId).map((a) => a.logical_path)).toEqual(
      expect.arrayContaining(["plan.md", "tasks.json"]),
    );
  }, 30000);

  test("the plan approval says why it waits for a person and how to approve automatically", async () => {
    const { start, service } = quickFixture();
    const run = await start("quick");
    await service.drive(run.runId, new AbortController().signal);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval");
    const body = JSON.parse(approval?.body_json ?? "{}") as { autoApproval?: { declined?: string[] } };
    expect(body.autoApproval?.declined).toEqual([humanApprovalReason("quick", "approve")]);
    expect(body.autoApproval?.declined?.[0]).toContain("baked workflow define ID --from quick");
  }, 30000);

  test("a definition without the publish field still writes its documents to specs/", async () => {
    const { start, complete, root } = quickFixture();
    const run = await start("quick-fix");
    expect((await complete(run.runId)).status).toBe("completed");
    expect(existsSync(join(root, "specs", "fixture", "plan.md"))).toBe(true);
  }, 30000);

  test("the quick planner gets a budget sized by the files the request names", async () => {
    const { start, service, requests } = quickFixture();
    const run = await start("quick", "Create ready value in value.txt");
    await service.drive(run.runId, new AbortController().signal);
    const plan = requests.find((r) => r.profile.output === "plan");
    expect(plan?.profile.id).toBe("quick-planner");
    expect(plan?.maxSteps).toBe(8);
    expect(plan?.maxTokens).toBe(8 * 20_000);
    expect(plan?.prompt).toContain('"researchScope":{"maxSteps":8,"namedPaths":["value.txt"]}');
  }, 30000);

  test("a generic planner keeps its limits when the definition has no research", async () => {
    const { start, service, requests } = quickFixture();
    const run = await start("quick-fix", "Create ready value in value.txt");
    await service.drive(run.runId, new AbortController().signal);
    const plan = requests.find((r) => r.profile.output === "plan");
    expect(plan?.profile.id).toBe("planner");
    expect(plan?.maxSteps).toBe(24);
    expect(plan?.maxTokens).toBeUndefined();
    expect(plan?.prompt).not.toContain('"researchScope":{');
  }, 30000);

  test("the quick planner runs on the $fast class, which is the run model until it is configured", () => {
    if (!quickPlanner) throw new Error("quick-planner missing");
    expect(quickPlanner.model).toBe("$fast");
    expect(resolveProfileModel(quickPlanner, { runModel: "p/big" }).model).toBe("p/big");
    expect(
      resolveProfileModel(quickPlanner, { runModel: "p/big", routing: { classes: { fast: "p/small" } } }),
    ).toEqual({ model: "p/small", source: "modelRouting.classes.fast" });
  });

  test("a request that names no file keeps the quick planner's profile limit", () => {
    if (!quickPlanner) throw new Error("quick-planner missing");
    expect(scopedPlanBudget("Make the parser faster", quickPlanner, defaultWorkflowPolicy)).toEqual({
      maxSteps: 12,
      maxTokens: undefined,
      namedPaths: [],
    });
    expect(scopedPlanBudget("Edit a.ts, b.ts and c.ts", quickPlanner, defaultWorkflowPolicy).maxSteps).toBe(12);
  });
});

describe("baked quick", () => {
  test("parses the task text or a prompt file, not both", () => {
    expect(parseWorkflowArgs(["quick", "fix", "the", "parser"]).positional).toEqual(["fix", "the", "parser"]);
    expect(parseWorkflowArgs(["quick", "--prompt-file", "task.md"]).flags["prompt-file"]).toBe("task.md");
    expect(() => parseWorkflowArgs(["quick"])).toThrow("Describe the task as text or with --prompt-file");
    expect(() => parseWorkflowArgs(["quick", "fix", "--prompt-file", "task.md"])).toThrow("not both");
    expect(() => parseWorkflowArgs(["quick", "fix", "--writers", "2"])).toThrow("--writers is not valid for quick");
  });

  test("runs the quick preset with a feature ID derived from the text", async () => {
    const { service, start } = quickFixture();
    const args = quickRunArgs(service, parseWorkflowArgs(["quick", "Fix", "the", "parser", "--model", "m/x"]));
    expect(args).toEqual({
      command: "run",
      positional: [],
      flags: { model: "m/x", workflow: "quick", feature: "fix-the-parser", prompt: "Fix the parser" },
    });
    await start("quick");
    expect(quickRunArgs(service, parseWorkflowArgs(["quick", "fixture"])).flags.feature).toBe("fixture-2");
    expect(quickRunArgs(service, parseWorkflowArgs(["quick", "x", "--feature", "mine"])).flags.feature).toBe("mine");
  }, 30000);

  test("a project's quickWorkflow replaces the preset", () => {
    const { root, executor, policy } = quickFixture();
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", quickWorkflow: "my-quick", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    disposals.push(async () => service.close());
    expect(quickRunArgs(service, parseWorkflowArgs(["quick", "x"])).flags.workflow).toBe("my-quick");
  });

  test("refuses to start without a feature check", async () => {
    const { root, executor } = quickFixture();
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: defaultWorkflowPolicy } };
    const service = new NativeWorkflowService(root, config, executor);
    disposals.push(async () => service.close());
    await expect(
      executeWorkflowCommand(service, parseWorkflowArgs(["quick", "fix"]), new AbortController().signal),
    ).rejects.toThrow("Workflow quick needs at least one feature check in the workflow policy");
    // The local API starts a quick task as a run of the quick workflow; it refuses the same way.
    await expect(
      executeWorkflowCommand(
        service,
        parseWorkflowArgs(["run", "--workflow", "quick", "--feature", "f", "--prompt", "fix"]),
        new AbortController().signal,
      ),
    ).rejects.toThrow("Workflow quick needs at least one feature check in the workflow policy");
    expect(service.store.list(10).items).toEqual([]);
    const report = await runDoctor(root, config, { workflowId: "quick" }, {
      providerReady: async () => ({ known: true, ready: true }),
      which: (command) => `/usr/bin/${command}`,
      git: async () => ({ code: 0, stdout: "" }),
    });
    expect(report.ready).toBe(false);
    const start = report.checks.find((c) => c.id === "start");
    expect(start?.status).toBe("fail");
    expect(start?.fix).toContain("/workflow gates");
  });

  test("feature IDs get a numeric suffix while taken", () => {
    const taken = new Set(["fix-it", "fix-it-2"]);
    expect(uniqueFeatureId("Fix it", (id) => taken.has(id))).toBe("fix-it-3");
    expect(uniqueFeatureId("Fix it now", (id) => taken.has(id))).toBe("fix-it-now");
  });
});
