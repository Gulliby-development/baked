import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const QUESTION = "Which storage should the shortener use for its links?";
const spec = (blocking: boolean): Spec => ({
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  title: "Fixture",
  problem: "No short links",
  outcome: "Links are shortened",
  inScope: ["Shortener"],
  outOfScope: [],
  assumptions: blocking ? [] : [`${QUESTION} Assumed: a JSON file, because it needs no service.`],
  openQuestions: [{ id: "Q1", question: QUESTION, blocking }],
  requirements: [{ id: "FR-001", text: "Links are shortened", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a link", when: "it is shortened", then: "a short code is returned", method: "automated" }],
  dependencies: [],
});

/**
 * Bench round 19 (url-shortener, expenses-py, md-site): the spec author asked blocking questions,
 * the host answered "choose the most conventional default" and the author wrote the spec again.
 * This author settles its question only when the host has told it to.
 */
class Executor implements AgentExecutor {
  specErrors: string[][] = [];
  /** Stops the drive once the spec is accepted; the later stages are not under test. */
  readonly stop = new AbortController();
  async execute(request: ExecutionRequest) {
    switch (request.profile.output) {
      case "research":
        return { output: { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["links.ts"] }, inputTokens: 20, outputTokens: 30 };
      case "spec": {
        const output = spec(!request.prompt.includes("No person answers questions in this run"));
        const errors = request.validate?.(output) ?? [];
        this.specErrors.push(errors);
        if (!errors.length) this.stop.abort();
        return { output, inputTokens: 20, outputTokens: 30 };
      }
      default:
        throw new Error("stop after the spec");
    }
  }
}

function run(clarification: RunPolicy["clarification"]) {
  const root = mkdtempSync(join(tmpdir(), "baked-assume-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const executor = new Executor();
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  return { executor, service, policy };
}

describe("questions under clarification assume (#1046)", () => {
  test("the spec author settles them in its first submission", async () => {
    const { executor, service, policy } = run("assume");
    const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Build a URL shortener", ownerLabel: "test", policy });
    await service.drive(started.runId, executor.stop.signal);
    expect(executor.specErrors).toEqual([[]]);
  });

  test("a run that asks people does not tell the author to assume", async () => {
    const { executor, service, policy } = run("ask");
    const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Build a URL shortener", ownerLabel: "test", policy });
    const result = await service.drive(started.runId, new AbortController().signal);
    expect(result.reason).toBe("clarification");
    expect(executor.specErrors).toEqual([[]]);
  });
});
