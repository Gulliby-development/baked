import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { hashBytes } from "../src/core/specs/hash.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, ProfileSchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

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
    expect((error as WorkflowFault).details).toMatchObject({ path: "value.txt", refusals: 3, root: "", hash: hashBytes("old\n") });
    expect((error as WorkflowFault).message).toContain("--accept-workspace");
    expect(seen.calls).toBeLessThanOrEqual(4);
  });

  test("a stop by refusals waits for a decision instead of repeating on a plain resume (#1269)", async () => {
    // Bench R29, seqtext ead875e0: each of 8 plain resumes started an attempt whose edits of the
    // same file were refused again (about $0.3 each). The file stays as it is until someone keeps
    // it or puts back the run's content, so a plain resume is refused with both choices.
    const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume" } });
    cleanups.push(fixture.dispose);
    const { service, executor, root } = fixture;
    const file = join(root, "usage.txt");
    writeFileSync(file, "original usage\n");
    let attempts = 0;
    const original = executor.execute.bind(executor);
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output !== "implementation") {
        const out = await original(request);
        if (request.profile.output === "plan") {
          const plan = out.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
          plan.taskGraph.tasks[0]?.writes.unshift({ path: "usage.txt", action: "modify" });
        }
        return out;
      }
      attempts++;
      const policy = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
      const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, policy, request.task);
      if (attempts === 1) {
        await guard.execute("edit_file", { path: "usage.txt" }, async () => writeFileSync(file, "draft"));
        // A person edits the file while the task is unfinished.
        writeFileSync(file, "edited by a person\n");
        return { output: { schemaVersion: 1, taskId: request.task?.id, outcome: "blocked", summary: "Out of steps", evidenceIds: [], unresolved: ["draft"] }, inputTokens: 25, outputTokens: 25 };
      }
      let refusals = 0;
      for (let i = 0; i < 3; i++)
        await guard.execute("edit_file", { path: "usage.txt" }, async () => writeFileSync(file, "ready")).catch(() => refusals++);
      // What the native executor's breaker throws at the third refusal.
      if (refusals === 3)
        throw new WorkflowFault("INPUT_CHANGED", "Edits to usage.txt were refused 3 times: File changed outside this attempt", { path: "usage.txt", refusals, root: "", hash: hashBytes("edited by a person\n") });
      await guard.execute("edit_file", { path: "value.txt" }, async () => writeFileSync(join(root, "value.txt"), "ready"));
      return { output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    };
    const signal = new AbortController().signal;
    const run = await fixture.start();
    await service.drive(run.runId, signal);
    await fixture.approve(run.runId);
    await fixture.resume(run.runId);
    expect(await service.drive(run.runId, signal)).toMatchObject({ status: "blocked", reason: "input_changed" });
    expect(attempts).toBe(2);
    const revision = async () => (await service.get(run.runId)).revision;
    await expect(service.resume(run.runId, { commandId: newId(), expectedRevision: await revision() })).rejects.toThrow("still differs from what the run recorded");
    expect(attempts).toBe(2);
    // Keeping the file is the decision: the next attempt edits it from there.
    await service.resume(run.runId, { commandId: newId(), expectedRevision: await revision() }, { acceptWorkspace: true });
    expect(await service.drive(run.runId, signal)).toMatchObject({ status: "completed" });
    expect(attempts).toBe(3);
    expect(readFileSync(file, "utf8")).toBe("ready");
  });
});
