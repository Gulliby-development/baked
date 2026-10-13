import { afterEach, describe, expect, test } from "bun:test";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { MODEL_OUTPUT_LIMIT, modelCheckOutput } from "../src/core/verification/check-runner.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, ProfileSchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import type { Check, Task } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const FAILED = "FAILED tests/test_cli.py::test_cli_json_and_table_round_trip - AssertionError";

function step(call: { name: string; input: unknown }): LanguageModelV3GenerateResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: crypto.randomUUID(),
        toolName: call.name,
        input: JSON.stringify(call.input),
      },
    ],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: {
      inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 100, text: 100, reasoning: 0 },
    },
    warnings: [],
  };
}

/** Scripts the model; returns the characters of each call's whole input after the first. */
function scriptModel(script: Array<LanguageModelV3GenerateResult | (() => never)>): {
  inputs: number[];
  results: unknown[];
} {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const inputs: number[] = [];
  const results: unknown[] = [];
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const last = options.prompt.at(-1);
      if (last?.role === "tool") {
        results.push(...last.content);
        inputs.push(JSON.stringify(options.prompt).length);
      }
      const next = script[index++];
      if (!next) throw new Error("script exhausted");
      return typeof next === "function" ? next() : next;
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
  return { inputs, results };
}

describe("a check's large output in a tool result (#993)", () => {
  test("a 2 MB failing pytest diff reaches the model bounded, with the failed test named", async () => {
    // Bench round 17, expenses-py T007: `python -m pytest -q` failed with a 2,034,039-character diff
    // of a generated CSV; the next model call carried 2.4 million characters and the codex
    // app-server rejected it (`input_too_large`, limit 1,048,576).
    const script = [
      'const row = "-a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z,0123456789\\n";',
      'let out = "============ test session starts ============\\n";',
      "for (let i = 0; i < 17000; i++) out += row;",
      `out += ${JSON.stringify(`${FAILED}\n`)};`,
      "for (let i = 0; i < 17000; i++) out += row;",
      'out += "1 failed, 41 passed in 3.20s\\n";',
      "process.stdout.write(out);",
      "process.exitCode = 1;",
    ].join("\n");
    const check: Check = {
      id: "tests",
      executable: "bun",
      args: ["-e", script],
      cwd: ".",
      timeoutMs: 60000,
      required: true,
      scope: "feature",
      envNames: [],
      writes: [],
    };
    const policy: RunPolicy = { ...fixturePolicy, checks: [check] };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const { store } = fixture.service;
    const run = await fixture.start();
    store.transaction(() => store.transition(run.runId, "running"));
    const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
    const implementer = profiles.find((p) => p.role === "implementer");
    if (!implementer) throw new Error("implementer profile missing");
    const profile: AgentProfile = { ...implementer, model: "openai/fixture-model" };
    const task: Task = {
      id: "T007",
      title: "CLI tests",
      description: "CLI tests",
      requirementIds: ["FR-001"],
      criterionIds: ["AC-001"],
      dependsOn: [],
      profileId: profile.id,
      writes: [{ path: "tests/test_cli.py", action: "create" }],
      readHints: [],
      checkIds: ["tests"],
      origin: "repair",
      findingIds: [],
      rationale: "Tests",
    };
    const seen = scriptModel([
      step({ name: "request_check", input: { checkId: "tests" } }),
      () => {
        throw new Error("stop after the check");
      },
    ]);
    const stepId = store.beginStep(run.runId, "fixture");
    const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, policy);
    const leases = new WorkspaceLeases(store);
    leases.acquire("mutation", run.runId);
    cleanups.push(() => leases.release());
    const executor = new NativeAgentExecutor(store, leases, { ...fixture.config, repoMap: false });
    cleanups.push(() => executor.dispose());
    await expect(
      executor.execute({
        runId: run.runId,
        attemptId,
        profile,
        task,
        prompt: "Write the CLI tests",
        signal: new AbortController().signal,
        maxSteps: 10,
      }),
    ).rejects.toThrow("stop after the check");

    // The next call stays far below the app-server's 1,048,576-character limit.
    expect(seen.inputs[0]).toBeLessThan(100_000);
    const shown = JSON.stringify(seen.results[0]);
    expect(shown).toContain('"status":"failed"');
    expect(shown).toContain('"truncated":true');
    expect(shown).toContain(FAILED);
    expect(shown).toContain("1 failed, 41 passed");
    expect(shown).toContain("============ test session starts");
    const evidenceId = /"evidenceId":"([^"]+)"/.exec(shown)?.[1];
    expect(shown).toContain(`The full output is in evidence ${evidenceId}`);

    // The evidence keeps the whole output, once.
    const artifact = store
      .artifacts(run.runId)
      .find((a) => a.kind === "check" && a.logical_path.startsWith("checks/tests/"));
    if (!artifact) throw new Error("no check artifact");
    const body = JSON.parse(store.readArtifact(run.runId, artifact.id)) as Record<string, unknown>;
    expect(String(body.output).length).toBeGreaterThan(2_000_000);
    expect(body.stdout).toBeUndefined();
    expect(body.stderr).toBeUndefined();
  }, 60000);
});

describe("modelCheckOutput", () => {
  test("keeps output within the limit as it is", () => {
    const output = "x".repeat(MODEL_OUTPUT_LIMIT);
    expect(modelCheckOutput(output)).toEqual({ output });
  });

  test("keeps the start, the failed test lines and the end of longer output", () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${String(i)} ${"y".repeat(40)}`);
    lines[2000] = "--- FAIL: TestRoundTrip (0.01s)";
    lines[2001] = "test parse::round_trip ... FAILED";
    const output = lines.join("\n");
    const bounded = modelCheckOutput(output, "ev-1");
    expect(bounded.truncated).toBe(true);
    expect(bounded.outputChars).toBe(output.length);
    expect(bounded.output.length).toBeLessThan(MODEL_OUTPUT_LIMIT);
    expect(bounded.output.startsWith("line 0 ")).toBe(true);
    expect(bounded.output.endsWith(lines.at(-1) ?? "")).toBe(true);
    expect(bounded.output).toContain("--- FAIL: TestRoundTrip");
    expect(bounded.output).toContain("test parse::round_trip ... FAILED");
    expect(bounded.output).toContain("The full output is in evidence ev-1.");
  });
});
