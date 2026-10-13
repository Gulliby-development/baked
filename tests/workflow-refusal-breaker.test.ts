import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, ProfileSchema } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};
const editStep = (): LanguageModelV3GenerateResult => ({
  content: [
    {
      type: "tool-call",
      toolCallId: crypto.randomUUID(),
      toolName: "edit_file",
      input: JSON.stringify({ path: "value.txt", oldString: "old", newString: "new" }),
    },
  ],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});

/** Route `openai/*` to a model that only ever retries the same edit, and count its calls. */
function retryingModel(): { calls: number } {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const seen = { calls: 0 };
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      seen.calls++;
      if (seen.calls > 20) throw new Error("the attempt kept retrying");
      return editStep();
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
  return seen;
}

const task: Task = {
  id: "T001",
  title: "Write value",
  description: "Write value.txt",
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: [{ path: "value.txt", action: "modify" }],
  readHints: [],
  checkIds: [],
  origin: "planned",
  findingIds: [],
  rationale: "Required behavior",
};

describe("edits refused as changed outside the attempt (#954)", () => {
  test("stop the attempt at the third refusal of one path instead of retrying to the cap", async () => {
    const seen = retryingModel();
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { store } = fixture.service;
    const run = await fixture.start();
    // The file on disk differs from the content the run recorded for it, so every edit is refused.
    writeFileSync(join(fixture.root, "value.txt"), "old\n");
    store.transaction(() => {
      const state = store.state(run.runId);
      state.expectedFiles = { "value.txt": "0".repeat(64) };
      store.saveState(run.runId, state);
      store.transition(run.runId, "running");
    });
    const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
    const implementer = profiles.find((p) => p.output === "implementation");
    if (!implementer) throw new Error("implementer profile missing");
    const profile: AgentProfile = { ...implementer, model: "openai/fixture-model" };
    const stepId = store.beginStep(run.runId, "task-T001");
    const attemptId = store.reserve(run.runId, stepId, profile.model, 200_000, fixture.policy);
    const executor = new NativeAgentExecutor(store, new WorkspaceLeases(store), {
      ...fixture.config,
      repoMap: false,
    });
    cleanups.push(() => executor.dispose());
    const request: ExecutionRequest = {
      runId: run.runId,
      attemptId,
      profile,
      prompt: "Implement T001",
      signal: new AbortController().signal,
      maxSteps: 20,
      task,
    };
    const error = await executor.execute(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkflowFault);
    expect((error as WorkflowFault).code).toBe("INPUT_CHANGED");
    expect((error as WorkflowFault).message).toContain("value.txt were refused 3 times");
    expect((error as WorkflowFault).details).toMatchObject({ path: "value.txt", refusals: 3 });
    expect(seen.calls).toBeLessThanOrEqual(4);
  });
});
