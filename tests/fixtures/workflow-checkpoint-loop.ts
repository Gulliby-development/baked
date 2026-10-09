import { mock } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult, LanguageModelV3Prompt } from "@ai-sdk/provider";

// A scripted researcher that reads FILES files one per step and then submits. Its reported usage is
// the size of the request it received, as a real provider's input tokens would be, so a soft
// checkpoint has to stop the loop between two steps rather than after the attempt.
const FILES = 16;
const FILE_CHARS = 20_000;
let promptsSeen: LanguageModelV3Prompt[] = [];
const sizeOf = (prompt: LanguageModelV3Prompt): number => Math.ceil(JSON.stringify(prompt).length / 4);
const model = new MockLanguageModelV3({
  doGenerate: async (options): Promise<LanguageModelV3GenerateResult> => {
    promptsSeen.push(options.prompt);
    const reads = options.prompt.filter((m) => m.role === "tool").length;
    const input = sizeOf(options.prompt);
    const usage = { inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 50, text: 50, reasoning: 0 } };
    const call = reads < FILES
      ? { toolName: "read", input: { files: [{ path: `docs/f${reads}.txt` }] } }
      : { toolName: "submit_result", input: { schemaVersion: 1, summary: "Read every file", facts: [], unknowns: [], constraints: [], suggestedScope: [] } };
    return { content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: call.toolName, input: JSON.stringify(call.input) }], finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [] };
  },
});
const originalProvider = { ...await import("../../src/core/llm/provider.js") };
mock.module("../../src/core/llm/provider.js", () => ({ ...originalProvider, resolveModel: () => model }));
const originalOptions = { ...await import("../../src/core/llm/provider-options.js") };
mock.module("../../src/core/llm/provider-options.js", () => ({ ...originalOptions, buildProviderOptions: async () => ({ contextWindow: 1_000_000 }) }));
const { NativeAgentExecutor } = await import("../../src/core/workflows/agent-executor.js");
const { NativeWorkflowService } = await import("../../src/core/workflows/service.js");
const { defaultWorkflowPolicy } = await import("../../src/core/workflows/defaults.js");
const { DEFAULT_CONFIG } = await import("../../src/config/index.js");
const { setCwd } = await import("../../src/core/cwd.js");
const { withinWorkflow } = await import("../../src/core/workflows/leases.js");
const { ProfileSchema } = await import("../../src/core/workflows/schemas.js");
const root = process.env.BAKED_WORKFLOW_FIXTURE_ROOT;
assert(root, "Parent test must provide its temporary workspace");
const previousCwd = process.cwd();
setCwd(root);
mkdirSync(join(root, "docs"), { recursive: true });
// Ordinary source-like files of 80-character lines; the read tool cuts a single huge line short.
const body = (i: number): string =>
  Array.from({ length: Math.floor(FILE_CHARS / 80) }, (_, line) => `line ${line} of file ${i}: ${"abcdefghij".repeat(6)}`).join("\n");
for (let i = 0; i < FILES; i++) writeFileSync(join(root, "docs", `f${i}.txt`), `File ${i}\n${body(i)}\nend of file ${i}\n`);
const policy = { ...defaultWorkflowPolicy };
const config = { ...DEFAULT_CONFIG, repoMap: false, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy } };

async function research(limit: number, extra: { checkpointTokens?: number } = {}) {
  const service = new NativeWorkflowService(root as string, config);
  const executor = new NativeAgentExecutor(service.store, service.leases, config);
  promptsSeen = [];
  try {
    const run = await service.start({ commandId: crypto.randomUUID(), featureId: `research-${limit}-${extra.checkpointTokens ?? 0}`, workflowId: "sdd", prompt: "Research the docs", ownerLabel: "test", policy: { ...policy, maxTotalTokens: limit, ...extra } });
    service.leases.acquire("execution", run.runId); service.leases.acquire("mutation", run.runId);
    service.store.transition(run.runId, "running");
    const researcher = ProfileSchema.array().parse(JSON.parse(service.store.run(run.runId).profiles_json)).find((p) => p.id === "researcher")!;
    const step = service.store.beginStep(run.runId, "research");
    const runPolicy = { ...policy, maxTotalTokens: limit, ...extra };
    const attempt = service.store.reserve(run.runId, step, researcher.model, 20000, runPolicy);
    let outcome: "completed" | "budget_exhausted" | "checkpoint" = "completed";
    try {
      await withinWorkflow(service.leases.owner, () => executor.execute({ runId: run.runId, attemptId: attempt, profile: researcher, prompt: "Read every file under docs and summarize", signal: new AbortController().signal, maxSteps: FILES + 4 }));
    } catch (error) {
      const code = (error as { code?: string }).code;
      assert(code === "BUDGET_EXHAUSTED" || code === "CHECKPOINT_REACHED", `unexpected failure: ${String(error)}`);
      outcome = code === "CHECKPOINT_REACHED" ? "checkpoint" : "budget_exhausted";
    }
    const inputTokens = promptsSeen.reduce((sum, prompt) => sum + sizeOf(prompt), 0);
    return { outcome, calls: promptsSeen.length, inputTokens };
  } finally {
    executor.dispose(); service.close();
  }
}

try {
  // A soft checkpoint stops a runaway loop inside one attempt, between two steps and before the
  // spend: the error reaches the caller as a typed fault and the attempt never reserved past it.
  const guarded = await research(1_000_000_000, { checkpointTokens: 60_000 });
  assert.equal(guarded.outcome, "checkpoint");
  assert(guarded.calls > 1 && guarded.calls <= FILES, "the loop stopped part-way, not at the end");
  assert(guarded.inputTokens <= 60_000, `requests stayed within the checkpoint: ${guarded.inputTokens}`);
  console.log(JSON.stringify({ checkpointLoop: "passed", checkpointStoppedLoopAfterCalls: guarded.calls }));
} finally {
  setCwd(previousCwd);
}
process.exit(0);
