import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { hashJson } from "../src/core/specs/hash.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import type { Spec, Task } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// R46 youngkit (#1565): table labels became missing-case refusals, so the implementer copied
// them into comments. Exercise the real submit_result gate with tests that contain only inputs.
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const spec: Spec = {
  ...fixtureSpec,
  criteria: [{
    ...fixtureSpec.criteria[0]!,
    given: 'the "repeated flag", `success`, and "rank/unrank" scenarios',
    when: "the input cases run",
    then: [
      "| Input | expected |", "| --- | --- |",
      "| repeated flag | last value |", "| success | zero status |",
      "| no arguments | usage |", "| Show(empty) | empty text |",
      "| Join(nil) or Join(empty) | empty text |", "| TEXT | placeholder |",
      "| --max-part=5 and --max-part 5 | equivalent options |",
      "| Join([3,0,-2]) | joined values |",
      "| `--path src/cli` | path selected |",
    ].join("\n"),
  }],
};

const samples = [
  { stack: "bun", path: "tests/cli.test.ts", text: [
    'import { expect, test } from "bun:test";',
    'const Join = (values: number[]) => values.join(",");',
    'test("inputs", () => {',
    '  const path = "src/cli";',
    '  expect(["--path", path]).toEqual(["--path", "src/cli"]);',
    '  expect(Join([3, 0, -2])).toBe("3,0,-2");',
    '  expect(["--max-part", "5"].join("=")).toBe("--max-part=5");',
    '});', "",
  ].join("\n") },
  { stack: "pytest", path: "tests/test_cli.py", text: [
    'def Join(values):', '    return ",".join(map(str, values))',
    'def test_inputs():', '    path = "src/cli"',
    '    assert ["--path", path] == ["--path", "src/cli"]',
    '    assert Join([3, 0, -2]) == "3,0,-2"',
    '    assert "=".join(["--max-part", "5"]) == "--max-part=5"', "",
  ].join("\n") },
  { stack: "go test", path: "cli_test.go", text: [
    'package cli', 'import ("fmt"; "strings"; "testing")',
    'func Join(values []int) string { return fmt.Sprint(values) }',
    'func TestInputs(t *testing.T) {', '  path := "src/cli"',
    '  if strings.Join([]string{"--path", path}, "=") != "--path=src/cli" { t.Fatal(path) }',
    '  if Join([]int{3, 0, -2}) != "[3 0 -2]" { t.Fatal("join") }',
    '  if strings.Join([]string{"--max-part", "5"}, "=") != "--max-part=5" { t.Fatal("option") }',
    '}', "",
  ].join("\n") },
];
type Sample = (typeof samples)[number];

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
  const policy = { ...fixturePolicy, checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", `if (!(await Bun.file(${JSON.stringify(sample.path)}).text()).includes('src/cli')) process.exit(1)`] }] };
  const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, sample) });
  cleanups.push(fixture.dispose);
  const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
  cleanups.push(() => native.dispose());
  fixture.executor.native = native;
  const provider = getProvider("openai");
  if (!provider) throw new Error("OpenAI provider missing");
  const original = provider.createModel;
  cleanups.push(() => { provider.createModel = original; });
  const first = missing ? sample.text.replaceAll("--max-part", "--other") : sample.text;
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

describe("scenario: task-end case labels (#1565)", () => {
  for (const sample of samples) {
    test(`${sample.stack}: input tokens pass without copying scenario labels`, async () => {
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
        `AC-001 names "--max-part=5 and --max-part 5", and no test file this task writes (${sample.path}) contains it.`,
      ]]);
    }, 60000);
  }
});
