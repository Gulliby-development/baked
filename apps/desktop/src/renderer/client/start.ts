import type { RunSnapshot } from "../../shared/api.js";
import { preRunQuery } from "../screens/start/logic.js";
import { ApiError, call } from "./api.js";

/**
 * The project home and the run start forms: the project summary, workflow definitions and
 * profiles, the pre-run doctor and estimate, and starting a run. Shapes mirror
 * `src/core/projects/service.ts` (`ProjectSummary`), `src/core/workflows/v2/definitions.ts`
 * (`DefinitionSummary`) and `src/core/workflows/doctor.ts` / `estimate.ts`; only the fields the
 * screens read are declared.
 */

export interface SessionEntry {
  id: string;
  title: string;
  messageCount: number;
  startedAt: number;
  updatedAt: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  roots: string[];
  ignoredRoots: string[];
  /** Not in the API yet; shown when a backend reports it. */
  branch?: string | null;
  workingSet: {
    entries: string[];
    files: { path: string; bytes: number }[];
    skipped: { path: string; reason: string }[];
  };
  instructions: { files: string[]; skipped: string[] };
  sessions: SessionEntry[];
  runs: RunSnapshot[];
}

/** One stage of `WorkflowLine` (src/core/workflows/v2/line.ts). */
export interface LineStage {
  id: string;
  type: "agent" | "tasks" | "check" | "wait" | "approval" | "review" | "reflection" | "learn";
  consumes: string[];
  produces: string;
  human: boolean;
  /** The stage's own gates, then those on the transitions leaving it; absent from older backends. */
  gates?: LineGate[];
}

/** A gate where it stands on the line (`LineGate` in src/core/workflows/v2/line.ts). */
export interface LineGate {
  id: string;
  type: "command" | "human" | "ai-review" | "ai-acceptance" | null;
  mode: "required" | "advisory";
  does: string;
  /** The transition the gate guards; null for a gate of the stage itself. */
  transition: { id: string; to: string; on: string } | null;
}

/** A transition back to the same or an earlier stage. */
export interface LineLoop {
  from: string;
  to: string;
  on: string;
  carries: string;
}

/** A workflow as a production line: stages with their contracts, and the repair loops. */
export interface WorkflowLine {
  stages: LineStage[];
  loops: LineLoop[];
}

export interface DefinitionSummary {
  id: string;
  source: "builtin" | "project";
  preset: string | null;
  description: string;
  stages: string[];
  /** Absent from older backends; the screens then guess each stage's role from its ID. */
  line?: WorkflowLine;
  writes: boolean;
  problems: string[];
  execution: "inline" | "worktree" | null;
  worktreeRefusal: string | null;
}

export interface RoutedProfile {
  profile: { id: string };
  route: { model: string };
}

export interface TokenRange {
  low: number;
  high: number;
}

export type Fit = "yes" | "maybe" | "no";

export interface PreRunEstimate {
  workflowId: string;
  tokens: TokenRange;
  costUsd: TokenRange | null;
  costComplete: boolean;
  basis: "workflow-history" | "history" | "defaults";
  samples: number;
  notes: string[];
  stages: {
    stageId: string;
    type: string;
    models: string[];
    tokens: TokenRange;
    costUsd: TokenRange | null;
  }[];
  budget: { maxTotalTokens: number; fits: Fit };
  /** The run's dollar cap against the estimated cost; absent without a cap or a price. */
  cost?: { maxCostUsd: number; fits: Fit };
  label: string;
}

export type DoctorStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  title: string;
  detail?: string;
  fix?: string;
  subject?: string;
}

export interface DoctorReport {
  workflowId: string;
  runModel: string | null;
  ready: boolean;
  checks: DoctorCheck[];
  estimate: PreRunEstimate | null;
}

/** The run limits a budget preset scales; the rest of the policy is passed through unchanged. */
export interface PolicyLimits {
  maxTotalTokens: number;
  maxAgentCalls: number;
  maxActiveMs: number;
  checkpointTokens?: number | null;
}
export type RunPolicy = PolicyLimits & Record<string, unknown>;

/** The inputs of a start that change the doctor and the estimate (`PreRunQuery`). */
export interface PreRunInput {
  workflow?: string;
  model?: string;
  worktree?: boolean;
  writers?: number;
  /** The run's OS sandbox (`--sandbox`); omitted, the policy and the sandbox setting decide. */
  sandbox?: "off" | "auto" | "required";
  /** The run's dollar cap (`--max-cost-usd`); the doctor warns when the estimate passes it. */
  maxCostUsd?: number;
}

/** `POST /v1/workflow/runs` (`StartBody` in `src/core/api/schemas.ts`). */
export interface StartBody {
  commandId: string;
  /** Optional with `issue`: the core names the feature `issue-N-TITLE`. */
  feature?: string;
  /** Optional with `issue`; with it, extra instructions added to the issue's text. */
  prompt?: string;
  /** A GitHub issue URL, `owner/name#N` or `#N`; the delivered pull request closes it. */
  issue?: string;
  workflow?: string;
  policy?: RunPolicy;
  /** A budget preset the server applies to the policy (`--budget`); omitted means standard. */
  budget?: "quick" | "standard" | "extended" | "checkpoints";
  model?: string;
  worktree?: boolean;
  writers?: number;
  /** What blocking spec questions do (`--clarification`); omitted, the policy decides. */
  clarification?: "ask" | "assume";
  /** What the test-integrity guard does (`--test-integrity`); omitted, the policy decides. */
  testIntegrity?: "block" | "warn";
  /** The run's OS sandbox (`--sandbox`); omitted, the policy and the sandbox setting decide. */
  sandbox?: "off" | "auto" | "required";
  /** The run model overrides every configured route (`--model-strict`). */
  modelStrict?: boolean;
  /** The run's dollar cap in US dollars (`--max-cost-usd`); omitted, the policy or setting applies. */
  maxCostUsd?: number;
  /** The run records the proposal of `POST /v1/workflow/propose` and the workflow kept. */
  autoPreset?: boolean;
}

/** `POST /v1/workflow/propose` (`WorkflowProposal` in `src/core/workflows/preset-router.ts`). */
export interface WorkflowProposal {
  workflowId: string;
  budget: "quick" | "standard" | "extended" | "checkpoints";
  kind: "review" | "research" | "ci-fix" | "docs" | "small" | "large" | "default";
  confidence: "high" | "medium" | "low";
  reason: string;
  signals: string[];
}

/** The most tasks a run may implement at once (`MAX_CONCURRENT_WRITERS` in the core). */
export const MAX_WRITERS = 4;

/** True when the backend does not have the endpoint, so the screen asks for a newer BAKED. */
export const isMissingEndpoint = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404 && /^No endpoint/.test(error.message);

export const start = {
  summary: (key: string) => call<ProjectSummary>(key, "GET", "/v1/projects/current"),
  definitions: (key: string) => call<DefinitionSummary[]>(key, "GET", "/v1/workflow/definitions"),
  profiles: (key: string) => call<RoutedProfile[]>(key, "GET", "/v1/workflow/profiles"),
  doctor: (key: string, input: PreRunInput = {}) =>
    call<DoctorReport>(key, "GET", `/v1/workflow/doctor${preRunQuery(input)}`),
  estimate: (key: string, input: PreRunInput) =>
    call<PreRunEstimate>(key, "GET", `/v1/workflow/estimate${preRunQuery(input)}`),
  /**
   * The configured run policy: the effective config's `workflows.policy` from `GET /v1/config`
   * (contract group B). Null when the config sets no policy, so the core's default applies.
   */
  policy: (key: string) =>
    call<{ effective: { workflows?: { policy?: RunPolicy } } }>(key, "GET", "/v1/config").then(
      (config) => config.effective.workflows?.policy ?? null,
    ),
  run: (key: string, body: StartBody) => call<RunSnapshot>(key, "POST", "/v1/workflow/runs", body),
  /** The workflow and budget proposed for a request; 404 on a backend without `preset-proposal`. */
  propose: (key: string, prompt: string) =>
    call<WorkflowProposal>(key, "POST", "/v1/workflow/propose", { prompt }),
};
