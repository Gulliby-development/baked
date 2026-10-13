import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, ProfileSchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};
const toolStep = (name: string, input: unknown): LanguageModelV3GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});
const proseStep = (text: string): LanguageModelV3GenerateResult => ({
  content: [{ type: "text", text }],
  finishReason: { unified: "stop", raw: undefined },
  usage,
  warnings: [],
});

/** Route `openai/*` to a scripted model and keep every prompt it received. */
function scriptModel(script: LanguageModelV3GenerateResult[]): string[] {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const prompts: string[] = [];
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const next = script[index++];
      if (!next) throw new Error("script exhausted");
      return next;
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
  return prompts;
}

async function nativeAttempt() {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { store } = fixture.service;
  const run = await fixture.start();
  store.transaction(() => store.transition(run.runId, "running"));
  const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
  const researcher = profiles.find((p) => p.output === "research");
  if (!researcher) throw new Error("research profile missing");
  const profile: AgentProfile = { ...researcher, model: "openai/fixture-model" };
  const stepId = store.beginStep(run.runId, "fixture");
  const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, fixture.policy);
  const executor = new NativeAgentExecutor(store, new WorkspaceLeases(store), { ...fixture.config, repoMap: false });
  cleanups.push(() => executor.dispose());
  const request: ExecutionRequest = {
    runId: run.runId,
    attemptId,
    profile,
    prompt: "Research the fixture",
    signal: new AbortController().signal,
    maxSteps: 10,
  };
  return { store, run, attemptId, executor, request };
}

const research = { schemaVersion: 1, summary: "Fixture researched", facts: [], unknowns: [], constraints: [], suggestedScope: [] };

describe("a step that ends without a tool call (executor)", () => {
  test("is continued in the same conversation and the submission is accepted", async () => {
    const prompts = scriptModel([proseStep("The research is done, nothing more to add."), toolStep("submit_result", research)]);
    const { executor, request } = await nativeAttempt();
    await expect(executor.execute(request)).resolves.toMatchObject({ output: research });
    expect(prompts).toHaveLength(2);
    // The second call replays the first answer and asks for the submission; no reformat session.
    expect(prompts[1]).toContain("The research is done, nothing more to add.");
    expect(prompts[1]).toContain("Research the fixture");
    expect(prompts[1]).toContain("without calling submit_result");
    expect(prompts[1]).not.toContain("Reformat this previous result");
  });

  test("that ends on text again fails as prose_end and stores what the model said", async () => {
    scriptModel([proseStep("All done, tests pass."), proseStep("Still just text."), proseStep("not json either")]);
    const { store, run, attemptId, executor, request } = await nativeAttempt();
    const error = await executor.execute(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkflowFault);
    expect((error as WorkflowFault).code).toBe("OUTPUT_INVALID");
    expect((error as WorkflowFault).details.reason).toBe("prose_end");
    const artifact = store.latestArtifact(run.runId, `attempts/${attemptId}/prose-end.json`);
    expect(artifact).toBeDefined();
    expect(store.readArtifact(run.runId, artifact?.id ?? "")).toContain("Still just text.");
  });
});

/** An implementer whose session ends on text; the file it wrote is what the host can see. */
class ProseEndExecutor extends FixtureExecutor {
  implementations = 0;
  constructor(
    private dir: string,
    private contents: string[],
  ) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const planned = await super.execute(request);
      const plan = planned.output as { taskGraph: { tasks: { checkIds: string[] }[] } };
      for (const task of plan.taskGraph.tasks) task.checkIds = ["check"];
      return planned;
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    const content = this.contents[this.implementations++];
    if (content === undefined) return super.execute(request);
    writeFileSync(join(this.dir, "value.txt"), content);
    throw new WorkflowFault("OUTPUT_INVALID", "returned invalid output after one format correction", {
      reason: "prose_end",
      prose: "I finished the change and the tests pass.",
    });
  }
}

const taskPolicy: RunPolicy = { ...fixturePolicy, checks: [{ ...fixturePolicy.checks[0]!, scope: "task" }] };

describe("a task whose implementer ended on text (scheduler)", () => {
  async function drive(contents: string[]) {
    const fixture = workflowFixture({ policy: taskPolicy, executor: (root) => new ProseEndExecutor(root, contents) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const outcome = await fixture.service.drive(run.runId, new AbortController().signal);
    return { fixture, run, outcome };
  }

  test("the host records the implementation when the task has a change and its checks pass", async () => {
    const { fixture, run, outcome } = await drive(["ready"]);
    expect(outcome.status).toBe("completed");
    const { store } = fixture.service;
    expect(store.latestArtifact(run.runId, "tasks/T001/host-result.json")).toBeDefined();
    expect(store.latestArtifact(run.runId, "tasks/restarts/T001.json")).toBeNull();
    expect((fixture.executor as ProseEndExecutor).implementations).toBe(1);
  });

  test("with a failing task check the same ending restarts the task once in a fresh session", async () => {
    const { fixture, run, outcome } = await drive(["broken"]);
    const { store } = fixture.service;
    const restart = store.latestArtifact(run.runId, "tasks/restarts/T001.json");
    expect(restart).toBeDefined();
    expect(store.readArtifact(run.runId, restart?.id ?? "")).toContain("text reply");
    expect(
      store
        .events(run.runId, 0, 10000)
        .some((e) => e.type === "task.state_changed" && e.payload.to === "interrupted" && e.payload.cause === "restart"),
    ).toBe(true);
    expect(store.latestArtifact(run.runId, "tasks/T001/host-result.json")).toBeNull();
    // The restarted session implements the task for real.
    expect(outcome.status).toBe("completed");
  });
});
