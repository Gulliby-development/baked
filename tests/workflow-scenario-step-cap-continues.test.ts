import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { attentionMessage } from "../src/core/workflows/attention-notify.js";
import { reasonText } from "../src/core/workflows/reasons.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// fpbits front T010 (bench R41, #1478): an implementer attempt edited a test file, used 20 of its
// 20 steps at 37% of its token cap without a result being accepted, and the run stopped
// `invalid_output` for a manual resume. A token-cap stop on the same edits continues the task.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};
const call = (name: string, input: unknown): LanguageModelV3GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});
const submit = () =>
  call("submit_result", { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Wrote value.txt", evidenceIds: [], unresolved: [] });

/** The model of the implementer: `respond` sees each prompt and the number of the call. */
function scriptModel(respond: (prompt: LanguageModelV3Prompt) => LanguageModelV3GenerateResult) {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const model = new MockLanguageModelV3({ doGenerate: async (options) => respond(options.prompt) });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
}

/** Runs implementation attempts on the native executor; the first gets `firstSteps` steps. */
class NativeImplementer extends FixtureExecutor {
  native: NativeAgentExecutor | null = null;
  steps: number[] = [];
  requests: ExecutionRequest[] = [];
  constructor(root: string, private readonly firstSteps: number) {
    super(root);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output !== "implementation") return super.execute(request);
    if (!this.native) throw new Error("native executor missing");
    this.requests.push(request);
    const maxSteps = this.steps.length ? request.maxSteps : Math.min(request.maxSteps, this.firstSteps);
    this.steps.push(maxSteps);
    return this.native.execute({ ...request, maxSteps, profile: { ...request.profile, model: "openai/fixture-model" } });
  }
}

function setup(firstSteps = 4) {
  const fixture = workflowFixture({ executor: (root) => new NativeImplementer(root, firstSteps) });
  cleanups.push(fixture.dispose);
  const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
  cleanups.push(() => native.dispose());
  fixture.executor.native = native;
  return fixture;
}

async function drive(fixture: ReturnType<typeof setup>) {
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  return fixture.service.drive(run.runId, new AbortController().signal);
}

const continuing = (prompt: LanguageModelV3Prompt) => JSON.stringify(prompt).includes("already contain the edits");

describe("scenario: an attempt that edited and used its steps (#1478)", () => {
  test("continues the task on its edits with more steps instead of stopping the run", async () => {
    const fixture = setup();
    scriptModel((prompt) => {
      if (continuing(prompt)) {
        if (!JSON.stringify(prompt).includes('"toolName":"edit_file"'))
          return call("edit_file", { path: "value.txt", oldString: "draft", newString: "ready" });
        return submit();
      }
      // The first attempt edits once, then reads until its steps are used and never submits.
      if (!JSON.stringify(prompt).includes('"toolName":"edit_file"'))
        return call("edit_file", { path: "value.txt", oldString: "", newString: "draft" });
      return call("read", { files: [{ path: "value.txt" }], fresh: true });
    });
    const outcome = await drive(fixture);
    expect(outcome.status).toBe("completed");
    expect(fixture.executor.steps).toHaveLength(2);
    // The continuation raised the step cap by half, like a continuation at the token cap.
    expect(fixture.executor.steps[1]).toBe(Math.ceil((fixture.executor.steps[0] ?? 0) * 1.5));
    expect(readFileSync(join(fixture.root, "value.txt"), "utf8")).toBe("ready");
    const records = fixture.executor.requests.map((request) => {
      const artifact = fixture.service.store.latestArtifact(request.runId, `attempts/${request.attemptId}/context.json`);
      expect(artifact).toBeDefined();
      const saved = JSON.parse(fixture.service.store.readArtifact(request.runId, artifact?.id ?? ""));
      const sent = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}").extra;
      expect(saved.earlierEdits).toEqual(sent.earlierEdits);
      return saved;
    });
    expect(records[0].earlierEdits).toBeUndefined();
    expect(records[1].earlierEdits).toMatchObject({ paths: ["value.txt"], patch: expect.stringContaining("draft") });
  }, 60000);

  test("an attempt that used its steps and changed nothing is repeated with more steps", async () => {
    const fixture = setup();
    let attempt = 0;
    let previous = 0;
    scriptModel((prompt) => {
      const length = prompt.length;
      if (length < previous) attempt++;
      previous = length;
      if (attempt === 0) return call("read", { files: [{ path: "notes.md" }], fresh: true });
      if (!JSON.stringify(prompt).includes('"toolName":"edit_file"'))
        return call("edit_file", { path: "value.txt", oldString: "", newString: "ready" });
      return submit();
    });
    const outcome = await drive(fixture);
    expect(outcome.status).toBe("completed");
  }, 60000);

  test("a stop at the step cap names it", () => {
    expect(reasonText("step_cap")).toContain("resuming continues the task");
    expect(attentionMessage({ kind: "step_cap", request_id: null })).toBe("Blocked: needs a resume");
  });
});
