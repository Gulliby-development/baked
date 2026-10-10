import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
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
});
