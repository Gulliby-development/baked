import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../../src/core/workflows/agent-executor.js";
import type { ExecutionRequest } from "../../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./workflow-fixture.js";

export const refusalKinds = ["taskEndCheck", "caseCheck", "testCapCheck", "reproCheck", "syntax"] as const;
type RefusalKind = (typeof refusalKinds)[number];
const ERROR = "tests/frontmatter.property.test.ts:122: error TS2322: readonly expected tuples are incompatible with string[]";
const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};
const call = (name: string, input: unknown): LanguageModelV3GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [],
});
const prose = (text: string): LanguageModelV3GenerateResult => ({
  content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [],
});

/** Use the real executor for the worker and script the other workflow stages. */
class ScriptedExecutor extends FixtureExecutor {
  native: NativeAgentExecutor | undefined;
  attempts: ExecutionRequest[] = [];
  constructor(root: string, private kind: RefusalKind, private emptyCorrection: boolean) { super(root); }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const response = await super.execute(request);
      const plan = response.output as { taskGraph: { tasks: { writes: { path: string; action: string }[]; checkIds: string[] }[] } };
      if (plan.taskGraph.tasks[0]) plan.taskGraph.tasks[0].checkIds = ["check"];
      if (this.kind === "syntax") {
        plan.taskGraph.tasks[0]?.writes.push({ path: "value.ts", action: "create" });
      }
      return response;
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    if (!this.native) throw new Error("Native executor missing");
    this.attempts.push(request);
    return this.native.execute({
      ...request,
      // The empty correction must reach the scheduler's continuation on the worker's edits.
      ...(this.emptyCorrection || this.kind === "syntax" ? {} : {
        [this.kind]: async (root: string) => readFileSync(join(root, "value.txt"), "utf8") === "ready" ? [] : [ERROR],
      }),
      profile: { ...request.profile, model: "openai/fixture-model" },
    });
  }
}

/** R48 md-site T011: submit, refusal, status report, then repair in the same attempt. */
export async function proseAfterRefusalScenario(kind: RefusalKind, emptyCorrection = false) {
  const provider = getProvider("openai");
  if (!provider) throw new Error("OpenAI provider missing");
  const original = provider.createModel;
  const fixture = workflowFixture({
    policy: { ...fixturePolicy, checks: fixturePolicy.checks.map((check) => ({ ...check, scope: "task" })) },
    executor: (root) => new ScriptedExecutor(root, kind, emptyCorrection),
  });
  const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
  fixture.executor.native = native;
  const submit = call("submit_result", { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] });
  const script = emptyCorrection
    ? [call("edit_file", { path: "value.txt", oldString: "", newString: "draft" }), prose("The work is incomplete."), prose("Still incomplete."), prose(""), call("edit_file", { path: "value.txt", oldString: "draft", newString: "ready" }), submit]
    : [
        call("edit_file", { path: "value.txt", oldString: "", newString: kind === "syntax" ? "ready" : "draft" }),
        ...(kind === "syntax" ? [call("edit_file", { path: "value.ts", oldString: "", newString: "export const value = ;\n" })] : []),
        submit,
        prose("The submission was rejected. That error remains unfixed, and the required checks were not run."),
        call("edit_file", kind === "syntax"
          ? { path: "value.ts", oldString: "export const value = ;", newString: "export const value = 1;" }
          : { path: "value.txt", oldString: "draft", newString: "ready" }),
        submit,
      ];
  const calls: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({ doGenerate: async (options) => {
    calls.push(options);
    return script[calls.length - 1] ?? prose("Script exhausted");
  } });
  provider.createModel = () => model as LanguageModelV3;
  try {
    const run = await fixture.start();
    const signal = new AbortController().signal;
    await fixture.service.drive(run.runId, signal);
    await fixture.approve(run.runId);
    const done = await fixture.service.drive(run.runId, signal);
    expect(done.status).toBe("completed");
    expect(readFileSync(join(fixture.root, "value.txt"), "utf8")).toBe("ready");
    expect(fixture.executor.attempts).toHaveLength(emptyCorrection ? 2 : 1);
    if (!emptyCorrection) {
      const repair = calls[kind === "syntax" ? 4 : 3];
      const last = repair?.prompt.at(-1);
      expect(last?.role).toBe("user");
      expect(JSON.stringify(last)).toContain("Your submit_result was refused");
      expect(JSON.stringify(last)).toContain(kind === "syntax" ? "Syntax error:" : ERROR);
      expect(JSON.stringify(last)).toContain("instruction");
      expect(repair?.tools?.some((tool) => tool.type === "function" && tool.name === "edit_file")).toBe(true);
      expect(repair?.toolChoice?.type).not.toBe("required");
      expect(calls).toHaveLength(script.length);
      const attempt = fixture.executor.attempts[0];
      const artifact = fixture.service.store.latestArtifact(run.runId, `attempts/${attempt?.attemptId}/usage.json`);
      const recorded = JSON.parse(fixture.service.store.readArtifact(run.runId, artifact?.id ?? ""));
      expect(recorded.steps).toHaveLength(script.length);
      expect(recorded.totalTokens).toBe(script.length * 1100);
    } else {
      const failures = fixture.service.store.events(run.runId, 0, 10000).filter((event) => event.type === "attempt.finished");
      expect(JSON.stringify(failures)).toContain("returned no result from format correction");
      expect(JSON.stringify(failures)).not.toContain("SyntaxError");
    }
  } finally {
    provider.createModel = original;
    native.dispose();
    await fixture.dispose();
  }
}
