import { afterEach, describe, expect, test } from "bun:test";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { hashJson } from "../src/core/specs/hash.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import type { Spec, Task } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { decoySamples, residualSamples, residualSpec } from "./helpers/criteria-residual-fixtures.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }, 60000);

class ScriptedExecutor extends FixtureExecutor {
  native?: NativeAgentExecutor;
  constructor(root: string, private spec: Spec, private path: string) { super(root); }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "spec") return { output: this.spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "implementation") {
      if (!this.native) throw new Error("Native executor missing");
      return this.native.execute({ ...request, profile: { ...request.profile, model: "openai/fixture-model" } });
    }
    const response = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = response.output as { taskGraph: { specHash: string; tasks: Task[] } };
      plan.taskGraph.specHash = hashJson(this.spec);
      plan.taskGraph.tasks[0]!.writes = [{ path: this.path, action: "create" }];
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

async function run(spec: Spec, sample: { path: string; text: string; decoy?: string }) {
  const policy = { ...fixturePolicy, checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", `if (!(await Bun.file(${JSON.stringify(sample.path)}).text()).length) process.exit(1)`] }] };
  const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, spec, sample.path) });
  cleanups.push(fixture.dispose);
  const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
  cleanups.push(() => native.dispose());
  fixture.executor.native = native;
  const provider = getProvider("openai");
  if (!provider) throw new Error("OpenAI provider missing");
  const original = provider.createModel;
  cleanups.push(() => { provider.createModel = original; });
  const first = sample.decoy ?? sample.text;
  const script = [() => call("edit_file", { path: sample.path, oldString: "", newString: first }), submit];
  if (sample.decoy) script.push(() => call("edit_file", { path: sample.path, oldString: first, newString: sample.text }));
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
  return { done, diagnostics, step };
}

describe("scenario: task-end residual literal cells (#1629)", () => {
  for (const sample of residualSamples) test(`${sample.stack}: ${sample.name} needs no decoy`, async () => {
    const { done, diagnostics } = await run(residualSpec(sample), sample);
    expect(done.status).toBe("completed");
    expect(diagnostics).toEqual([]);
  }, 60000);

  for (const sample of decoySamples) test(`${sample.stack}: a diagnostic decoy is refused, then the input is added`, async () => {
    const spec = { ...fixtureSpec, criteria: [{ ...fixtureSpec.criteria[0]!, then: 'input `--case-42` is accepted' }] };
    const { done, diagnostics, step } = await run(spec, sample);
    expect(done.status).toBe("completed");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.missing).toHaveLength(1);
    expect(diagnostics[0]!.missing[0]).toContain("message alone is a decoy");
    expect(step).toBe(4);
  }, 60000);
});
