import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, type Check, ProfileSchema, type Repro, type RunPolicy, type Spec, type Task } from "../src/core/workflows/schemas.js";
import { reproInputs } from "../src/core/workflows/scheduler.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 30, ecfit 25614519 (#1283). A convergence finding carried a repro whose
// program was a file the reviewer wrote to a temporary directory (`go -C {files} run .` with a
// main.go). The corrective worker could not run it: run_probe takes a command line only, and the
// host's refusal showed the command with an unresolved {files} and the output, not the program.
// T029 spent 4.08M tokens, 22 percent of the run, learning each verdict from a refused submit.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Fixer", problem: "BOM-only content gains a newline", outcome: "BOM-only content is kept", inScope: ["Fix content"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "BOM-only content is kept as is", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "BOM-only content", when: "it is fixed", then: "it is unchanged", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne fixer.\n## Decisions\nDEC-001: FR-001 in value.txt.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "const t = await Bun.file('value.txt').text(); if (!t.includes('ready')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [check] };
const planned: Task = { id: "T001", title: "Write value.txt", description: "Write value.txt", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };
const PROGRAM = "const t = await Bun.file('value.txt').text(); console.log(t.includes('bom') ? 'kept' : 'dropped')";
// The reviewer's program lives in {files}, like ecfit's main.go.
const repro: Repro = { executable: "bun", args: ["{files}/main.ts"], expected: "kept", actual: "dropped", files: [{ name: "main.ts", content: PROGRAM }] };

class ScriptedExecutor implements AgentExecutor {
  /** What the corrective worker learned from the host's repro check before editing. */
  seen: string[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        if (task?.origin !== "planned") {
          // The worker asks the host's runner first, as run_repro does inside an attempt.
          this.seen.push(...((await request.reproCheck?.(this.root, request.signal)) ?? []));
          this.seen.push(task?.description ?? "");
          writeFileSync(join(this.root, "value.txt"), "ready bom");
        } else writeFileSync(join(this.root, "value.txt"), "ready");
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Wrote value.txt", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = pass; break;
      case "convergence": {
        if (readFileSync(join(this.root, "value.txt"), "utf8").includes("bom")) {
          output = pass;
          break;
        }
        const finding = { id: "F1", kind: "correctness", severity: "medium", basis: "spec", confidence: 0.99, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "value.txt", symbol: null, evidenceIds, claim: "Fix adds a final newline to BOM-only content", impact: "BOM-only content changes", suggestedFix: "Keep BOM-only content", repro };
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: "BOM-only content changes" }], findings: [finding] };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: ecfit 25614519, a corrective worker blind to the reviewer's repro (#1283)", () => {
  test("the host's repro verdict shows the program in {files}, and the correction is told to run run_repro", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-ecfit-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Keep BOM-only content", ownerLabel: "test", policy });
    await service.drive(started.runId, new AbortController().signal);
    const snapshot = await service.get(started.runId);
    const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(started.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    const [verdict, description] = executor.seen;
    expect(verdict).toContain("still reproduces");
    expect(verdict).toContain("{files}/main.ts:");
    expect(verdict).toContain(PROGRAM);
    expect(description).toContain("run_repro runs");
    expect(description).not.toContain("run_probe");
  });

  test("stdin and long files are shown, cut to a bound", () => {
    expect(reproInputs({ ...repro, files: undefined })).toBe("");
    const shown = reproInputs({ ...repro, files: [{ name: "big.txt", content: "x".repeat(9000) }], stdin: "abc" });
    expect(shown).toContain("[1000 more characters]");
    expect(shown).toContain("stdin:\n```\nabc\n```");
  });
});

describe("run_repro in a corrective attempt (#1283)", () => {
  const correction: Task = { ...planned, id: "T002", origin: "repair", findingIds: ["F1"], rationale: "Finding F1" };
  const step = (call: { name: string; input: unknown }): LanguageModelV3GenerateResult => ({
    content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: call.name, input: JSON.stringify(call.input) }],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
    warnings: [],
  });

  test("runs the host's repro check of the attempt's findings and returns what still reproduces", async () => {
    const prompts: LanguageModelV3CallOptions["prompt"][] = [];
    const script = [step({ name: "run_repro", input: {} }), step({ name: "submit_result", input: { schemaVersion: 1, taskId: "T002", outcome: "blocked", summary: "Still reproduces", evidenceIds: [], unresolved: ["F1"] } })];
    const provider = getProvider("openai");
    if (!provider) throw new Error("openai provider missing");
    const original = provider.createModel;
    let index = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        prompts.push(options.prompt);
        const next = script[index++];
        if (!next) throw new Error("script exhausted");
        return next;
      },
    });
    provider.createModel = () => model as LanguageModelV3;
    cleanups.push(() => {
      provider.createModel = original;
    });
    const fixture = workflowFixture({ policy: fixturePolicy });
    cleanups.push(fixture.dispose);
    const { store } = fixture.service;
    const run = await fixture.start();
    store.transaction(() => store.transition(run.runId, "running"));
    const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
    const implementer = profiles.find((p) => p.output === "implementation");
    if (!implementer) throw new Error("implementer profile missing");
    const profile: AgentProfile = { ...implementer, model: "openai/fixture-model" };
    const attemptId = store.reserve(run.runId, store.beginStep(run.runId, "fixture"), profile.model, 2000, fixturePolicy);
    const executor = new NativeAgentExecutor(store, new WorkspaceLeases(store), { ...fixture.config, repoMap: false });
    cleanups.push(() => executor.dispose());
    let checks = 0;
    await executor.execute({
      runId: run.runId,
      attemptId,
      profile,
      prompt: "Correct F1",
      task: correction,
      signal: new AbortController().signal,
      maxSteps: 5,
      reproCheck: async () => {
        checks++;
        return ["Finding F1 still reproduces: `bun {files}/main.ts` prints \"dropped\""];
      },
    }).catch(() => undefined);
    expect(checks).toBe(1);
    const toolResult = JSON.stringify(prompts[1]);
    expect(toolResult).toContain("run_repro");
    expect(toolResult).toContain("Finding F1 still reproduces");
    expect(toolResult).toContain("reproduced");
  });
});
