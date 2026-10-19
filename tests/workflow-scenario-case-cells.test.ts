import { cellSamples, cellSpec as spec, omittedCellInput, withoutCellInput } from "./helpers/criteria-cell-fixtures.js";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { hashJson } from "../src/core/specs/hash.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import type { Task } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// R48 (#1614): table inputs and context became one impossible literal.
// Exercise the real submit_result gate with inputs in different source spellings.
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 60000);

type Sample = (typeof cellSamples)[number];

class ScriptedExecutor extends FixtureExecutor {
  native?: NativeAgentExecutor;
  constructor(root: string, private sample: Sample) { super(root); }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "implementation") {
      if (!this.native) throw new Error("Native executor missing");
      return this.native.execute({ ...request, profile: { ...request.profile, model: "openai/fixture-model" } });
    }
    const response = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = response.output as { taskGraph: { specHash: string; tasks: Task[] } };
      plan.taskGraph.specHash = hashJson(spec);
      plan.taskGraph.tasks[0]!.writes = [{ path: this.sample.path, action: "create" }];
    }
    return response;
  }
}

const call = (toolName: string, input: unknown): LanguageModelV3GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 100, text: 100, reasoning: 0 } },
  warnings: [],
});
const submit = () => call("submit_result", { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Tested inputs", evidenceIds: [], unresolved: [] });

async function run(sample: Sample, missing = false) {
  const policy = { ...fixturePolicy, checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", `if (!(await Bun.file(${JSON.stringify(sample.path)}).text()).includes('example.com')) process.exit(1)`] }] };
  const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, sample) });
  cleanups.push(fixture.dispose);
  const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
  cleanups.push(() => native.dispose());
  fixture.executor.native = native;
  const provider = getProvider("openai");
  if (!provider) throw new Error("OpenAI provider missing");
  const original = provider.createModel;
  cleanups.push(() => { provider.createModel = original; });
  const first = missing ? withoutCellInput(sample.text) : sample.text;
  const script = [() => call("edit_file", { path: sample.path, oldString: "", newString: first }), submit];
  if (missing) script.push(() => call("edit_file", { path: sample.path, oldString: first, newString: sample.text }));
  // The unchanged retry lets main complete too; the diagnostic assertion detects its false refusal.
  script.push(submit);
  let step = 0;
  const model = new MockLanguageModelV3({ doGenerate: async () => {
    const next = script[step++];
    if (!next) throw new Error("Script exhausted");
    return next();
  } });
  provider.createModel = () => model as LanguageModelV3;
  const started = await fixture.start();
  await fixture.service.drive(started.runId, new AbortController().signal);
  await fixture.approve(started.runId);
  const done = await fixture.service.drive(started.runId, new AbortController().signal);
  const diagnostics = fixture.service.store.artifacts(started.runId)
    .filter((a) => a.logical_path.includes("/cases-"))
    .map((a) => JSON.parse(fixture.service.store.readArtifact(started.runId, a.id)) as { missing: string[] });
  return { done, diagnostics, text: readFileSync(join(fixture.root, sample.path), "utf8") };
}

describe("scenario: task-end multi-input cells and escape spellings (#1614)", () => {
  for (const sample of cellSamples) {
    test(`${sample.stack}: separate inputs pass without copying table prose`, async () => {
      const { done, diagnostics, text } = await run(sample);
      expect(done.status).toBe("completed");
      expect(text).toBe(sample.text);
      expect(diagnostics).toEqual([]);
    }, 60000);
    test(`${sample.stack}: a missing concrete input is refused and fixed in the same attempt`, async () => {
      const { done, diagnostics, text } = await run(sample, true);
      expect(done.status).toBe("completed");
      expect(text).toBe(sample.text);
      expect(diagnostics.map((d) => d.missing)).toEqual([[
        `AC-001 names ${JSON.stringify(omittedCellInput)}, and no test file this task writes (${sample.path}) contains it.`,
      ]]);
    }, 60000);
  }
});
