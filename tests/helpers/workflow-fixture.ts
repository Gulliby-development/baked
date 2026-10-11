import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config/index.js";
import { hashBytes, hashJson } from "../../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../../src/core/workflows/defaults.js";
import type { RunPolicy, Spec } from "../../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../../src/core/workflows/service.js";
import { newId } from "../../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../../src/core/workflows/types.js";
import { removeTempDir } from "./temp-dir.js";

/** A deterministic executor that completes the whole SDD flow for one tiny feature without a model. */
export const fixtureSpec: Spec = {
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "Fixture", problem: "Missing value", outcome: "Value exists",
  inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [{ id: "FR-001", text: "Value is ready", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the task completes", then: "value is ready", method: "automated" }],
  dependencies: [],
};
export const fixturePolicy: RunPolicy = {
  ...defaultWorkflowPolicy,
  checks: [{ id: "check", executable: "bun", args: ["-e", "if (await Bun.file('value.txt').text() !== 'ready') process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }],
};

export class FixtureExecutor implements AgentExecutor {
  calls: string[] = [];
  /** The prompt each call received, by output kind. */
  prompts: Record<string, string[]> = {};
  constructor(
    private root: string,
    private tokensPerCall: number | ((output: string) => number) = 50,
  ) {}
  async execute(request: ExecutionRequest) {
    this.calls.push(request.profile.output);
    (this.prompts[request.profile.output] ??= []).push(request.prompt);
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] }; break;
      case "spec": output = fixtureSpec; break;
      case "plan": {
        const markdown = "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture";
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Create value", description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        break;
      }
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation":
        writeFileSync(join(this.root, "value.txt"), "ready");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] };
        break;
      case "review": case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Command checked value" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    const tokens = typeof this.tokensPerCall === "number" ? this.tokensPerCall : this.tokensPerCall(request.profile.output);
    return { output, inputTokens: tokens / 2, outputTokens: tokens / 2 };
  }
}

export function workflowFixture<E extends FixtureExecutor = FixtureExecutor>(
  options: { policy?: RunPolicy; tokensPerCall?: number | ((output: string) => number); executor?: (root: string) => E } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "baked-workflow-"));
  const executor = options.executor ? options.executor(root) : (new FixtureExecutor(root, options.tokensPerCall) as E);
  const policy = options.policy ?? fixturePolicy;
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  return {
    root, executor, service, config, policy,
    /** Closes the service and removes the workspace, waiting out Windows handles still being released. */
    dispose: async () => { service.close(); await removeTempDir(root); },
    async start(featureId = "fixture") {
      return service.start({ commandId: newId(), featureId, workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    },
    async approve(runId: string) {
      const run = await service.get(runId);
      const request = service.store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending");
      if (!request) throw new Error("No pending approval");
      return service.decide(runId, { commandId: newId(), expectedRevision: run.revision }, { kind: "approve", requestId: request.id, digest: request.digest });
    },
    async resume(runId: string) {
      const run = await service.get(runId);
      await service.resume(runId, { commandId: newId(), expectedRevision: run.revision });
    },
  };
}
