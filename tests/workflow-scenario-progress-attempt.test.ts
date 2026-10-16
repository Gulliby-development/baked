import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { canonical, hashBytes, hashJson } from "../src/core/specs/hash.js";
import { CheckRunner } from "../src/core/verification/check-runner.js";
import { attemptCapFault } from "../src/core/workflows/agent-executor.js";
import { checkState, checksProgressed } from "../src/core/workflows/attempt-progress.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import type { Check, RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 35, md-site 4b08acf6 (#1351). T006 wrote a property test file: its first
// attempt ended at its token cap with edits (the one continuation), the second said the session
// had no edit tool (the one restart), and the third ran 6 edit-then-check rounds, failed fewer
// tests than the first, and ended at its cap too. With no continuation or restart left the run
// stopped `attempt_cap`, where a person had nothing to decide. A task whose failing checks moved
// since its last checked attempt now gets one more attempt; one that did not move still stops.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Property tests", problem: "The build has no property tests", outcome: "Property tests pass", inScope: ["Property tests"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Property tests pass", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the build", when: "the property tests run", then: "they pass", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne test file.\n## Decisions\nDEC-001: FR-001 property tests.\n## Components\nout.txt\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
// Each `fail NAME` line of out.txt is a failing test.
const script = "const t = await Bun.file('out.txt').text(); const f = t.split('\\n').filter((l) => l.startsWith('fail ')); for (const l of f) console.log('(fail) ' + l.slice(5)); console.log(f.length + ' fail'); process.exit(f.length ? 1 : 0)";
const testsCheck: Check = { id: "tests", executable: "bun", args: ["-e", script], cwd: ".", timeoutMs: 10000, required: true, scope: "task", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [testsCheck, { ...testsCheck, id: "suite", scope: "feature" }] };

/** What each implementation attempt writes and how it ends; `cap` throws at the token cap. */
type Attempt = { content: string | null; check: boolean; end: "cap" | "no-edit-tool" | "implemented" };

class ScriptedExecutor implements AgentExecutor {
  implementations = 0;
  service?: NativeWorkflowService;
  constructor(
    private root: string,
    private attempts: Attempt[],
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["out.txt"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Write property tests", description: "Write out.txt", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "out.txt", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const attempt = this.attempts[this.implementations++];
        if (!attempt) throw new Error("No attempt left in the script");
        const root = request.root ?? this.root;
        if (attempt.content !== null) writeFileSync(join(root, "out.txt"), attempt.content);
        if (attempt.check) {
          const store = this.service?.store;
          if (!store) throw new Error("No service");
          const scope = new ProcessScope();
          try {
            await new CheckRunner(store, scope).run(request.runId, request.attemptId, testsCheck, request.signal ?? new AbortController().signal, root);
          } finally {
            await scope.stop();
          }
        }
        if (attempt.end === "cap") {
          this.service?.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical({ schemaVersion: 1, profileId: request.profile.id, taskId: request.task?.id ?? null, maxSteps: request.maxSteps, maxTokens: 1000, stopReason: "tokens", finalizedBy: null, totalTokens: 1000, steps: [{ inputTokens: 500, outputTokens: 500, cacheReadTokens: null, toolCalls: 2, tools: ["edit_file", "request_check"], compactedBytes: 0 }] }));
          throw attemptCapFault(request.profile.id, 1000, 1000);
        }
        output =
          attempt.end === "no-edit-tool"
            ? { schemaVersion: 1, taskId: request.task?.id, outcome: "blocked", summary: "This runtime exposes no BAKED edit_file or multi_edit tool, so I could not apply the correction after the prior attempt ended.", evidenceIds: [], unresolved: ["No edit tool"] }
            : { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote out.txt", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "Checks pass" }], findings: [] }; break;
      case "refutation": output = { schemaVersion: 1, findingId: "F001", decision: "confirmed", evidenceIds: evidence, explanation: "Seen" }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(attempts: Attempt[]) {
  const root = mkdtempSync(join(tmpdir(), "baked-progress-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, attempts);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  executor.service = service;
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "standard", prompt: "Write property tests", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const waiting = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  const state = service.store.state(run.runId);
  const record = service.store.latestArtifact(run.runId, "tasks/progress-attempts/T001.json");
  return { done, state, executor, root, record: record ? (JSON.parse(service.store.readArtifact(run.runId, record.id)) as { previous: Record<string, { failed: number }>; current: Record<string, { failed: number }> }) : null };
}

const fourFailing = "fail a\nfail b\nfail c\nfail d\n";
const twoFailing = "pass a\npass b\nfail c\nfail d\n";

describe("scenario: md-site 4b08acf6, a test task stopped at its cap on its third attempt (#1351)", () => {
  test("a third attempt that fails fewer tests gets one more attempt instead of stopping the run", async () => {
    const { done, state, executor, root, record } = await runScenario([
      { content: fourFailing, check: true, end: "cap" },
      { content: null, check: false, end: "no-edit-tool" },
      { content: twoFailing, check: true, end: "cap" },
      { content: "pass a\npass b\npass c\npass d\n", check: true, end: "implemented" },
    ]);
    expect(done.status).toBe("completed");
    expect(executor.implementations).toBe(4);
    expect(readFileSync(join(root, "out.txt"), "utf8")).not.toContain("fail");
    expect(state.taskContinuations).toEqual({ T001: 1 });
    expect(state.taskRestarts).toEqual({ T001: 1 });
    expect(state.taskProgressAttempts).toEqual({ T001: 1 });
    expect(record?.previous.tests?.failed).toBe(4);
    expect(record?.current.tests?.failed).toBe(2);
  }, 60000);

  test("a third attempt whose failures did not move still stops attempt_cap, and so does a fourth", async () => {
    const same = await runScenario([
      { content: fourFailing, check: true, end: "cap" },
      { content: null, check: false, end: "no-edit-tool" },
      { content: `${fourFailing}\n`, check: true, end: "cap" },
    ]);
    expect(same.done).toMatchObject({ status: "blocked", reason: "attempt_cap" });
    expect(same.executor.implementations).toBe(3);
    expect(same.state.taskProgressAttempts).toEqual({});

    const fourth = await runScenario([
      { content: fourFailing, check: true, end: "cap" },
      { content: null, check: false, end: "no-edit-tool" },
      { content: twoFailing, check: true, end: "cap" },
      { content: "pass a\npass b\npass c\nfail d\n", check: true, end: "cap" },
    ]);
    expect(fourth.done).toMatchObject({ status: "blocked", reason: "attempt_cap" });
    expect(fourth.executor.implementations).toBe(4);
  }, 120000);
});

describe("checksProgressed", () => {
  const states = (output: string) => new Map([["tests", checkState("failed", output)]]);
  test("fewer failures or a moved first failure is progress; the same failures in other timings are not", () => {
    expect(checksProgressed(states("(fail) a [3ms]\n(fail) b\n2 fail"), states("(fail) b [9ms]\n1 fail"))).toBe(true);
    expect(checksProgressed(states("error: invalid regex at line 229\n1 fail"), states("error: expected 20000 received 20198\n1 fail"))).toBe(true);
    expect(checksProgressed(states("(fail) a [3ms]\n1 fail"), states("(fail) a [12ms]\n1 fail"))).toBe(false);
    expect(checksProgressed(new Map(), states("(fail) a\n1 fail"))).toBe(false);
    expect(checksProgressed(states("(fail) a\n1 fail"), new Map([["tests", checkState("passed", "")]]))).toBe(true);
  });
});
