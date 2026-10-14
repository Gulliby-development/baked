import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashBytes, hashJson } from "../specs/hash.js";
import { WorkflowStore } from "./store.js";
import type { AgentExecutor, ExecutionRequest, ExecutionResponse } from "./types.js";

/**
 * TEST ONLY. A workflow agent that answers every stage of a run without a model, so the desktop
 * app can drive real runs end to end against `baked serve`. It is used only when the
 * BAKED_TEST_WORKFLOW environment variable is set; no config file can turn it on.
 *
 * Every run gets one requirement, one criterion and one task that writes `BAKED_TEST_WORKFLOW`'s
 * value as the file path (`e2e-output.txt` for `1`) with the text `ready`; reviews pass with the
 * run's evidence. An initiative's split is always the same four features (`SCRIPTED_SPLIT`).
 * `BAKED_TEST_WORKFLOW_DELAY_MS` delays each agent call, so a test can watch a
 * run while it works.
 */
export const TEST_WORKFLOW_ENV = "BAKED_TEST_WORKFLOW";

/** The scripted executor when BAKED_TEST_WORKFLOW is set, else undefined. */
export function scriptedExecutorFromEnv(
  workspace: string,
  env: Record<string, string | undefined> = process.env,
): AgentExecutor | undefined {
  const value = env[TEST_WORKFLOW_ENV];
  if (!value) return undefined;
  const delay = Number(env.BAKED_TEST_WORKFLOW_DELAY_MS ?? 0);
  return new ScriptedWorkflowExecutor(
    workspace,
    value === "1" ? "e2e-output.txt" : value,
    Number.isFinite(delay) ? delay : 0,
  );
}

/**
 * The split the scripted decomposer proposes: `api` and `docs` start first and side by side, `ui`
 * and `cli` build on the `api` contract.
 */
export const SCRIPTED_SPLIT = {
  schemaVersion: 1,
  title: "Scripted initiative",
  goals: ["Ship the scripted features"],
  completionCriteria: ["Every feature wrote its output file"],
  features: [
    {
      id: "api",
      title: "Service API",
      boundary: { scope: "The service endpoints", paths: [] },
      contract: "The endpoints answer with JSON",
      dependsOn: [],
      mandatory: true,
      size: "large",
    },
    {
      id: "docs",
      title: "User guide",
      boundary: { scope: "The guide", paths: [] },
      contract: "The guide describes every endpoint",
      dependsOn: [],
      mandatory: true,
      workflow: "quick",
      size: "small",
    },
    {
      id: "ui",
      title: "Web screens",
      boundary: { scope: "The screens", paths: [] },
      contract: "Each screen reads the API",
      dependsOn: ["api"],
      mandatory: true,
      workflow: "quick",
    },
    {
      id: "cli",
      title: "Command line",
      boundary: { scope: "The commands", paths: [] },
      contract: "Each command calls the API",
      dependsOn: ["api"],
      mandatory: true,
      workflow: "quick",
      size: "small",
    },
  ],
};

interface PromptData {
  inputHash?: string;
  snapshotHash?: string;
  extra?: { evidence?: { id: string }[]; finding?: { id: string } };
}

export class ScriptedWorkflowExecutor implements AgentExecutor {
  constructor(
    private readonly workspace: string,
    private readonly file: string,
    private readonly delayMs = 0,
  ) {}

  private feature(runId: string): string {
    const store = new WorkflowStore(this.workspace, true);
    try {
      return store.run(runId).feature_id;
    } finally {
      store.close();
    }
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResponse> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    request.signal.throwIfAborted();
    const data = (() => {
      try {
        return JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as PromptData;
      } catch {
        return {} as PromptData;
      }
    })();
    const evidence = data.extra?.evidence?.map((e) => e.id) ?? [];
    const featureId = this.feature(request.runId);
    const spec = {
      schemaVersion: 1,
      featureId,
      revision: 1,
      title: "Scripted feature",
      problem: "The output file is missing",
      outcome: "The output file says ready",
      inScope: [`Write ${this.file}`],
      outOfScope: [],
      assumptions: [],
      openQuestions: [],
      requirements: [
        {
          id: "FR-001",
          text: "The output file says ready",
          priority: "must",
          verification: "automated",
          sourceRefs: [],
        },
      ],
      criteria: [
        {
          id: "AC-001",
          requirementIds: ["FR-001"],
          given: "a workspace",
          when: "the task completes",
          // biome-ignore lint/suspicious/noThenProperty: a field of the spec schema
          then: "the output file says ready",
          method: "automated",
        },
      ],
      dependencies: [],
    };
    const coverage = [
      {
        criterionId: "AC-001",
        verdict: "pass",
        evidenceIds: evidence,
        explanation: "The check read the output file",
      },
    ];
    let output: unknown;
    switch (request.profile.output) {
      case "research":
        output = {
          schemaVersion: 1,
          summary: "A small workspace",
          facts: [],
          unknowns: [],
          constraints: [],
          suggestedScope: [this.file],
        };
        break;
      case "spec":
        output = spec;
        break;
      case "plan": {
        const markdown = [
          "# Plan",
          "## Context",
          `Write ${this.file}.`,
          "## Decisions",
          "DEC-001: FR-001 needs the word ready.",
          "## Components",
          this.file,
          "## Data",
          "Text",
          "## Verification",
          "The check reads the file",
          "## Risks",
          "None for a scripted run",
        ].join("\n");
        output = {
          schemaVersion: 1,
          markdown,
          taskGraph: {
            schemaVersion: 1,
            featureId,
            revision: 1,
            specHash: hashJson(spec),
            planHash: hashBytes(markdown),
            tasks: [
              {
                id: "T001",
                title: "Write the output file",
                description: "Write ready",
                requirementIds: ["FR-001"],
                criterionIds: ["AC-001"],
                dependsOn: [],
                profileId: "implementer",
                writes: [{ path: this.file, action: "create" }],
                readHints: [],
                checkIds: [],
                origin: "planned",
                findingIds: [],
                rationale: "Required behavior",
              },
            ],
          },
        };
        break;
      }
      case "initiativePlan":
        output = SCRIPTED_SPLIT;
        break;
      case "analysis":
        output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] };
        break;
      case "implementation": {
        const target = join(request.root ?? this.workspace, this.file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, "ready");
        output = {
          schemaVersion: 1,
          taskId: request.task?.id,
          outcome: "implemented",
          summary: `Wrote ${this.file}`,
          evidenceIds: [],
          unresolved: [],
        };
        break;
      }
      case "review":
      case "convergence":
        output = {
          schemaVersion: 1,
          snapshotHash: data.snapshotHash,
          verdict: "pass",
          coverage,
          findings: [],
        };
        break;
      case "refutation":
        output = {
          schemaVersion: 1,
          findingId: data.extra?.finding?.id,
          decision: "refuted",
          evidenceIds: evidence,
          explanation: "The check passes",
        };
        break;
      default:
        throw new Error(
          `${TEST_WORKFLOW_ENV}: the scripted agent has no answer for ${request.profile.output}`,
        );
    }
    const problems = request.validate?.(output) ?? [];
    if (problems.length)
      throw new Error(`${TEST_WORKFLOW_ENV}: ${request.profile.output}: ${problems.join("; ")}`);
    return { output, inputTokens: 200, outputTokens: 100 };
  }
}
