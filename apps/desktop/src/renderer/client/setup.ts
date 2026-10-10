/**
 * Project setup and "All projects" settings: working set, gates and checks, instruction files,
 * commands and skills, global and project config, providers and model routing. Paths and shapes
 * follow `design/desktop-api.md`. Checks (`checks` capability) and commands and skills (`library`
 * capability) came after the first desktop release: their calls check `GET /v1/health` first and
 * fail like a missing endpoint (404) when the backend does not list the capability, so screens
 * show "needs a newer BAKED" either way.
 */
import { ApiError, call } from "./api.js";
import { CHECKS_CAPABILITY, LIBRARY_CAPABILITY, offers } from "./capabilities.js";

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

export type CheckRunStatus = "passed" | "failed" | "timeout" | "cancelled" | "error";

/** `POST /v1/workflow/checks/ID/run`, and a check's `lastResult` until the server stops. */
export interface CheckRunResult {
  checkId: string;
  at: number;
  status: CheckRunStatus;
  exitCode: number | null;
  durationMs: number;
  /** The last lines of the combined output, ANSI codes removed and known secrets masked. */
  outputTail: string;
  /** True when the output was cut to its tail. */
  truncated: boolean;
}

export type CheckEntry = Check & { lastResult?: CheckRunResult };

/** `GET|PUT /v1/workflow/checks`. */
export interface CheckList {
  checks: CheckEntry[];
  workflowsEnabled: boolean;
}

/** A check BAKED found in the project's own files (package.json scripts and the like). */
export interface CheckSuggestion {
  check: Check;
  source: string;
  reason: string;
  /** Builds are offered but not preselected. */
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

/** `PUT /v1/projects/current/instructions`: the saved file. */
export interface SavedInstruction extends InstructionFile {
  /** Runs that have not ended and froze this file; absent on older backends. */
  affectedRuns?: string[];
}

/** A custom slash command from `.baked/commands` of the project or the home folder. */
export interface CommandEntry {
  /** The slash name, like `/fix-ci` or `/frontend:component`. */
  name: string;
  scope: "project" | "global";
  path: string;
  description: string;
  argumentHint?: string;
}

/** An installed skill (`SKILL.md` in `.baked/skills`, `.agents/skills` or `.claude/skills`). */
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

/** The backend's capability groups; null when its health answer cannot be read. */
async function capabilities(key: string): Promise<string[] | null> {
  try {
    return (await call<{ capabilities?: string[] }>(key, "GET", "/v1/health")).capabilities ?? null;
  } catch {
    return null;
  }
}

/**
 * Calls `request` when the backend offers `capability`. A backend that does not list it fails
 * with a 404 like a missing endpoint without being asked; when health cannot tell, the request
 * is tried and its own 404 says the same.
 */
async function withCapability<T>(
  key: string,
  capability: string,
  request: () => Promise<T>,
): Promise<T> {
  if (offers(await capabilities(key), capability) === false)
    throw new ApiError(404, "NOT_FOUND", `This BAKED has no ${capability} endpoints`);
  return request();
}

export const setup = {
  project: (key: string) => call<ProjectSummary>(key, "GET", "/v1/projects/current"),
  changeWorkingSet: (key: string, change: { add?: string[]; remove?: string[] }) =>
    call<ProjectSummary>(key, "POST", "/v1/projects/current/working-set", change),

  gates: (key: string) => call<GateList>(key, "GET", "/v1/workflow/gates"),
  confirmGates: (key: string, ids: string[]) =>
    call<{ confirmed: { id: string; hash: string }[] }>(key, "POST", "/v1/workflow/gates/confirm", {
      ids,
    }),
  /** The policy checks with their latest on-demand result. */
  checks: (key: string) =>
    withCapability(key, CHECKS_CAPABILITY, () =>
      call<CheckList>(key, "GET", "/v1/workflow/checks"),
    ),
  /**
   * Replaces the project's check list. Writes only `workflows.policy.checks` of the project's
   * `.baked/config.json`; started runs keep the list they froze.
   */
  saveChecks: (key: string, checks: Check[]) =>
    call<CheckList>(key, "PUT", "/v1/workflow/checks", { checks }),
  /** Checks found in the project's own files, minus the configured ones. */
  checkSuggestions: (key: string) =>
    withCapability(key, CHECKS_CAPABILITY, () =>
      call<{ suggestions: CheckSuggestion[] }>(key, "GET", "/v1/workflow/checks/suggestions"),
    ),
  /** Runs one check as a run would, without recording evidence; 409 WORKSPACE_BUSY during a run. */
  runCheck: (key: string, id: string) =>
    call<CheckRunResult>(key, "POST", `/v1/workflow/checks/${json(id)}/run`, {}),

  instructions: (key: string) =>
    call<InstructionList>(key, "GET", "/v1/projects/current/instructions"),
  saveInstruction: (key: string, path: string, content: string, expectedHash: string) =>
    call<SavedInstruction>(key, "PUT", "/v1/projects/current/instructions", {
      path,
      content,
      expectedHash,
    }),
  commands: (key: string) =>
    withCapability(key, LIBRARY_CAPABILITY, () =>
      call<{ commands: CommandEntry[] }>(key, "GET", "/v1/commands"),
    ),
  skills: (key: string) =>
    withCapability(key, LIBRARY_CAPABILITY, () =>
      call<{ skills: SkillEntry[] }>(key, "GET", "/v1/skills"),
    ),

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
