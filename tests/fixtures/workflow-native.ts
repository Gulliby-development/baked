import { mock } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";

const queue: LanguageModelV3GenerateResult[] = [];
const model = new MockLanguageModelV3({ doGenerate: async () => { const result = queue.shift(); assert(result, "Unexpected model call"); return result; } });
const originalProvider = { ...await import("../../src/core/llm/provider.js") };
mock.module("../../src/core/llm/provider.js", () => ({ ...originalProvider, resolveModel: () => model }));
const originalOptions = { ...await import("../../src/core/llm/provider-options.js") };
mock.module("../../src/core/llm/provider-options.js", () => ({ ...originalOptions, buildProviderOptions: async () => ({ contextWindow: 128000 }) }));
const { NativeAgentExecutor } = await import("../../src/core/workflows/agent-executor.js");
const { NativeWorkflowService } = await import("../../src/core/workflows/service.js");
const { defaultWorkflowPolicy } = await import("../../src/core/workflows/defaults.js");
const { DEFAULT_CONFIG } = await import("../../src/config/index.js");
const { setCwd } = await import("../../src/core/cwd.js");
const { withinWorkflow } = await import("../../src/core/workflows/leases.js");
const { ProfileSchema } = await import("../../src/core/workflows/schemas.js");
const { hashBytes } = await import("../../src/core/specs/hash.js");
const root = process.env.BAKED_WORKFLOW_FIXTURE_ROOT;
assert(root, "Parent test must provide its temporary workspace");
const previousCwd = process.cwd();
setCwd(root);
const config = { ...DEFAULT_CONFIG, repoMap: false, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: defaultWorkflowPolicy } };
const service = new NativeWorkflowService(root, config);
const executor = new NativeAgentExecutor(service.store, service.leases, config);
function response(toolName: string | null, value: unknown): LanguageModelV3GenerateResult {
  return { content: toolName ? [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName, input: JSON.stringify(value) }] : [{ type: "text", text: String(value) }], finishReason: { unified: toolName ? "tool-calls" : "stop", raw: undefined }, usage: { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 30, text: 30, reasoning: 0 } }, warnings: [] };
}
try {
  const run = await service.start({ commandId: crypto.randomUUID(), featureId: "native", workflowId: "sdd", prompt: "Native tool test", ownerLabel: "test", policy: defaultWorkflowPolicy });
  service.leases.acquire("execution", run.runId); service.leases.acquire("mutation", run.runId);
  service.store.transition(run.runId, "running");
  const profiles = ProfileSchema.array().parse(JSON.parse(service.store.run(run.runId).profiles_json));
  const implementer = profiles.find((p) => p.id === "implementer")!;
  const step = service.store.beginStep(run.runId, "native-tools");
  const attempt = service.store.reserve(run.runId, step, implementer.model, 20000, defaultWorkflowPolicy);
  const task = { id: "T001", title: "Create value", description: "Write value", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" as const }], readHints: [], checkIds: [], origin: "planned" as const, findingIds: [], rationale: "Test" };
  queue.push(response("edit_file", { path: "value.txt", oldString: "", newString: "native" }), response("submit_result", { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Created value", evidenceIds: [], unresolved: [] }));
  await withinWorkflow(service.leases.owner, () => executor.execute({ runId: run.runId, attemptId: attempt, profile: implementer, task, prompt: "Write value using the approved task", signal: new AbortController().signal, maxSteps: 4 }));
  assert.equal(readFileSync(join(root, "value.txt"), "utf8"), "native");
  assert.equal(service.store.effects(run.runId).filter((e) => e.kind === "file_patch" && e.status === "applied").length, 1);
  service.store.finishAttempt(run.runId, attempt, "completed", 100);
  writeFileSync(join(root, "delete.txt"), "remove");
  const deletion = service.store.reserve(run.runId, step, implementer.model, 20000, defaultWorkflowPolicy);
  queue.push(response("delete_file", { path: "delete.txt", expectedHash: hashBytes("remove") }), response("submit_result", { schemaVersion: 1, taskId: "T002", outcome: "implemented", summary: "Deleted file", evidenceIds: [], unresolved: [] }));
  await withinWorkflow(service.leases.owner, () => executor.execute({ runId: run.runId, attemptId: deletion, profile: implementer, task: { ...task, id: "T002", writes: [{ path: "delete.txt", action: "delete" }] }, prompt: "Delete approved file", signal: new AbortController().signal, maxSteps: 4 }));
  assert.equal(await Bun.file(join(root, "delete.txt")).exists(), false);
  service.store.finishAttempt(run.runId, deletion, "completed", 100);
  const researcher = profiles.find((p) => p.id === "researcher")!;
  const research = service.store.reserve(run.runId, step, researcher.model, 20000, defaultWorkflowPolicy);
  queue.push(response(null, "invalid JSON"), response("submit_result", { schemaVersion: 1, summary: "Reformatted", facts: [], unknowns: [], constraints: [], suggestedScope: [] }));
  const result = await executor.execute({ runId: run.runId, attemptId: research, profile: researcher, prompt: "Research fixture", signal: new AbortController().signal, maxSteps: 1 });
  assert.equal((result.output as { summary: string }).summary, "Reformatted");
  assert.equal(model.doGenerateCalls.at(-1)?.tools?.length, 1, "format repair has no editing tools");
  assert.equal(queue.length, 0);
  assert.equal(service.store.attempts(run.runId).length, 4, "format retry consumes a durable attempt");
  const callsBefore = model.doGenerateCalls.length;
  const semantic = service.store.reserve(run.runId, step, researcher.model, 20000, defaultWorkflowPolicy);
  const researchResult = (summary: string) => response("submit_result", { schemaVersion: 1, summary, facts: [], unknowns: [], constraints: [], suggestedScope: [] });
  queue.push(researchResult("bad"), researchResult("good"));
  const validated = await executor.execute({ runId: run.runId, attemptId: semantic, profile: researcher, prompt: "Research fixture", signal: new AbortController().signal, maxSteps: 4, validate: (output) => (output as { summary: string }).summary === "good" ? [] : ["summary must be good"] });
  assert.equal((validated.output as { summary: string }).summary, "good");
  assert.equal(model.doGenerateCalls.length - callsBefore, 2, "the correction happens in the same conversation");
  assert.match(JSON.stringify(model.doGenerateCalls.at(-1)?.prompt), /summary must be good/, "the agent sees the validation errors");
  const bounded = service.store.reserve(run.runId, step, researcher.model, 20000, defaultWorkflowPolicy);
  queue.push(researchResult("bad-1"), researchResult("bad-2"), researchResult("bad-3"));
  const exhausted = await executor.execute({ runId: run.runId, attemptId: bounded, profile: researcher, prompt: "Research fixture", signal: new AbortController().signal, maxSteps: 8, validate: () => ["never valid"] });
  assert.equal((exhausted.output as { summary: string }).summary, "bad-3", "after two corrections the scheduler receives the result and rejects it");
  assert.equal(queue.length, 0);
  console.log(JSON.stringify({ nativeTools: 2, formatRetries: 1, semanticCorrections: 3, modelCalls: model.doGenerateCalls.length }));
} finally {
  executor.dispose(); service.close(); setCwd(previousCwd);
  // The parent removes the workspace after worker SQLite handles close at process exit.
}
process.exit(0);
