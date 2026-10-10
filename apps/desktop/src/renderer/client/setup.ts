/**
 * Project setup and "All projects" settings: working set, gates and checks, instruction files,
 * global and project config, providers and model routing. Paths and shapes follow
 * `design/desktop-api.md` (setup group). Functions marked "proposed" call endpoints the contract
 * does not have yet; the screens treat their 404 as "needs a newer BAKED".
 */
import { ApiError, call } from "./api.js";

// --- Working set (exists) -----------------------------------------------------------------------

export interface WorkingSetView {
  entries: string[];
  files: { path: string; bytes: number }[];
  skipped: { path: string; reason: string }[];
}

/** The fields of `GET /v1/projects/current` the setup screens read. */
export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  roots: string[];
  workingSet: WorkingSetView;
  instructions: { files: string[]; skipped: string[] };
}

// --- Gates ------------------------------------------------------------------------------------

export type GateType = "command" | "human" | "ai-review" | "ai-acceptance";
export type GateSource = "builtin" | "policy" | "user" | "project";
export type GateScope = "task" | "feature" | "transition";

/** The latest result of a gate. Proposed: the gates listing does not carry it yet. */
export interface GateResult {
  outcome: "passed" | "failed" | "error" | "skipped";
  at: number;
  durationMs: number;
  exitCode?: number | null;
  runId?: string | null;
}

/** One entry of `GET /v1/workflow/gates` (`baked workflow gates`). */
export interface GateEntry {
  id: string;
  type: GateType;
  required: boolean;
  scope: GateScope;
  source: GateSource;
  /** The definition file of `user` and `project` gates. */
  path: string | null;
  hash: string;
  shadows: { source: GateSource; hash: string; path: string | null }[];
  /** Present on project gates only: whether this checkout's user confirmed the current definition. */
  confirmed?: boolean;
  lastResult?: GateResult | null;
}

export interface GateList {
  gates: GateEntry[];
  problems: string[];
}

/** A policy check (`workflows.policy.checks[]` in config), run as a command gate. */
export interface Check {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  required: boolean;
  scope: "task" | "feature";
  envNames: string[];
  writes: string[];
}

/** A check BAKED found in the project's own files (package.json scripts and the like). */
export interface GateSuggestion {
  check: Check;
  source: string;
  reason: string;
  preselected: boolean;
}

// --- Instructions -------------------------------------------------------------------------------

export interface InstructionFile {
  order: number;
  path: string;
  absolutePath: string;
  /** The instruction source ID (`baked`, `codex`, `claude`, ...) or `project` for the manifest's. */
  source: string;
  scope: "project" | "global";
  bytes: number;
  hash: string;
  content: string;
}

export interface InstructionList {
  files: InstructionFile[];
  promptBytes: number;
}

/** Proposed: custom slash commands from `.baked/commands` and `~/.baked/commands`. */
export interface CommandEntry {
  name: string;
  scope: "project" | "global";
  path: string;
  description?: string;
}

/** Proposed: skills agents may load. */
export interface SkillEntry {
  id: string;
  scope: "project" | "global";
  path: string;
  description?: string;
}

// --- Config and providers -----------------------------------------------------------------------

export type Effort = "default" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["default", "low", "medium", "high", "xhigh", "max"];

export type Route = string | { model: string; effort?: Effort; fallback?: string[] };
export type IndependentReview = "off" | "warn" | "require";

export interface ModelRouting {
  classes?: Record<string, Route>;
  roles?: Record<string, Route>;
  profiles?: Record<string, Route>;
  workflows?: Record<string, { stages?: Record<string, Route> }>;
  independentReview?: IndependentReview;
}

/** The config keys the setup screens read; the files hold many more, kept as they are. */
export interface ConfigFile {
  defaultModel?: string;
  modelRouting?: ModelRouting;
  workflows?: { policy?: { checks?: Check[] } & Record<string, unknown> } & Record<string, unknown>;
  telemetry?: boolean;
  telemetryUrl?: string;
  instructionFiles?: string[];
  [key: string]: unknown;
}

export interface ConfigView {
  global: ConfigFile;
  project: ConfigFile;
  effective: ConfigFile;
  paths: { global: string; project: string };
}

export type ConfigScope = "global" | "project";

export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  acceptsKey: boolean;
  source: "env" | "app" | null;
  keyUrl?: string;
}

export interface WorkflowDefinition {
  id: string;
  description?: string;
  stages: string[];
}

/** `GET /v1/workflow/route` (`baked workflow route --json`). */
export interface RouteExplanation {
  workflowId: string;
  runModel: string;
  stages: {
    stageId: string;
    kind: string;
    profileId: string | null;
    model: string | null;
    source: string | null;
    effort: string | null;
    fallback: string[];
  }[];
  profiles: Record<string, { model: string; source: string; effort?: string; fallback?: string[] }>;
  warnings: string[];
}

// --- Calls --------------------------------------------------------------------------------------

const json = (value: string): string => encodeURIComponent(value);

export const setup = {
  project: (key: string) => call<ProjectSummary>(key, "GET", "/v1/projects/current"),
  changeWorkingSet: (key: string, change: { add?: string[]; remove?: string[] }) =>
    call<ProjectSummary>(key, "POST", "/v1/projects/current/working-set", change),

  gates: (key: string) => call<GateList>(key, "GET", "/v1/workflow/gates"),
  confirmGates: (key: string, ids: string[]) =>
    call<{ confirmed: { id: string; hash: string }[] }>(key, "POST", "/v1/workflow/gates/confirm", {
      ids,
    }),
  /** Proposed: checks detected in the project's files, as `baked workflow init` offers them. */
  gateSuggestions: (key: string) =>
    call<{ suggestions: GateSuggestion[] }>(key, "GET", "/v1/workflow/gates/suggestions"),
  /** Proposed: runs one gate outside a run and returns its result. */
  runGate: (key: string, id: string) =>
    call<GateResult>(key, "POST", `/v1/workflow/gates/${json(id)}/run`, {}),

  instructions: (key: string) =>
    call<InstructionList>(key, "GET", "/v1/projects/current/instructions"),
  saveInstruction: (key: string, path: string, content: string, expectedHash: string) =>
    call<InstructionFile>(key, "PUT", "/v1/projects/current/instructions", {
      path,
      content,
      expectedHash,
    }),
  /** Proposed. */
  commands: (key: string) => call<{ commands: CommandEntry[] }>(key, "GET", "/v1/commands"),
  /** Proposed. */
  skills: (key: string) => call<{ skills: SkillEntry[] }>(key, "GET", "/v1/skills"),

  config: (key: string) => call<ConfigView>(key, "GET", "/v1/config"),
  patchConfig: (
    key: string,
    scope: ConfigScope,
    change: { set?: Record<string, unknown>; remove?: string[] },
  ) => call<ConfigView>(key, "PATCH", "/v1/config", { scope, ...change }),
  providers: (key: string) => call<{ providers: ProviderStatus[] }>(key, "GET", "/v1/providers"),
  setProviderKey: (key: string, provider: string, apiKey: string) =>
    call<{ configured: boolean; storage: "keychain" | "file" }>(
      key,
      "PUT",
      `/v1/providers/${json(provider)}/key`,
      { key: apiKey },
    ),
  removeProviderKey: (key: string, provider: string) =>
    call<null>(key, "DELETE", `/v1/providers/${json(provider)}/key`),
  definitions: (key: string) => call<WorkflowDefinition[]>(key, "GET", "/v1/workflow/definitions"),
  route: (key: string, workflow: string) =>
    call<RouteExplanation>(key, "GET", `/v1/workflow/route?workflow=${json(workflow)}`),
};

/** True when the backend has no such endpoint: an older `baked serve`. */
export function isMissingEndpoint(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 405);
}
