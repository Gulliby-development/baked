/**
 * Project setup and "All projects" settings: working set, gates and checks, instruction files,
 * commands and skills, global and project config, providers and model routing. Paths and shapes
 * follow `docs/desktop/api.md`. Checks (`checks` capability) and commands and skills (`library`
 * capability) came after the first desktop release: their calls check `GET /v1/health` first and
 * fail like a missing endpoint (404) when the backend does not list the capability, so screens
 * show "needs a newer BAKED" either way.
 */
import { ApiError, call, MODELS_READ } from "./api.js";
import { invalidateRead } from "./cache.js";
import {
  CHAT_MEMORY_CAPABILITY,
  CHECKS_CAPABILITY,
  COMMANDS_EDIT_CAPABILITY,
  CRITIC_OUTCOMES_CAPABILITY,
  GATE_DRAFTS_CAPABILITY,
  HOOKS_CAPABILITY,
  HOOKS_EDIT_CAPABILITY,
  LIBRARY_CAPABILITY,
  offers,
  PROVIDER_SWITCH_CAPABILITY,
  ROUTING_CAPABILITY,
  RUN_MEMORY_CAPABILITY,
  SKILLS_INSTALL_CAPABILITY,
} from "./capabilities.js";

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

/** What the gate setup asks for; mirrors `DraftKind` in src/core/workflows/v2/gate-draft.ts. */
export type GateDraftKind = "command" | "ai-acceptance" | "human" | "ai-review";

/** `POST /v1/workflow/gates/draft`: a gate written from a sentence, not saved yet. */
export interface GateDraft {
  /** The full gate definition; the screen shows the fields it knows and sends it back on save. */
  gate: {
    id: string;
    type: GateType;
    description: string;
    required: boolean;
    command?: { executable: string; args: string[]; cwd: string };
    acceptance?: {
      scenario: { title: string; steps: string[]; expectations: string[] };
      start: { executable: string; args: string[]; cwd: string };
      commands?: { executable: string; args: string[] }[];
    };
    human?: { prompt: string };
    review?: { instructions?: string };
  } & Record<string, unknown>;
  script: { path: string; content: string } | null;
  summary: string;
  capabilities: string[];
  problems: string[];
  path: string;
}

/** `GET /v1/workflow/gates/ID/places`: where a gate can go in a workflow. */
export interface GatePlaces {
  workflowId: string;
  /** A built-in workflow is copied under this ID when a gate is bound to it. */
  copyTo: string | null;
  places: { key: string; label: string; bound: boolean; disabled: string | null }[];
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
  /** `json`: a custom gate whose last JSON line (`{"status":"passed"}`) decides the result. */
  report?: "exit" | "json";
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
  /** Position in every agent's prompt; null when the file's source is switched off. */
  order: number | null;
  path: string;
  absolutePath: string;
  /** The instruction source ID (`baked`, `codex`, `claude`, ...) or `project` for the manifest's. */
  source: string;
  /** The source's display name; absent on older backends. */
  sourceLabel?: string;
  scope: "project" | "global";
  /** Whether agents read the file; absent on older backends, which list only files agents read. */
  enabled?: boolean;
  bytes: number;
  hash: string;
  content: string;
}

/** An instruction source (`instructionFiles` in config) and whether agents read its files. */
export interface InstructionSource {
  id: string;
  label: string;
  /** The file names it looks for, first match wins. */
  files: string[];
  enabled: boolean;
  defaultEnabled: boolean;
}

export interface InstructionList {
  files: InstructionFile[];
  promptBytes: number;
  /** Absent on older backends, which cannot switch sources. */
  sources?: InstructionSource[];
  /** The config file that sets `instructionFiles`. */
  sourcesScope?: "project" | "global";
}

/** One part of the project context an agent's prompt carries, rendered as the prompt has it. */
export interface AgentContextPart {
  text: string;
  bytes: number;
}

/** `GET /v1/projects/current/context`: the rules and files every agent of the project gets. */
export interface AgentContextPreview {
  instructions: AgentContextPart;
  /** Null without a project or with an empty working set. */
  workingSet: AgentContextPart | null;
  bytes: number;
}

/** `PUT /v1/projects/current/instructions`: the saved file. */
export interface SavedInstruction extends InstructionFile {
  /** Runs that have not ended and froze this file; absent on older backends. */
  affectedRuns?: string[];
}

/** A custom slash command from `.baked/commands` of the project or the home folder. */
/** The fields of `POST /v1/commands` and `PUT /v1/commands/SCOPE/NAME`. */
export interface CommandDraft {
  name: string;
  description: string;
  argumentHint: string;
  body: string;
}

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
  /** `package`: put in `baked/skills` by an installed package; removed with the package (#1106). */
  scope: "project" | "global" | "package";
  path: string;
  description?: string;
  /** The package that installed a `package` skill. */
  package?: string;
}

/** Where a skill is installed: the project or the home folder. */
export type SkillScope = "project" | "global";

/** A skill of the skills.sh catalog. */
export interface CatalogSkill {
  id: string;
  skillId: string;
  name: string;
  /** The repository it installs from, like `owner/repo`. */
  source: string;
  installs: number;
}

// --- Config and providers -----------------------------------------------------------------------

export type Effort = "default" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["default", "low", "medium", "high", "xhigh", "max"];

export type Route = string | { model: string; effort?: Effort; fallback?: string[] };
export type IndependentReview = "off" | "warn" | "require" | "provider";
export type CriticMode = "off" | "advise" | "select" | "earlyStop";

export interface ModelRouting {
  classes?: Record<string, Route>;
  roles?: Record<string, Route>;
  profiles?: Record<string, Route>;
  workflows?: Record<string, { stages?: Record<string, Route> }>;
  independentReview?: IndependentReview;
  reviewMinConfidence?: number;
  critic?: CriticMode;
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
  /** `detected`: no key is set, but a login another tool holds is used (see `detectedFrom`). */
  source: "env" | "app" | "detected" | null;
  /** Where a detected login came from, e.g. "Copilot IDE login" or "gh CLI". */
  detectedFrom?: string;
  keyUrl?: string;
  /** Present for providers that sign in through their own CLI (Claude Code, Codex). */
  signIn?: CliSignIn;
}

export type CliLoginState = "running" | "succeeded" | "failed" | "cancelled";

/** A sign-in started through `POST /v1/providers/ID/login`; the CLI keeps the credentials. */
export interface CliLogin {
  provider: string;
  state: CliLoginState;
  lines: string[];
  url?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
}

/** The sign-ins already seen finished, by provider and start, so each refreshes the models once. */
const finishedLogins = new Set<string>();

/** A sign-in finishes in the CLI, not through a write, so its first success refreshes the models. */
function noteLogin(provider: string, login: CliLogin | null): void {
  if (login?.state !== "succeeded") return;
  const id = `${provider}@${login.startedAt}`;
  if (finishedLogins.has(id)) return;
  finishedLogins.add(id);
  invalidateRead(MODELS_READ);
}

export interface CliSignIn {
  installed: boolean;
  loggedIn: boolean;
  message: string;
  /** The terminal command that does the same sign-in. */
  command: string;
  /** The current or last sign-in this backend started, if any. */
  login: CliLogin | null;
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

// --- Model routing (`routing` capability) -----------------------------------------------------

export type RoutingScope = ConfigScope;

/** One place in `modelRouting` that holds a route. */
export type RoutingTarget =
  | { kind: "class"; name: string }
  | { kind: "role"; role: string }
  | { kind: "profile"; id: string }
  | { kind: "stage"; workflowId: string; stageId: string };

export interface ResolvedRoute {
  model: string;
  source: string;
  effort?: string | null;
  fallback?: string[];
}

export interface RoutingRow {
  target: RoutingTarget;
  /** The key under `modelRouting`, such as `roles.reviewer`. */
  path: string;
  label: string;
  global: Route | null;
  project: Route | null;
  resolved: ResolvedRoute | null;
}

/** `GET /v1/workflow/routing`: every editable route with both layers and what a run resolves. */
export interface RoutingOverview {
  layers: { global?: ModelRouting; project?: ModelRouting };
  workflows: string[];
  workflowId: string | null;
  runModel: string | null;
  classes: RoutingRow[];
  roles: RoutingRow[];
  stages: RoutingRow[];
  profiles: RoutingRow[];
  independentReview: {
    global: IndependentReview | null;
    project: IndependentReview | null;
    effective: IndependentReview;
  };
  /** Review findings below this confidence are notes; `effective` is 0.8 when no layer sets it. */
  reviewMinConfidence?: { global: number | null; project: number | null; effective: number };
  /** The task-attempt critic; `effective` null means it runs only on another vendor. */
  critic?: {
    global: CriticMode | null;
    project: CriticMode | null;
    effective: CriticMode | null;
  };
  warnings: string[];
  error: string | null;
}

/** A route as the form edits it; `effort: null` leaves it unset. */
export interface RouteDraft {
  model: string;
  effort: Effort | null;
  fallback: string[];
}

export type RoutingChange =
  | { target: RoutingTarget; route: RouteDraft | null; create?: boolean }
  | { independentReview: IndependentReview | null }
  | { reviewMinConfidence: number | null }
  | { critic: CriticMode | null };

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
export async function withCapability<T>(
  key: string,
  capability: string,
  request: () => Promise<T>,
): Promise<T> {
  if (offers(await capabilities(key), capability) === false)
    throw new ApiError(404, "NOT_FOUND", `This BAKED has no ${capability} endpoints`);
  return request();
}

// --- Critic outcomes (`critic-outcomes` capability) ----------------------------------------------

/** Whether the critic's scores may decide (`select`, `earlyStop`), from the project's outcome log. */
export interface CriticCalibration {
  samples: number;
  good: number;
  bad: number;
  auc: number | null;
  threshold: number | null;
  calibrated: boolean;
  reason: string | null;
}

/** `GET /v1/workflow/critic`: the outcome log summary and calibration (rows are left out here). */
export interface CriticOutcomesView {
  summary: { scored: number };
  calibration: CriticCalibration;
}

// --- Run memory (`run-memory` capability) -------------------------------------------------------

export type MemoryEntryKind = "note" | "answer" | "assumption" | "check" | "rule";
/** An entry of project memory (`MemoryEntry` in src/core/workflows/project-memory.ts). */
export interface MemoryEntry {
  id: string;
  kind: MemoryEntryKind;
  text: string;
  question?: string;
  runId?: string;
  runs?: number;
  /** What runs recorded, when a person reworded the entry. */
  recorded?: string;
  /** A learned rule's paths (`**` or `DIR/**`), status and source findings (`RUN/FINDING`). */
  scope?: string;
  status?: "proposed" | "active";
  findings?: string[];
  hidden: boolean;
}
export interface RunMemoryView {
  enabled: boolean;
  /** What a run started now reads; `sent: false` for a check the policy already lists. */
  entries: (MemoryEntry & { sent: boolean })[];
  hidden: MemoryEntry[];
  rendered: string | null;
}
export type RunMemoryEdit =
  | { action: "add"; text: string }
  | { action: "edit"; id: string; text: string }
  | { action: "accept"; id: string }
  | { action: "forget"; id: string }
  | { action: "restore"; id: string };

// --- Chat memory (`chat-memory` capability) -----------------------------------------------------

export type ChatMemoryScope = "project" | "global";
export type ChatMemoryCategory = "pref" | "decision" | "gotcha" | "context";
/** What the chat agent remembers across sessions (`ChatMemoryEntry` in src/core/memory/browse.ts). */
export interface ChatMemoryEntry {
  id: string;
  scope: ChatMemoryScope;
  category: ChatMemoryCategory | null;
  summary: string;
  details: string;
  topics: string[];
  source: "user" | "agent";
  createdAt: string;
  lastUsedAt: string;
  useCount: number;
  pinned: boolean;
  hidden: boolean;
}
export interface ChatMemorySettings {
  writeScope: ChatMemoryScope | "none";
  readScope: ChatMemoryScope | "all" | "none";
  /** Chat recall also shows what runs learned, and runs read this project's settled memories. */
  shareWithRuns: boolean;
  settingsScope: ChatMemoryScope;
}
export interface ChatMemoryView {
  settings: ChatMemorySettings;
  entries: ChatMemoryEntry[];
  hidden: ChatMemoryEntry[];
  cleanupHint: { sessions: number; total: number; stale: number } | null;
}
export type ChatMemoryEdit =
  | { action: "pin" | "unpin" | "hide" | "restore"; scope: ChatMemoryScope; id: string }
  | {
      action: "edit";
      scope: ChatMemoryScope;
      id: string;
      summary: string;
      details?: string;
      category?: ChatMemoryCategory | null;
    }
  | { action: "purge"; scope: ChatMemoryScope | "all" };
export interface ChatMemoryCleanupCandidate {
  id: string;
  scope: ChatMemoryScope;
  kind: "duplicate" | "dead" | "stale" | "similar";
  summary: string;
  detail: string;
  keeperId?: string;
}
export interface ChatMemoryCleanupAction {
  id: string;
  scope: ChatMemoryScope;
  action: "hide" | "pin";
}

// --- Hooks (`hooks` capability) -----------------------------------------------------------------

export type HookScope = "user" | "project" | "local";
/** Where new hooks are saved: the project's `.baked/config.json`, or the home folder's. */
export type HookWriteScope = "project" | "user";
/** One hook command (`HookCommandView` in src/core/hooks/overview.ts). */
export interface HookCommand {
  source: string;
  scope: HookScope;
  /** `baked` hooks can be edited; `claude` ones are imported read-only from `.claude` files. */
  origin: "baked" | "claude";
  id: string | null;
  rev: string | null;
  /** The command had a secret redacted; an edit that keeps it sends no command. */
  redacted: boolean;
  matcher: string | null;
  command: string;
  async: boolean;
  once: boolean;
  timeout: number | null;
  if: string | null;
}
export interface HookEvent {
  event: string;
  known: boolean;
  /** Switched off for this backend process only. */
  disabled: boolean;
  blocking: boolean;
  hooks: HookCommand[];
}
/** `GET /v1/hooks`. */
export interface HooksView {
  disabledBy: string | null;
  sources: {
    path: string;
    scope: HookScope;
    origin: "baked" | "claude";
    exists: boolean;
    hooks: number;
  }[];
  /** The BAKED files new hooks are saved to. */
  targets: { project: string; user: string };
  events: HookEvent[];
}
/** The form of a hook for `POST|PUT /v1/hooks`. */
export interface HookDraft {
  event: string;
  matcher: string | null;
  command?: string;
  timeout: number | null;
  async: boolean;
  once: boolean;
  if: string | null;
  scope: HookWriteScope;
}

/** `POST /v1/providers/ID/switch`. */
export interface AccountSwitch {
  ok: boolean;
  message: string;
  login: CliLogin | null;
}

export const setup = {
  /** The hooks of the project, its local overrides and the home folder. */
  hooks: (key: string) =>
    withCapability(key, HOOKS_CAPABILITY, () => call<HooksView>(key, "GET", "/v1/hooks")),
  /** Whether the backend saves hooks to BAKED's config files. */
  canEditHooks: async (key: string) =>
    offers(await capabilities(key), HOOKS_EDIT_CAPABILITY) === true,
  /** Adds a hook to `.baked/config.json` of the project or the home folder. */
  addHook: (key: string, draft: HookDraft) => call<HooksView>(key, "POST", "/v1/hooks", draft),
  /** Changes a BAKED hook; fails with 409 when its file changed since `rev`. */
  updateHook: (key: string, id: string, rev: string, draft: HookDraft) =>
    call<HooksView>(key, "PUT", "/v1/hooks", { id, rev, ...draft }),
  removeHook: (key: string, id: string, rev: string) =>
    call<HooksView>(key, "DELETE", "/v1/hooks", { id, rev }),
  /** Switches an event's hooks off or on for this backend process; no file is written. */
  setHookEvent: (key: string, event: string, enabled: boolean) =>
    call<HooksView>(key, "POST", "/v1/hooks/session", { event, enabled }),
  /** Whether the backend can switch a CLI provider's account in one step. */
  canSwitchAccount: async (key: string) =>
    offers(await capabilities(key), PROVIDER_SWITCH_CAPABILITY) === true,
  /** Signs the CLI's account out and starts a new sign-in, as `/codex switch` does. */
  switchAccount: (key: string, provider: string) =>
    withCapability(key, PROVIDER_SWITCH_CAPABILITY, () =>
      call<AccountSwitch>(key, "POST", `/v1/providers/${json(provider)}/switch`),
    ),

  project: (key: string) => call<ProjectSummary>(key, "GET", "/v1/projects/current"),
  changeWorkingSet: (key: string, change: { add?: string[]; remove?: string[] }) =>
    call<ProjectSummary>(key, "POST", "/v1/projects/current/working-set", change),

  /** The critic's outcome log across the project's runs and whether it is calibrated. */
  criticOutcomes: (key: string) =>
    withCapability(key, CRITIC_OUTCOMES_CAPABILITY, () =>
      call<CriticOutcomesView>(key, "GET", "/v1/workflow/critic"),
    ),

  /** Project memory new runs read: notes, earlier answers, approved assumptions, passing checks. */
  runMemory: (key: string) =>
    withCapability(key, RUN_MEMORY_CAPABILITY, () =>
      call<RunMemoryView>(key, "GET", "/v1/workflow/memory"),
    ),
  editRunMemory: (key: string, edit: RunMemoryEdit) =>
    call<RunMemoryView & { id: string }>(key, "POST", "/v1/workflow/memory", edit),

  /** What the chat agent remembers across sessions, and where it reads and writes memories. */
  chatMemory: (key: string) =>
    withCapability(key, CHAT_MEMORY_CAPABILITY, () =>
      call<ChatMemoryView>(key, "GET", "/v1/memory"),
    ),
  editChatMemory: (key: string, edit: ChatMemoryEdit) =>
    call<ChatMemoryView & { cleared?: number }>(key, "POST", "/v1/memory", edit),
  chatMemorySettings: (key: string, change: Partial<ChatMemorySettings>) =>
    call<ChatMemoryView>(key, "PUT", "/v1/memory/settings", change),
  chatMemoryCleanup: (key: string) =>
    call<{ candidates: ChatMemoryCleanupCandidate[] }>(key, "GET", "/v1/memory/cleanup"),
  applyChatMemoryCleanup: (key: string, actions: ChatMemoryCleanupAction[]) =>
    call<ChatMemoryView & { applied: { hidden: number; pinned: number } }>(
      key,
      "POST",
      "/v1/memory/cleanup",
      { actions },
    ),

  gates: (key: string) => call<GateList>(key, "GET", "/v1/workflow/gates"),
  /** Drafts a gate from a sentence with the project's model (`gate-drafts`); writes nothing. */
  draftGate: (key: string, text: string, kind: GateDraftKind) =>
    withCapability(key, GATE_DRAFTS_CAPABILITY, () =>
      call<GateDraft>(key, "POST", "/v1/workflow/gates/draft", { text, kind }),
    ),
  /** Saves a draft the person read; the gate is confirmed by the same step. */
  saveGate: (key: string, draft: GateDraft) =>
    call<{ id: string; path: string; script: string | null }>(key, "POST", "/v1/workflow/gates", {
      gate: draft.gate,
      script: draft.script,
    }),
  gatePlaces: (key: string, gateId: string, workflow: string) =>
    call<GatePlaces>(
      key,
      "GET",
      `/v1/workflow/gates/${encodeURIComponent(gateId)}/places?workflow=${encodeURIComponent(workflow)}`,
    ),
  bindGate: (key: string, gateId: string, workflow: string, at: string) =>
    call<{ workflowId: string; path: string; copiedFrom: string | null }>(
      key,
      "POST",
      `/v1/workflow/gates/${encodeURIComponent(gateId)}/bind`,
      { workflow, at },
    ),
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
  /** What every agent's prompt gets from the project now; 404 on older backends. */
  agentContext: (key: string) =>
    call<AgentContextPreview>(key, "GET", "/v1/projects/current/context"),
  /** `expectedHash: null` creates a project file at a path a source reads, such as `AGENTS.md`. */
  saveInstruction: (key: string, path: string, content: string, expectedHash: string | null) =>
    call<SavedInstruction>(key, "PUT", "/v1/projects/current/instructions", {
      path,
      content,
      expectedHash,
    }),
  /** Switches an instruction source on or off; the answer is the new list. */
  setInstructionSource: (key: string, source: string, enabled: boolean) =>
    call<InstructionList>(key, "PUT", "/v1/projects/current/instructions/sources", {
      source,
      enabled,
    }),
  commands: (key: string) =>
    withCapability(key, LIBRARY_CAPABILITY, () =>
      call<{ commands: CommandEntry[] }>(key, "GET", "/v1/commands"),
    ),
  /** Whether the backend writes custom commands (`commands-edit`). */
  canEditCommands: async (key: string) =>
    offers(await capabilities(key), COMMANDS_EDIT_CAPABILITY) === true,
  /** A command's frontmatter values as written and its prompt, for the edit form. */
  command: (key: string, scope: CommandEntry["scope"], name: string) =>
    call<CommandDraft & { scope: CommandEntry["scope"]; path: string }>(
      key,
      "GET",
      `/v1/commands/${scope}/${encodeURIComponent(name.replace(/^\//, ""))}`,
    ),
  addCommand: (key: string, scope: CommandEntry["scope"], draft: CommandDraft) =>
    call<{ commands: CommandEntry[] }>(key, "POST", "/v1/commands", { scope, ...draft }),
  /** Rewrites the command `name`; a new `draft.name` renames its file. */
  updateCommand: (key: string, scope: CommandEntry["scope"], name: string, draft: CommandDraft) =>
    call<{ commands: CommandEntry[] }>(
      key,
      "PUT",
      `/v1/commands/${scope}/${encodeURIComponent(name.replace(/^\//, ""))}`,
      draft,
    ),
  removeCommand: (key: string, scope: CommandEntry["scope"], name: string) =>
    call<{ commands: CommandEntry[] }>(
      key,
      "DELETE",
      `/v1/commands/${scope}/${encodeURIComponent(name.replace(/^\//, ""))}`,
    ),
  skills: (key: string) =>
    withCapability(key, LIBRARY_CAPABILITY, () =>
      call<{ skills: SkillEntry[] }>(key, "GET", "/v1/skills"),
    ),

  /** Popular skills of the skills.sh catalog for an empty query. */
  skillCatalog: (key: string, query: string) =>
    withCapability(key, SKILLS_INSTALL_CAPABILITY, () =>
      call<{ skills: CatalogSkill[] }>(
        key,
        "GET",
        `/v1/skills/catalog${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`,
      ),
    ),
  /** Installs through the `skills` CLI as `/skills` in the terminal does; 422 INSTALL_FAILED. */
  installSkill: (key: string, skill: CatalogSkill, scope: SkillScope) =>
    call<{ skill: SkillEntry | null; skills: SkillEntry[] }>(key, "POST", "/v1/skills", {
      source: skill.source,
      skillId: skill.skillId,
      scope,
    }),
  skill: (key: string, scope: SkillEntry["scope"], id: string) =>
    call<SkillEntry & { content: string }>(
      key,
      "GET",
      `/v1/skills/${scope}/${encodeURIComponent(id)}`,
    ),
  removeSkill: (key: string, scope: SkillEntry["scope"], id: string) =>
    call<{ skills: SkillEntry[] }>(key, "DELETE", `/v1/skills/${scope}/${encodeURIComponent(id)}`),

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
  startLogin: (key: string, provider: string) =>
    call<{ login: CliLogin }>(key, "POST", `/v1/providers/${json(provider)}/login`),
  login: async (key: string, provider: string) => {
    const result = await call<{ login: CliLogin | null }>(
      key,
      "GET",
      `/v1/providers/${json(provider)}/login`,
    );
    noteLogin(provider, result.login);
    return result;
  },
  cancelLogin: (key: string, provider: string) =>
    call<{ login: CliLogin | null }>(key, "DELETE", `/v1/providers/${json(provider)}/login`),
  logout: (key: string, provider: string) =>
    call<{ ok: boolean; message: string }>(key, "POST", `/v1/providers/${json(provider)}/logout`),
  definitions: (key: string) => call<WorkflowDefinition[]>(key, "GET", "/v1/workflow/definitions"),
  /**
   * Who runs each stage of a workflow and why; `model` is the run model to route against. Null
   * from a backend without the `routing` capability, so the caller leaves the explanation out.
   */
  route: async (key: string, workflow: string, model?: string) =>
    offers(await capabilities(key), ROUTING_CAPABILITY) === false
      ? null
      : call<RouteExplanation>(
          key,
          "GET",
          `/v1/workflow/route?workflow=${json(workflow)}${model ? `&model=${json(model)}` : ""}`,
        ),
  routing: (key: string, workflow: string | null) =>
    withCapability(key, ROUTING_CAPABILITY, () =>
      call<RoutingOverview>(
        key,
        "GET",
        `/v1/workflow/routing${workflow ? `?workflow=${json(workflow)}` : ""}`,
      ),
    ),
  /**
   * Changes one route of a layer. A refused change (an unknown class, a class naming a class, bad
   * fallback models) fails with 422 `ROUTING_REFUSED` and every problem in `problems`; nothing is
   * written then.
   */
  changeRouting: (
    key: string,
    scope: RoutingScope,
    workflow: string | null,
    change: RoutingChange,
  ) =>
    call<RoutingOverview>(key, "PATCH", "/v1/workflow/routing", {
      scope,
      ...(workflow ? { workflow } : {}),
      ...change,
    }),
};

/**
 * True when the backend has no such endpoint: an older `baked serve`. Other 404s, such as a folder
 * that is not a BAKED project yet, are errors the screen shows as they are.
 */
/** The folder has no baked/project.json: project-only endpoints answer 404 "No project here". */
export function isNoProject(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 404 && /^No project here/.test(error.message)
  );
}

export function isMissingEndpoint(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 405) return true;
  return error.status === 404 && /^(No endpoint|This BAKED has no)/.test(error.message);
}
