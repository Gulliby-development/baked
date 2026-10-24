import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const REFUSAL = "The acceptance-rows block in tests/test_tags.py is missing or changed";
const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};
const call = (name: string, input: unknown): LanguageModelV3GenerateResult => ({
  content: [
    { type: "tool-call", toolCallId: crypto.randomUUID(), toolName: name, input: JSON.stringify(input) },
  ],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});
const prose = (text: string): LanguageModelV3GenerateResult => ({
  content: [{ type: "text", text }],
  finishReason: { unified: "stop", raw: undefined },
  usage,
  warnings: [],
});
const blocked = {
  schemaVersion: 1,
  taskId: "T001",
  outcome: "blocked",
  summary: "The host flags the rows block",
  evidenceIds: [],
  unresolved: ["rows block"],
};

/** The worker runs on the real executor; its first session's validator refuses every result. */
class RefusingWorker extends FixtureExecutor {
  native: NativeAgentExecutor | undefined;
  attempts: ExecutionRequest[] = [];
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      // The task's own check runs when the session ends, as the rows task's lint did in R60.
      const response = await super.execute(request);
      const plan = response.output as { taskGraph: { tasks: { checkIds: string[] }[] } };
      if (plan.taskGraph.tasks[0]) plan.taskGraph.tasks[0].checkIds = ["check"];
      return response;
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    if (!this.native) throw new Error("Native executor missing");
    this.attempts.push(request);
    const first = this.attempts.length === 1;
    return this.native.execute({
      ...request,
      ...(first ? { validate: () => [REFUSAL] } : {}),
      profile: { ...request.profile, model: "openai/fixture-model" },
    });
  }
}

/**
 * R60 tags T002: the worker submits, the validator refuses, it ends in prose, and the format
 * correction's submit_result is refused too. With `edits` the first session wrote a file first.
 */
async function refusedCorrection(edits: boolean) {
  const provider = getProvider("openai");
  if (!provider) throw new Error("OpenAI provider missing");
  const original = provider.createModel;
  const fixture = workflowFixture({
    policy: {
      ...fixturePolicy,
      checks: fixturePolicy.checks.map((check) => ({ ...check, scope: "task" })),
    },
    executor: (root) => new RefusingWorker(root),
  });
  const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, {
    ...fixture.config,
    repoMap: false,
  });
  fixture.executor.native = native;
  const calls: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push(options);
      const text = JSON.stringify(options.prompt);
      if (text.includes("Reformat this previous result")) return call("submit_result", blocked);
      if (fixture.executor.attempts.length > 1) {
        writeFileSync(join(fixture.root, "value.txt"), "ready");
        return call("submit_result", {
          ...blocked,
          outcome: "implemented",
          summary: "Wrote value",
          unresolved: [],
        });
      }
      if (calls.length === 1 && edits)
        return call("edit_file", { path: "value.txt", oldString: "", newString: "draft" });
      if (calls.length === (edits ? 2 : 1)) return call("submit_result", blocked);
      return prose("Submission remains blocked because the host flags its acceptance-rows block.");
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  try {
    const run = await fixture.start();
    const signal = new AbortController().signal;
    await fixture.service.drive(run.runId, signal);
    await fixture.approve(run.runId);
    await fixture.service.drive(run.runId, signal);
    const events = JSON.stringify(fixture.service.store.events(run.runId, 0, 10000));
    expect(events).toContain("submitted a result in the format correction that the host refused");
    expect(events).toContain(REFUSAL);
    expect(events).not.toContain("returned no result from format correction");
    // Without edits the step is repeated once, told what the host refused; with edits the task
    // restarts from the host's account of the session, which names the refusal.
    // Without edits the step is repeated once, told what the host refused; with edits the task
    // restarts from the host's account of the session, which names the refusal.
    const restart = fixture.executor.attempts[1]?.prompt ?? "";
    expect(restart).toContain(edits ? "previousAttempt" : "refusedSubmission");
    expect(restart).toContain(edits ? `The host refused its submit_result: ${REFUSAL}` : REFUSAL);
    expect(restart).not.toContain("never called submit_result");
  } finally {
    provider.createModel = original;
    native.dispose();
    await fixture.dispose();
  }
}

describe("scenario: a format correction the host refuses (#1933, R60 tags T002)", () => {
  test("the error names the refusal and the repeated step reads it", async () => {
    await refusedCorrection(false);
  }, 60000);

  test("a restart after edits reads the refusal in the earlier session's account", async () => {
    await refusedCorrection(true);
  }, 60000);
});
