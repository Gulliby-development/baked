import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 14 (#926): the brief of url-shortener 88548a10 names neither CI nor an
// operating system, yet the spec author's profile asked for "tests pass on Windows, macOS and
// Linux" whenever the product has tests, and the spec got FR-009 "Configure CI ... on Windows,
// macOS, and Linux". The cross-platform criterion is now asked for only when the request names CI
// or other platforms, or the project already runs CI.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const CROSS = /pass on Windows, macOS and Linux/;
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Short links", problem: "Links are long", outcome: "Links are short", inScope: ["Shorten links"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Links are shortened", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a link", when: "it is shortened", then: "the short link resolves", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne file.\n## Decisions\nDEC-001: FR-001 in short.ts.\n## Components\nshort.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume" };

class ScriptedExecutor implements AgentExecutor {
  spec: ExecutionRequest | null = null;
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["short.ts"] }; break;
      case "spec": this.spec = request; output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Write short.ts", description: "Shorten links", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "short.ts", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

/** What the spec author is given: its profile instructions and the run context. */
async function specAuthorSees(prompt: string, prepare?: (root: string) => void): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "baked-cross-platform-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  prepare?.(root);
  const executor = new ScriptedExecutor();
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  if (!executor.spec) throw new Error("The spec author was not called");
  return `${executor.spec.profile.instructions}\n${executor.spec.prompt}`;
}

describe("scenario: url-shortener 88548a10, a cross-platform criterion nobody asked for (#926)", () => {
  test("a request that names neither CI nor an operating system gets no cross-platform instruction", async () => {
    const seen = await specAuthorSees("Build a URL shortener CLI with tests");
    expect(seen).not.toMatch(CROSS);
    expect(seen).toContain("never add CI, a platform matrix or release automation the request does not ask for");
  });
  test("a request that names other platforms asks for the criterion", async () => {
    expect(await specAuthorSees("Build a URL shortener CLI whose tests run on Windows and Linux")).toMatch(CROSS);
  });
  test("a project that already runs CI asks for the criterion", async () => {
    const seen = await specAuthorSees("Build a URL shortener CLI with tests", (root) => {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(join(root, ".github", "workflows", "ci.yml"), "on: push\n");
    });
    expect(seen).toMatch(CROSS);
    expect(seen).toContain("The project already runs CI");
  });
});
