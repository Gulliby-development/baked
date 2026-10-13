import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import {
  boundCodexNativeInput,
  boundInputText,
  CODEX_MAX_INPUT_CHARS,
} from "../src/core/llm/providers/codex/native.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { isInputTooLarge } from "../src/core/workflows/retry.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// #997, a follow-up of #993: the codex app-server refused a turn whose tool result held a whole
// check output ("Input exceeds the maximum length of 1048576 characters"). The scheduler wrapped
// the error as provider_unavailable, the task was interrupted as worker_lost, and each restart
// failed the same way.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const TOO_LARGE = "Input exceeds the maximum length of 1048576 characters (input_too_large)";
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Greeting", problem: "No greeting", outcome: "A greeting exists", inScope: ["Add a greeting"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "greet returns hello", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the module", when: "greet runs", then: "it returns hello", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nAdd greet.\n## Decisions\nDEC-001: FR-001 needs greet.\n## Components\nsrc/greet.ts\n## Data\nNone\n## Verification\nTests\n## Risks\nNone";
const tests: Check = { id: "tests", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "task", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 1, checks: [tests] };
const task: Task = { id: "T001", title: "Write src/greet.ts", description: "Write src/greet.ts", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/greet.ts", action: "modify" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };

class ScriptedExecutor implements AgentExecutor {
  attempts = 0;
  constructor(
    private root: string,
    private failures: number,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A module", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/greet.ts"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [task] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        this.attempts += 1;
        if (this.attempts <= this.failures) throw new Error(TOO_LARGE);
        writeFileSync(join(this.root, "src/greet.ts"), "export const greet = () => \"hello\";\n");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote greet", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Done" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runPlan(failures: number) {
  const root = mkdtempSync(join(tmpdir(), "baked-input-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/greet.ts"), "export const greet = () => \"\";\n");
  const executor = new ScriptedExecutor(root, failures);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Add greet", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const snapshot = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  const lostWorker = JSON.stringify(service.store.events(run.runId, 0)).includes("worker_lost");
  return { root, executor, service, runId: run.runId, done, lostWorker };
}

describe("scenario: a provider's input_too_large (#997)", () => {
  test("is retried once in a fresh session, not restarted as a lost worker", async () => {
    const { root, executor, done, lostWorker } = await runPlan(1);
    expect(done.status).toBe("completed");
    expect(executor.attempts).toBe(2);
    expect(lostWorker).toBe(false);
    expect(readFileSync(join(root, "src/greet.ts"), "utf8")).toContain("hello");
  }, 60000);

  test("stops the run for the size when the fresh session fails the same way", async () => {
    const { executor, service, runId, done, lostWorker } = await runPlan(10);
    expect(done.status).toBe("blocked");
    expect(service.store.run(runId).reason).toBe("budget_exhausted");
    expect(executor.attempts).toBe(2);
    expect(lostWorker).toBe(false);
  }, 60000);
});

describe("isInputTooLarge", () => {
  test("recognises size refusals of the providers", () => {
    expect(isInputTooLarge(new Error(TOO_LARGE))).toBe(true);
    expect(isInputTooLarge(new Error("prompt is too long: 250000 tokens > 200000 maximum"))).toBe(true);
    expect(isInputTooLarge(Object.assign(new Error("Payload"), { statusCode: 413 }))).toBe(true);
    expect(isInputTooLarge(new Error("socket hang up"))).toBe(false);
  });
});

describe("codex input bound", () => {
  test("a text above the limit is cut in the middle with a note", () => {
    const text = `HEAD${"x".repeat(5000)}TAIL`;
    const bounded = boundInputText(text, 1000);
    expect(bounded.length).toBeLessThanOrEqual(1000);
    expect(bounded.startsWith("HEAD")).toBe(true);
    expect(bounded.endsWith("TAIL")).toBe(true);
    expect(bounded).toContain("characters elided");
    expect(boundInputText("short", 1000)).toBe("short");
  });

  test("a turn shrinks its oldest tool results first and keeps the user's text", () => {
    const result = (id: string, size: number) => ({
      role: "tool" as const,
      content: [{ type: "tool-result" as const, toolCallId: id, toolName: "request_check", output: { type: "text" as const, value: `${id}:${"y".repeat(size)}` } }],
    });
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "Fix the failing check." }] },
      { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "a", toolName: "request_check", input: {} }] },
      result("a", 60_000),
      { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "b", toolName: "request_check", input: {} }] },
      result("b", 20_000),
    ];
    const text = boundCodexNativeInput(messages, "", 50_000);
    expect(text.length).toBeLessThanOrEqual(50_000);
    expect(text).toContain("Fix the failing check.");
    // The newer result is kept whole; the older one gave up the excess.
    expect(text).toContain(`b:${"y".repeat(20_000)}`);
    expect(text).toContain("characters elided");
    expect(CODEX_MAX_INPUT_CHARS).toBe(1_048_576);
  });
});
