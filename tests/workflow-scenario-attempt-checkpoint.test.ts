import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { canonical, hashBytes, hashJson } from "../src/core/specs/hash.js";
import { CheckRunner } from "../src/core/verification/check-runner.js";
import { attemptCapFault, NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import {
  type AttemptCheckpoint,
  CheckpointTracker,
  checkpointPath,
  recordCheckpointWouldFinish,
  saveCheckpoint,
} from "../src/core/workflows/attempt-checkpoint.js";
import { promptParts } from "../src/core/workflows/context.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { withinWorkflow } from "../src/core/workflows/leases.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import { type AgentProfile, type Check, ProfileSchema, type Repro, type RunPolicy, type Spec, type Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { newId } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import { replayAttemptCheckpoints } from "../src/core/workflows/trace.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 79, deltaglue chunks T004, third attempt c8e5afe0 (#2470). A corrective
// on a large test file reached a state at 23:19:15-23:19:17Z where `tests-affected`, `tests`,
// `typecheck` and `lint` all passed; the model then read a file, edited twice more, the checks
// failed, and at 23:19:40 the attempt ended at its all-token cap (839,599 of 750,000 tokens, 98,863
// of 250,000 uncached). The host finish after a stop (#1978) saw only the failing end and the run
// blocked `attempt_cap`. The attempt now keeps its green checkpoint, and the unfinished end records
// `decision.would_finish` with that state's evidence, in shadow: the task's path is unchanged.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Tags", problem: "Tags parse wrong", outcome: "Tags parse", inScope: ["Parse tags"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "A tag list with a bracket inside parses as written", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "tags: [a], b]", when: "it parses", then: "the tags are [a] and b", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA front-matter parser.\n## Decisions\nDEC-001: FR-001 in src/tags.ts.\n## Components\nsrc/tags.ts, src/page.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
// A large file around the fix, as deltaglue's 1,000-line test file.
const BULK = Array.from({ length: 1000 }, (_, i) => `// row ${i}: ${"x".repeat(60)}`).join("\n");
const BROKEN = `${BULK}\nexport const parseTagItem = (s: string) => s.split(",");\n`;
const FIXED = `${BULK}\nexport const parseTagItem = (s: string) => {\n  // fixed: a bracket inside an item\n  return s.split(/,(?![^[]*\\])/).map((part) => part.trim());\n};\n`;
// The edit after the green state: the fix stays (the repro passes) but the file breaks typecheck.
const BROKE_AGAIN = `${FIXED}// half a cleanup\n`;
const PROGRAM = "const t = await Bun.file('src/tags.ts').text(); console.log(t.includes('fixed') ? 'a],b' : 'a,],b')";
const repro: Repro = { executable: "bun", args: ["-e", PROGRAM], expected: "a],b", actual: "a,],b" };
const typecheck: Check = { id: "typecheck", executable: "bun", args: ["-e", "const t = await Bun.file('src/tags.ts').text(); if (t.includes('half')) { console.log('src/tags.ts: half a cleanup'); process.exit(1) }"], cwd: ".", timeoutMs: 10000, required: true, scope: "task", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [typecheck, { ...typecheck, id: "tests", scope: "feature" }] };
const planned: Task = { id: "T001", title: "Write the parser", description: "Write src/tags.ts and src/page.ts", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/tags.ts", action: "create" }, { path: "src/page.ts", action: "create" }], readHints: [], checkIds: ["typecheck"], origin: "planned", findingIds: [], rationale: "Required behavior" };

/** How the corrective's first session goes before it ends at its cap. */
type FirstSession = "green-then-broken" | "never-green";

class ScriptedExecutor implements AgentExecutor {
  sessions: { taskId: string; checkpointChecks: string[] | undefined }[] = [];
  service?: NativeWorkflowService;
  constructor(
    private workspace: string,
    private first: FirstSession,
    /** Whether the session keeps a checkpoint as the native executor does; off is the control run. */
    private tracked: boolean,
  ) {}
  async execute(request: ExecutionRequest) {
    const root = request.root ?? this.workspace;
    const write = (path: string, text: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    switch (request.profile.output) {
      case "research": return this.done({ schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/tags.ts"] });
      case "spec": return this.done(spec);
      case "plan": return this.done({ schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned] } });
      case "analysis": return this.done({ schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] });
      case "implementation": {
        const task = request.task as Task;
        if (task.origin === "planned") {
          write("src/tags.ts", BROKEN);
          write("src/page.ts", "export const page = 1;\n");
          return this.done({ schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Wrote the parser", evidenceIds: [], unresolved: [] });
        }
        this.sessions.push({ taskId: task.id, checkpointChecks: request.checkpointChecks });
        if (this.sessions.length > 1) {
          write("src/tags.ts", FIXED);
          return this.done({ schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Fixed parseTagItem", evidenceIds: [], unresolved: [] });
        }
        await this.firstSession(request, root, task);
        throw attemptCapFault(request.profile.id, 98_863, 250_000, { totalTokens: 839_599, allTokensCap: 750_000 });
      }
      case "review": return this.done(pass);
      case "convergence": {
        if (readFileSync(join(root, "src/tags.ts"), "utf8").includes("fixed")) return this.done(pass);
        const finding = { id: "F1", kind: "correctness", severity: "medium", basis: "spec", confidence: 0.99, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "src/tags.ts", symbol: "parseTagItem", evidenceIds, claim: "parseTagItem splits `tags: [a], b]` inside the bracket", impact: "Tags with a bracket are wrong", suggestedFix: "Split outside brackets", repro };
        return this.done({ schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: "Brackets split" }], findings: [finding] });
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
  }
  private done(output: unknown) {
    return { output, inputTokens: 20, outputTokens: 30 };
  }
  /** The corrective's first session, as the native executor runs its tools: journaled edits, host checks. */
  private async firstSession(request: ExecutionRequest, root: string, task: Task) {
    const service = this.service as NativeWorkflowService;
    const { store } = service;
    const runPolicy = JSON.parse(store.run(request.runId).policy_json) as RunPolicy;
    const guard = new WorkflowToolPolicy(store, service.leases, request.runId, request.attemptId, request.profile, runPolicy, task, root);
    const edits = () => store.effects(request.runId).filter((e) => e.attempt_id === request.attemptId && e.kind === "file_patch").length;
    const tracker = new CheckpointTracker({ attemptId: request.attemptId, taskId: task.id, required: this.tracked ? (request.checkpointChecks ?? []) : [] }, (record) => saveCheckpoint(store, request.runId, record));
    const edit = (text: string) => guard.execute("edit_file", { path: "src/tags.ts" }, async () => writeFileSync(join(root, "src/tags.ts"), text));
    const check = async (tokens: number) => {
      const scope = new ProcessScope();
      try {
        const result = await new CheckRunner(store, scope).run(request.runId, request.attemptId, typecheck, request.signal, root);
        tracker.check(typecheck.id, result.status, result.evidenceId, edits(), tokens);
      } finally {
        await scope.stop();
      }
    };
    const runRepro = async () => tracker.reproRan(((await request.reproCheck?.(root, request.signal)) ?? []).length > 0, edits());
    if (this.first === "green-then-broken") {
      await edit(FIXED);
      await runRepro();
      await check(400_000);
      await edit(BROKE_AGAIN);
      await check(700_000);
      await edit(`${BROKE_AGAIN}// still half\n`);
      await check(800_000);
    } else {
      await edit(BROKE_AGAIN);
      await runRepro();
      await check(400_000);
    }
    // The usage record the executor writes at the cap.
    store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical({ schemaVersion: 1, profileId: request.profile.id, taskId: task.id, maxSteps: request.maxSteps, maxTokens: 250_000, stopReason: "tokens", finalizedBy: "tokens", totalTokens: 839_599, steps: [["edit_file"], ["run_repro"], ["request_check"], ["read"], ["edit_file"], ["request_check"], ["edit_file"], ["request_check"]].map((tools) => ({ inputTokens: 250, outputTokens: 10, cacheReadTokens: null, toolCalls: tools.length, tools, compactedBytes: 0 })) }));
  }
}

async function runScenario(first: FirstSession, tracked = true) {
  const root = mkdtempSync(join(tmpdir(), "baked-checkpoint-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, first, tracked);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  executor.service = service;
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Parse tags", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const snapshot = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  const { store } = service;
  const wouldFinish = store.eventsOfType(run.runId, "decision.would_finish").flatMap((e) => (e.type === "decision.would_finish" ? [e.payload] : []));
  const outcome = {
    status: done.status,
    sessions: executor.sessions.length,
    tasks: store.tasks(run.runId).map((t) => [t.id, t.status]),
    hostFinishes: store.artifacts(run.runId).filter((a) => /^tasks\/[^/]+\/host-finish\.json$/.test(a.logical_path)).length,
  };
  return { outcome, executor, wouldFinish, store, runId: run.runId };
}

describe("scenario: R79 deltaglue chunks T004, a green state lost at the all-token cap (#2470)", () => {
  test("an attempt that passed every required check, edited on, failed and hit the cap records the would-finish with that state's evidence", async () => {
    const { outcome, executor, wouldFinish, store, runId } = await runScenario("green-then-broken");
    expect(executor.sessions[0]?.checkpointChecks).toEqual(["typecheck"]);
    expect(wouldFinish).toHaveLength(1);
    expect(wouldFinish[0]).toMatchObject({
      reason: "attempt_green_checkpoint",
      mode: "shadow",
      inputs: { taskId: executor.sessions[0]?.taskId, stoppedBy: "tokens", position: 1, journalEnd: 3, checks: ["typecheck"], repro: "passed", failedAfter: ["typecheck"], tokensAfter: 839_599 - 400_000 },
    });
    const evidence = (wouldFinish[0]?.inputs as { evidenceIds: string[] }).evidenceIds;
    expect(evidence).toHaveLength(1);
    expect(store.checks(runId).find((c) => c.evidence_id === evidence[0])?.status).toBe("passed");
    // The replay decides it the same way: nothing new.
    expect(replayAttemptCheckpoints(store, runId).map((b) => [b.replayed, b.recorded])).toEqual([[true, true]]);
    // Shadow: the task goes on exactly as without the checkpoint.
    const control = await runScenario("green-then-broken", false);
    expect(control.wouldFinish).toEqual([]);
    expect(outcome).toEqual(control.outcome);
    expect(outcome.status).toBe("completed");
    expect(outcome.sessions).toBe(2);
  });

  test("an attempt that never passed every required check records none, and its task's path is unchanged", async () => {
    const { outcome, wouldFinish, store, runId } = await runScenario("never-green");
    expect(wouldFinish).toEqual([]);
    expect(store.artifacts(runId).some((a) => a.logical_path.endsWith("/checkpoint.json"))).toBe(false);
    const control = await runScenario("never-green", false);
    expect(outcome).toEqual(control.outcome);
    expect(outcome.status).toBe("completed");
  });
});

/** One provider step calling a tool, with the usage it reports. */
function step(call: { name: string; input: unknown }, input = 1000): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: call.name, input: JSON.stringify(call.input) }],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: { inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 100, text: 100, reasoning: 0 } },
    warnings: [],
  };
}

function scriptModel(script: Array<LanguageModelV3GenerateResult | (() => never)>): void {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const next = script[index++];
      if (!next) throw new Error("script exhausted");
      return typeof next === "function" ? next() : next;
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
}

describe("the native executor's checkpoint and prompt parts (#2470)", () => {
  test("request_check runs on the attempt's journal positions make the checkpoint; the first call records the prompt's parts", async () => {
    const valueCheck: Check = { id: "typecheck", executable: "bun", args: ["-e", "const t = await Bun.file('value.txt').text(); if (t.includes('bad')) { console.log('value.txt: bad'); process.exit(1) }"], cwd: ".", timeoutMs: 30000, required: true, scope: "task", envNames: [], writes: [] };
    const runPolicy: RunPolicy = { ...fixturePolicy, checks: [valueCheck] };
    const fixture = workflowFixture({ policy: runPolicy });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, "value.txt"), "old\n");
    const { store } = fixture.service;
    const run = await fixture.start();
    store.transaction(() => store.transition(run.runId, "running"));
    const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
    const implementer = profiles.find((p) => p.role === "implementer");
    if (!implementer) throw new Error("implementer profile missing");
    const profile: AgentProfile = { ...implementer, model: "openai/fixture-model" };
    const task: Task = { id: "T001", title: "Change value", description: "Change value", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: profile.id, writes: [{ path: "value.txt", action: "modify" }], readHints: [], checkIds: ["typecheck"], origin: "planned", findingIds: [], rationale: "Value" };
    scriptModel([
      step({ name: "read", input: { files: [{ path: "value.txt" }] } }),
      step({ name: "edit_file", input: { path: "value.txt", oldString: "old", newString: "good" } }),
      step({ name: "request_check", input: { checkId: "typecheck" } }),
      step({ name: "edit_file", input: { path: "value.txt", oldString: "good", newString: "bad" } }),
      step({ name: "request_check", input: { checkId: "typecheck" } }),
      () => {
        throw new Error("stop after the checks");
      },
    ]);
    const stepId = store.beginStep(run.runId, "fixture");
    const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, runPolicy);
    const leases = fixture.service.leases;
    leases.acquire("mutation", run.runId);
    const executor = new NativeAgentExecutor(store, leases, { ...fixture.config, repoMap: false });
    cleanups.push(() => executor.dispose());
    // A workflow context: instructions, the run's documents, then the attempt's own input.
    const prompt = `Instructions\n${canonical({ request: "Change the value", spec: { title: "Value" }, plan: "# Plan" })}\n${canonical({ inputHash: "a", snapshotHash: "b", extra: { task, taskFiles: { content: "old" } } })}`;
    const request: ExecutionRequest = { runId: run.runId, attemptId, profile, task, prompt, signal: new AbortController().signal, maxSteps: 20, checkpointChecks: ["typecheck"] };
    await expect(withinWorkflow(leases.owner, () => executor.execute(request))).rejects.toThrow("stop after the checks");
    expect(readFileSync(join(fixture.root, "value.txt"), "utf8")).toBe("bad\n");
    const row = store.latestArtifact(run.runId, checkpointPath(attemptId));
    const checkpoint = row ? store.readArtifactJson<AttemptCheckpoint>(run.runId, row) : null;
    expect(checkpoint).toMatchObject({ position: 1, checks: ["typecheck"], repro: "none", tokens: 2200, after: { position: 2, failed: ["typecheck"] } });
    expect(recordCheckpointWouldFinish(store, run.runId, attemptId, "tokens")).toBe(true);
    // Once per attempt.
    expect(recordCheckpointWouldFinish(store, run.runId, attemptId, "tokens")).toBe(false);
    const usageRow = store.latestArtifact(run.runId, `attempts/${attemptId}/usage.json`);
    const calls = usageRow ? store.readArtifactJson<AttemptUsageRecord & { calls?: { promptParts?: Record<string, number> }[] }>(run.runId, usageRow).calls : [];
    const parts = calls?.[0]?.promptParts;
    expect(parts).toEqual(promptParts(prompt) ?? {});
    expect(Object.keys(parts ?? {}).sort()).toEqual(["extra.task", "extra.taskFiles", "instructions", "plan", "request", "spec"]);
    expect(parts?.request).toBe(JSON.stringify("Change the value").length);
    expect(calls?.slice(1).some((c) => c.promptParts)).toBe(false);
  });
});
