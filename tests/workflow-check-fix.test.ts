import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, ProfileSchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function step(call: { name: string; input: unknown }): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: call.name, input: JSON.stringify(call.input) }],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: {
      inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 100, text: 100, reasoning: 0 },
    },
    warnings: [],
  };
}

/** The tool results the scripted model saw, in order. */
function scriptModel(script: Array<LanguageModelV3GenerateResult | (() => never)>): unknown[] {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const seen: unknown[] = [];
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const last = options.prompt.at(-1);
      if (last?.role === "tool") seen.push(...last.content);
      const next = script[index++];
      if (!next) throw new Error("script exhausted");
      return typeof next === "function" ? next() : next;
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
  return seen;
}

// expenses-py-r4: a repair task spent 379k over three attempts on lint errors `ruff check --fix`
// would have fixed, and the last two ran out before editing anything.
describe("apply_fix", () => {
  test("runs a check's fixer on the task's files as recorded edits, then runs the check", async () => {
    const policy: RunPolicy = {
      ...fixturePolicy,
      checks: [
        {
          id: "lint",
          executable: "bun",
          args: ["-e", "if ((await Bun.file('value.txt').text()).includes('bad')) process.exit(1)"],
          cwd: ".",
          timeoutMs: 10000,
          required: true,
          scope: "task",
          envNames: [],
          writes: [],
          fix: {
            executable: "bun",
            args: ["-e", "const f = process.argv.at(-1); await Bun.write(f, (await Bun.file(f).text()).replace('bad', 'good'))"],
          },
        },
      ],
    };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, "value.txt"), "bad");
    const { store } = fixture.service;
    const run = await fixture.start();
    store.transaction(() => store.transition(run.runId, "running"));
    const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
    const implementer = profiles.find((p) => p.role === "implementer");
    if (!implementer) throw new Error("implementer profile missing");
    const profile: AgentProfile = { ...implementer, model: "openai/fixture-model" };
    const task: Task = {
      id: "T001", title: "Fix lint", description: "Fix lint", requirementIds: ["FR-001"], criterionIds: ["AC-001"],
      dependsOn: [], profileId: profile.id, writes: [{ path: "value.txt", action: "modify" }], readHints: [],
      checkIds: ["lint"], origin: "planned", findingIds: [], rationale: "Lint",
    };
    const seen = scriptModel([
      step({ name: "apply_fix", input: { checkId: "lint" } }),
      () => {
        throw new Error("stop after the fix");
      },
    ]);
    const stepId = store.beginStep(run.runId, "fixture");
    const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, policy);
    const leases = new WorkspaceLeases(store);
    leases.acquire("mutation", run.runId);
    cleanups.push(() => leases.release());
    const executor = new NativeAgentExecutor(store, leases, { ...fixture.config, repoMap: false });
    cleanups.push(() => executor.dispose());
    const request: ExecutionRequest = {
      runId: run.runId, attemptId, profile, task, prompt: "Fix the lint findings", signal: new AbortController().signal, maxSteps: 10,
    };
    await expect(executor.execute(request)).rejects.toThrow("stop after the fix");
    expect(readFileSync(join(fixture.root, "value.txt"), "utf8")).toBe("good");
    const edits = store.effects(run.runId).filter((e) => e.attempt_id === attemptId && e.kind === "file_patch");
    expect(edits.map((e) => JSON.parse(e.intent_json).path)).toEqual(["value.txt"]);
    expect(JSON.stringify(seen)).toContain('"status":"passed"');
  });

  // Bench round 12, mdrefs T003: `cargo fmt` formats the whole crate and rewrote three files of
  // sibling tasks; the attempt was rejected and the next two were refused on the edits it left.
  test("a fixer that rewrites files of other tasks has them put back", async () => {
    const policy: RunPolicy = {
      ...fixturePolicy,
      checks: [
        {
          id: "fmt",
          executable: "bun",
          args: ["-e", "if ((await Bun.file('value.txt').text()).includes('bad')) process.exit(1)"],
          cwd: ".",
          timeoutMs: 10000,
          required: true,
          scope: "task",
          envNames: [],
          writes: [],
          fix: {
            executable: "bun",
            args: [
              "-e",
              "for (const f of ['value.txt', 'sibling.txt']) await Bun.write(f, (await Bun.file(f).text()).replace('bad', 'good')); await Bun.write('stray.txt', 'x')",
            ],
          },
        },
      ],
    };
    const { executor, request, root, seen } = await setup(policy, ["fmt"], [
      step({ name: "apply_fix", input: { checkId: "fmt" } }),
      () => {
        throw new Error("stop after the fix");
      },
    ]);
    writeFileSync(join(root, "sibling.txt"), "bad");
    await expect(executor.execute(request)).rejects.toThrow("stop after the fix");
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("good");
    expect(readFileSync(join(root, "sibling.txt"), "utf8")).toBe("bad");
    expect(existsSync(join(root, "stray.txt"))).toBe(false);
    const result = JSON.stringify(seen);
    expect(result).toContain('"status":"passed"');
    expect(result).toContain("sibling.txt");
    expect(result).toContain("put back");
  });

  // Bench round 13, mdrefs T010: a later fixer call threw and the put-back after the loop never
  // ran, so five sibling files stayed reformatted and the attempt was rejected `input_changed`.
  test("files of other tasks are put back when a later fixer call fails", async () => {
    const policy: RunPolicy = {
      ...fixturePolicy,
      checks: [
        {
          id: "fmt",
          executable: "bun",
          args: ["-e", "process.exit(0)"],
          cwd: ".",
          timeoutMs: 10000,
          required: true,
          scope: "task",
          envNames: [],
          writes: [],
          fix: {
            executable: "bun",
            args: ["-e", "await Bun.write('sibling.txt', 'formatted')"],
          },
        },
      ],
    };
    const { executor, request, root, seen } = await setup(policy, ["fmt"], [
      step({ name: "apply_fix", input: { checkId: "fmt" } }),
      () => {
        throw new Error("stop after the fix");
      },
    ]);
    writeFileSync(join(root, "sibling.txt"), "original");
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "value.test.ts"), "test('x', () => {});\n");
    const task = request.task;
    if (!task) throw new Error("task missing");
    const writes = [...task.writes, { path: "tests/value.test.ts", action: "modify" as const }];
    await expect(executor.execute({ ...request, task: { ...task, writes } })).rejects.toThrow("stop after the fix");
    expect(readFileSync(join(root, "sibling.txt"), "utf8")).toBe("original");
    expect(JSON.stringify(seen)).toContain("error");
  });
});

// Bench round 12, mdrefs: the planner named `cargo fmt` and clippy on every task of a
// skeleton-first plan, and the implementers ran them against modules later tasks write.
describe("request_check of a whole-unit check that runs in the checks stage", () => {
  const check = {
    id: "clippy",
    executable: "bun",
    args: ["-e", "process.exit(1)"],
    cwd: ".",
    timeoutMs: 10000,
    required: true,
    scope: "feature" as const,
    envNames: [],
    writes: [],
  };

  test("returns the errors in the task's files with a note", async () => {
    const { executor, request, seen } = await setup({ ...fixturePolicy, checks: [check] }, ["clippy"], [
      step({ name: "request_check", input: { checkId: "clippy" } }),
      () => {
        throw new Error("stop after the check");
      },
    ]);
    await expect(
      executor.execute({ ...request, attributeCheck: (c) => (c.id === "clippy" ? [] : null) }),
    ).rejects.toThrow("stop after the check");
    const result = JSON.stringify(seen);
    expect(result).toContain('"status":"failed"');
    expect(result).toContain('"taskErrors":[]');
    expect(result).toContain("nothing to fix for it here");
  });

  test("a check that runs after the task is returned as it is", async () => {
    const { executor, request, seen } = await setup({ ...fixturePolicy, checks: [check] }, ["clippy"], [
      step({ name: "request_check", input: { checkId: "clippy" } }),
      () => {
        throw new Error("stop after the check");
      },
    ]);
    await expect(executor.execute({ ...request, attributeCheck: () => null })).rejects.toThrow(
      "stop after the check",
    );
    expect(JSON.stringify(seen)).not.toContain("taskErrors");
  });
});

async function setup(
  policy: RunPolicy,
  checkIds: string[],
  script: Array<LanguageModelV3GenerateResult | (() => never)>,
): Promise<{ executor: NativeAgentExecutor; request: ExecutionRequest; root: string; seen: unknown[] }> {
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  writeFileSync(join(fixture.root, "value.txt"), "bad");
  const { store } = fixture.service;
  const run = await fixture.start();
  store.transaction(() => store.transition(run.runId, "running"));
  const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
  const implementer = profiles.find((p) => p.role === "implementer");
  if (!implementer) throw new Error("implementer profile missing");
  const profile: AgentProfile = { ...implementer, model: "openai/fixture-model" };
  const task: Task = {
    id: "T001", title: "Fix", description: "Fix", requirementIds: ["FR-001"], criterionIds: ["AC-001"],
    dependsOn: [], profileId: profile.id, writes: [{ path: "value.txt", action: "modify" }], readHints: [],
    checkIds, origin: "planned", findingIds: [], rationale: "Fix",
  };
  const seen = scriptModel(script);
  const stepId = store.beginStep(run.runId, "fixture");
  const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, policy);
  const leases = new WorkspaceLeases(store);
  leases.acquire("mutation", run.runId);
  cleanups.push(() => leases.release());
  const executor = new NativeAgentExecutor(store, leases, { ...fixture.config, repoMap: false });
  cleanups.push(() => executor.dispose());
  const request: ExecutionRequest = {
    runId: run.runId, attemptId, profile, task, prompt: "Fix", signal: new AbortController().signal, maxSteps: 10,
  };
  return { executor, request, root: fixture.root, seen };
}
