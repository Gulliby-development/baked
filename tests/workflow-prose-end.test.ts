import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";
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
function scriptModel(script: LanguageModelV3GenerateResult[], choices: LanguageModelV3CallOptions["toolChoice"][] = []): string[] {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const prompts: string[] = [];
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      choices.push(options.toolChoice);
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

async function nativeAttempt(output = "research") {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { store } = fixture.service;
  const run = await fixture.start();
  store.transaction(() => store.transition(run.runId, "running"));
  const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
  const researcher = profiles.find((p) => p.output === output);
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
  return { fixture, store, run, attemptId, executor, request };
}

const research = { schemaVersion: 1, summary: "Fixture researched", facts: [], unknowns: [], constraints: [], suggestedScope: [] };

describe("a step that ends without a tool call (executor)", () => {
  test.each(["plan", "review"])("a refused %s followed by prose gets its exact validator error in the same attempt", async (output) => {
    const { fixture, executor, request } = await nativeAttempt(output);
    const result = await fixture.executor.execute({ ...request, prompt: JSON.stringify({ snapshotHash: "a".repeat(64), extra: {} }) });
    const prompts = scriptModel([
      toolStep("submit_result", result.output),
      proseStep("The result was rejected and remains unfixed."),
      toolStep("submit_result", result.output),
    ]);
    let validations = 0;
    const response = await executor.execute({ ...request, validate: () => validations++ === 0 ? ["AC-001 needs current evidence E1"] : [] });
    expect(response.output).toMatchObject({ schemaVersion: 1 });
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain("Your submit_result was refused");
    expect(prompts[2]).toContain("AC-001 needs current evidence E1");
    expect(prompts[2]).toContain("The result was rejected and remains unfixed.");
    expect(prompts[2]).not.toContain("Reformat this previous result");
  });

  test("the refusal recovery runs once even when the model keeps ending on prose", async () => {
    const prompts = scriptModel([toolStep("submit_result", research), proseStep("Unfixed"), proseStep("Still unfixed"), proseStep("No result"), proseStep("invalid json")]);
    const { executor, request } = await nativeAttempt();
    await expect(executor.execute({ ...request, validate: () => ["Missing evidence"] })).rejects.toThrow("after one format correction");
    expect(prompts).toHaveLength(5);
    const finalHistory = JSON.parse(prompts[3] ?? "[]") as { role: string; content: unknown }[];
    expect(finalHistory.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("Your submit_result was refused"))).toHaveLength(1);
  });

  test("the refusal recovery cannot add steps past the original limit", async () => {
    const prompts = scriptModel([toolStep("submit_result", research), proseStep("Unfixed"), proseStep("invalid json")]);
    const { executor, request } = await nativeAttempt();
    await expect(executor.execute({ ...request, maxSteps: 2, validate: () => ["Missing evidence"] })).rejects.toThrow("after one format correction");
    expect(prompts).toHaveLength(3);
    expect(prompts.join()).not.toContain("Your submit_result was refused");
  });

  test("the refusal recovery finalizes against tokens spent before the recovery", async () => {
    const choices: LanguageModelV3CallOptions["toolChoice"][] = [];
    const read = toolStep("read", { files: [{ path: "notes.md" }], fresh: true });
    const prompts = scriptModel([
      ...Array.from({ length: 7 }, (_, i) => toolStep("read", { files: [{ path: `note-${i}.md` }], fresh: true })),
      toolStep("submit_result", research), proseStep("The evidence is still missing."),
      read, toolStep("submit_result", research),
    ], choices);
    const { executor, request, store, run, attemptId } = await nativeAttempt();
    let validations = 0;
    await executor.execute({ ...request, maxSteps: 20, maxTokens: 13_000, validate: () => validations++ === 0 ? ["Missing evidence"] : [] });
    expect(prompts).toHaveLength(11);
    expect(prompts[9]).toContain("Your submit_result was refused");
    expect(choices[9]?.type).not.toBe("required");
    expect(choices[10]?.type).toBe("required");
    const artifact = store.latestArtifact(run.runId, `attempts/${attemptId}/usage.json`);
    expect(JSON.parse(store.readArtifact(run.runId, artifact?.id ?? ""))).toMatchObject({ totalTokens: 12_100, finalizedBy: "tokens", maxTokens: 13_000 });
  });

  test.each(["", "   \n"])("an empty correction %j is no_submission instead of a JSON parse error", async (text) => {
    scriptModel([proseStep("Not finished"), proseStep("Still not finished"), proseStep(text)]);
    const { executor, request, store, run } = await nativeAttempt();
    const error = await executor.execute(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkflowFault);
    expect((error as WorkflowFault).details.reason).toBe("no_submission");
    expect((error as Error).message).toContain("returned no result from format correction");
    expect(JSON.stringify(store.attempts(run.runId))).not.toContain("SyntaxError");
  });

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
