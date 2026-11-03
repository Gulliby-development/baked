import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { DEFAULT_PER_FILE, type SizingReport } from "../src/core/workflows/sizing.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Bench round 88, pokerank `documentation` (fe15aa6e, #2649): one task created README.md and
// LICENSE. Sizing priced it at the sum of the two files' high ends, 899,706 tokens against one
// attempt's 600,000, and sent the plan back to the planner (45,922 tokens) for a task that cost
// 328,751. A task of several files now splits on the expected price of their sum. Here the cap sits
// between the default prices' expected sum and their high sum, which is that run's shape.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "documentation", revision: 1, title: "Documentation", problem: "The project has no README or license", outcome: "A README and a license ship", inScope: ["README.md", "LICENSE"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The project is documented and licensed", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the repository", when: "it is read", then: "README.md and LICENSE exist", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nDocumentation.\n## Decisions\nDEC-001: FR-001 in README.md and LICENSE.\n## Components\nREADME.md, LICENSE\n## Data\nNone\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["--version"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const docsTask: Task = { id: "T001", title: "write README.md and LICENSE", description: "Create README.md and an MIT LICENSE", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "README.md", action: "create" }, { path: "LICENSE", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required documentation" };

class ScriptedExecutor implements AgentExecutor {
  outputs: string[] = [];
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    this.outputs.push(request.profile.output);
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["."] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "documentation", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [docsTask] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: R88 pokerank documentation, a README and LICENSE task (#2649)", () => {
  test("is kept whole: no second planner call", async () => {
    const readme = DEFAULT_PER_FILE.docs.create;
    // LICENSE has no documentation extension and is priced as code.
    const license = DEFAULT_PER_FILE.code.create;
    const expected = (readme.low + readme.high + license.low + license.high) / 2;
    const high = readme.high + license.high;
    const cap = Math.round((expected + high) / 2);
    const root = mkdtempSync(join(tmpdir(), "baked-docs-sizing-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [check], sizing: { maxAttemptTokens: cap } };
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const executor = new ScriptedExecutor();
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "documentation", workflowId: "sdd", prompt: "Document the project.", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    expect(service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending")).toBeDefined();
    expect(executor.outputs.filter((o) => o === "plan")).toHaveLength(1);
    expect(service.store.latestArtifact(run.runId, "sizing/plan-1.json")).toBeNull();
    const artifact = service.store.latestArtifact(run.runId, "sizing/plan-0.json");
    const report = JSON.parse(service.store.readArtifact(run.runId, artifact?.id ?? "")) as SizingReport;
    expect(report.decision).not.toBe("split-tasks");
    // The record keeps the high-end rule's answer beside the one that decided, for a replay.
    expect(report.tasks[0]?.multiFile).toEqual({ rule: "expected", expected: Math.round(expected), high, byHigh: true, byExpected: false, split: false });
  });
});
