import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AppConfig } from "../../types/index.js";
import type { LspStatusView } from "../intelligence/lsp-service.js";
import { getProvider } from "../llm/providers/index.js";
import { getProviderApiKey } from "../secrets.js";
import { defaultWorkflowPolicy } from "./defaults.js";
import { WorkflowFault } from "./errors.js";
import { type PreRunEstimate, readHistory } from "./estimate.js";
import { commandMayBeRunning, isExecutionLease, leaseOwnerAlive } from "./leases.js";
import { unmatchedMcpGrants } from "./mcp-grants.js";
import { estimatePrepared, type ModelUse, plannedStages } from "./pre-run.js";
import { reachableModels } from "./routing.js";
import { PolicySchema, workflowsEnabled } from "./schemas.js";
import { type PreparedStart, prepareStart } from "./start.js";
import { WorkflowStore } from "./store.js";
import { loadGateLibrary } from "./v2/library.js";

/**
 * Pre-run diagnostics (`baked workflow doctor`). Run start refusals come from `prepareStart`
 * itself, so the doctor cannot drift from what a start would refuse; the remaining checks cover
 * what fails a run later: provider keys, missing check commands, a busy workspace, Git state and
 * a budget the run will probably exceed. Nothing here writes or runs a command other than Git.
 */

export type DoctorStatus = "ok" | "warn" | "fail" | "skip";
export interface DoctorCheck {
  /** Stable identifier, for example `models.key`. */
  id: string;
  status: DoctorStatus;
  title: string;
  detail?: string;
  fix?: string;
  /** The model, command or path the line is about. */
  subject?: string;
}
export interface DoctorReport {
  schemaVersion: 1;
  workflowId: string;
  runModel: string | null;
  /** True when no check failed: `workflow run` with the same inputs starts and can finish. */
  ready: boolean;
  checks: DoctorCheck[];
  estimate: PreRunEstimate | null;
}

/** The inputs of `workflow run` that change whether and how a run starts. */
export interface PreRunRequest {
  workflowId?: string;
  model?: string;
  routes?: Record<string, string>;
  /** The run model overrides configured model routes, as `--model-strict`. */
  modelStrict?: boolean;
  /** A policy object as `--policy FILE` holds it; defaults to the configured policy. */
  policy?: unknown;
  worktree?: boolean;
  writers?: number;
  autoApprovalConfirmation?: string;
}

export interface ProviderReadiness {
  known: boolean;
  ready: boolean;
  /** The environment variable that holds the key, when the provider uses one. */
  envVar?: string;
  /** The availability probe did not answer in time, which says nothing about credentials. */
  timedOut?: boolean;
}
export interface DoctorDeps {
  providerReady(providerId: string): Promise<ProviderReadiness>;
  /** The resolved path of an executable, or null when it cannot be found. */
  which(command: string, cwd: string): string | null;
  git(args: string[], cwd: string): Promise<{ code: number; stdout: string }>;
  /** The project's language servers; without it the doctor skips that line. */
  languageServers?(workspace: string): Promise<LspStatusView>;
}

const PROBE_TIMEOUT_MS = 5000;

/** Whether a provider can be called now; a probe that does not answer within `timeoutMs` times out. */
export async function providerReadiness(
  providerId: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProviderReadiness> {
  const provider = getProvider(providerId);
  if (!provider) return { known: false, ready: false };
  // A local provider's availability probe may hang; an unanswered probe is reported, not failed.
  const answer = provider.checkAvailability
    ? await Promise.race([
        provider.checkAvailability().catch(() => false),
        new Promise<"timeout">((done) => setTimeout(() => done("timeout"), timeoutMs).unref?.()),
      ])
    : provider.envVar === "" || Boolean(getProviderApiKey(provider.envVar));
  if (answer === "timeout")
    return {
      known: true,
      ready: false,
      timedOut: true,
      ...(provider.envVar ? { envVar: provider.envVar } : {}),
    };
  return { known: true, ready: answer, ...(provider.envVar ? { envVar: provider.envVar } : {}) };
}

export const defaultDoctorDeps: DoctorDeps = {
  providerReady: (providerId) => providerReadiness(providerId),
  which(command, cwd) {
    if (command.includes("/") || command.includes("\\")) {
      const path = isAbsolute(command) ? command : resolve(cwd, command);
      return existsSync(path) ? path : null;
    }
    return Bun.which(command, { cwd }) ?? null;
  },
  async languageServers(workspace) {
    const { lspStatus } = await import("../intelligence/lsp-service.js");
    return lspStatus({ workspace });
  },
  async git(args, cwd) {
    try {
      const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
      const stdout = await new Response(child.stdout).text();
      return { code: await child.exited, stdout };
    } catch {
      return { code: -1, stdout: "" };
    }
  },
};

const providerOf = (model: string): string => {
  const slash = model.indexOf("/");
  return slash > 0 && slash < model.length - 1 ? model.slice(0, slash) : "";
};

/**
 * One line per model: its provider is known and has a key. A provider without credentials fails
 * for a model the run needs and warns for an `optional` one (a fallback, or a profile the workflow
 * does not bind). An unknown provider or an unanswered probe only warns: the model fails at its
 * first call, which `workflow run` leaves to the stage.
 */
export async function checkModels(
  models: ModelUse[],
  providerReady: DoctorDeps["providerReady"],
  optional = false,
): Promise<DoctorCheck[]> {
  return Promise.all(
    models.map(async ({ model, usedBy }): Promise<DoctorCheck> => {
      const providerId = providerOf(model);
      const used = `Used by ${usedBy.join(", ")}`;
      const readiness = providerId
        ? await providerReady(providerId)
        : { known: false, ready: false };
      if (!readiness.known)
        return {
          id: "models.provider",
          status: "warn",
          title: providerId
            ? `Unknown provider for ${model}`
            : `${model} is not a provider/model ID`,
          detail: `${used}; model IDs are provider/model`,
          fix: "Route this stage or profile to a model of a configured provider",
          subject: model,
        };
      if (readiness.timedOut)
        return {
          id: "models.key",
          status: "warn",
          title: `${providerId} did not answer its availability check (${model})`,
          detail: used,
          subject: model,
        };
      if (!readiness.ready)
        return {
          id: "models.key",
          status: optional ? "warn" : "fail",
          title: `No credentials for ${providerId} (${model})`,
          detail: used,
          fix: readiness.envVar
            ? `baked --set-key ${providerId} KEY, or set ${readiness.envVar}`
            : `Sign in to ${providerId}`,
          subject: model,
        };
      return {
        id: "models.key",
        status: "ok",
        title: `${model} is available`,
        detail: used,
        subject: model,
      };
    }),
  );
}

/**
 * The model checks of a prepared start: primary models of bound stages and profiles are required,
 * fallback models and unbound profiles optional. `workflow run` refuses on the failures and records
 * the warnings, and `workflow doctor` prints the same lines.
 */
export async function checkStartModels(
  workspace: string,
  prepared: PreparedStart,
  providerReady: DoctorDeps["providerReady"],
): Promise<DoctorCheck[]> {
  return checkRoutingModels(
    workspace,
    { ...prepared, definition: prepared.loaded.definition },
    providerReady,
  );
}

/** The model checks of a routing record for a run of `definition`, as `checkStartModels`. */
export async function checkRoutingModels(
  workspace: string,
  run: Pick<PreparedStart, "routing" | "policy" | "profiles"> & {
    definition: PreparedStart["loaded"]["definition"];
  },
  providerReady: DoctorDeps["providerReady"],
): Promise<DoctorCheck[]> {
  const { routing, definition, policy, profiles } = run;
  const { required, optional } = reachableModels(
    routing,
    definition,
    policy,
    loadGateLibrary(workspace, policy).gates,
    profiles,
  );
  const uses = (models: Map<string, string[]>): ModelUse[] =>
    [...models].map(([model, usedBy]) => ({ model, usedBy }));
  const [bound, other] = await Promise.all([
    checkModels(uses(required), providerReady),
    checkModels(uses(optional), providerReady, true),
  ]);
  return [...bound, ...other];
}

/** A check as one line of text, for refusals and run warnings. */
export function checkLine(check: DoctorCheck): string {
  return [check.title, check.detail, check.fix && `fix: ${check.fix}`].filter(Boolean).join("; ");
}

function startRequest(config: AppConfig, request: PreRunRequest) {
  return {
    workflowId: request.workflowId ?? config.workflows?.defaultWorkflow ?? "sdd",
    policy: PolicySchema.parse(request.policy ?? config.workflows?.policy ?? defaultWorkflowPolicy),
    ...(request.model ? { model: request.model } : {}),
    ...(request.routes ? { routes: request.routes } : {}),
    ...(request.modelStrict ? { modelStrict: true } : {}),
    ...(request.autoApprovalConfirmation
      ? { autoApprovalConfirmation: request.autoApprovalConfirmation }
      : {}),
    ...(request.worktree ? { executionMode: "worktree" as const } : {}),
    ...(request.writers !== undefined ? { maxConcurrentWriters: request.writers } : {}),
  };
}

/** Opens the run database read-only; null when there is none or this build cannot read it. */
function openStore(workspace: string): { store: WorkflowStore | null; problem: string | null } {
  try {
    return { store: new WorkflowStore(workspace, true), problem: null };
  } catch (error) {
    if (error instanceof WorkflowFault && error.code === "NOT_FOUND")
      return { store: null, problem: null };
    return { store: null, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** The prepared start and estimate for a request, as `workflow estimate` shows them. */
export async function preRunEstimate(
  workspace: string,
  config: AppConfig,
  request: PreRunRequest,
): Promise<PreRunEstimate> {
  const start = startRequest(config, request);
  const prepared = await prepareStart(workspace, config, start);
  const { store } = openStore(workspace);
  try {
    return estimatePrepared(prepared, start.workflowId, store ? readHistory(store, 0) : []);
  } finally {
    store?.close();
  }
}

function commandChecks(
  workspace: string,
  prepared: PreparedStart,
  which: DoctorDeps["which"],
): DoctorCheck[] {
  const commands: { id: string; executable: string; cwd: string; required: boolean }[] =
    prepared.policy.checks.map((check) => ({
      id: check.id,
      executable: check.executable,
      cwd: check.cwd,
      required: check.required,
    }));
  for (const gate of prepared.gates)
    if (gate.type === "ai-acceptance")
      commands.push({
        id: `${gate.id} (start)`,
        executable: gate.acceptance.start.executable,
        cwd: gate.acceptance.start.cwd,
        required: true,
      });
  for (const gate of prepared.gates)
    if (gate.type === "ai-acceptance")
      for (const [index, command] of (gate.acceptance.commands ?? []).entries())
        commands.push({
          id: `${gate.id} (command ${index + 1})`,
          executable: command.executable,
          cwd: gate.acceptance.start.cwd,
          required: true,
        });
  return commands.map((command): DoctorCheck => {
    const cwd = command.cwd === "." ? workspace : join(workspace, command.cwd);
    const severity = command.required ? "fail" : "warn";
    if (!existsSync(cwd))
      return {
        id: "commands.cwd",
        status: severity,
        title: `Working directory of ${command.id} does not exist`,
        detail: command.cwd,
        subject: command.id,
      };
    const found = which(command.executable, cwd);
    return found
      ? {
          id: "commands.executable",
          status: "ok",
          title: `${command.id}: ${command.executable}`,
          detail: found,
          subject: command.id,
        }
      : {
          id: "commands.executable",
          status: severity,
          title: `${command.id}: ${command.executable} not found`,
          detail: `Looked up from ${command.cwd}`,
          fix: `Install ${command.executable} or change the check's executable`,
          subject: command.id,
        };
  });
}

async function gitChecks(
  workspace: string,
  mode: PreparedStart["mode"] | null,
  git: DoctorDeps["git"],
): Promise<DoctorCheck[]> {
  const inside = await git(["rev-parse", "--is-inside-work-tree"], workspace);
  if (inside.code !== 0 || inside.stdout.trim() !== "true")
    return [
      {
        id: "git.repo",
        status: "warn",
        title: "Not a Git repository",
        detail: "Inline runs work without Git; worktree mode and delivery need it.",
        fix: "git init",
      },
    ];
  const checks: DoctorCheck[] = [];
  const status = await git(["status", "--porcelain", "--untracked-files=normal"], workspace);
  const dirty = status.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((path) => path && !path.startsWith(".baked/"));
  checks.push(
    dirty.length
      ? {
          id: "git.clean",
          status: "warn",
          title: `${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"}`,
          detail:
            dirty.slice(0, 10).join(", ") +
            (dirty.length > 10 ? `, and ${dirty.length - 10} more` : "") +
            (mode === "worktree"
              ? ". The worktree starts from HEAD without them; tasks that touch them ask you to exclude them."
              : ". Tasks that edit these files work on top of your changes."),
          fix: "Commit or stash them before the run",
        }
      : { id: "git.clean", status: "ok", title: "Working tree is clean" },
  );
  const worktrees = await git(["worktree", "list", "--porcelain"], workspace);
  const prunable = worktrees.stdout
    .split("\n\n")
    .filter((entry) => /^prunable/m.test(entry) && /\.baked[\\/]worktrees/.test(entry)).length;
  if (prunable)
    checks.push({
      id: "git.worktrees",
      status: "warn",
      title: `${prunable} stale run worktree${prunable === 1 ? "" : "s"}`,
      fix: "git worktree prune",
    });
  return checks;
}

function leaseCheck(store: WorkflowStore): DoctorCheck {
  const leases = store.leases().filter((lease) => isExecutionLease(lease.resource));
  // The workspace-wide lease (an inline run) first: it is the one that blocks the working copy.
  leases.sort((a, b) => Number(b.resource === "execution") - Number(a.resource === "execution"));
  const parallel = leases.filter(
    (lease) => lease.resource !== "execution" && leaseOwnerAlive(lease) !== false,
  );
  const lease = leases.find(
    (candidate) => candidate.resource === "execution" || leaseOwnerAlive(candidate) === false,
  );
  if (!lease)
    return parallel.length
      ? {
          id: "workspace.busy",
          status: "ok",
          title: `${parallel.length} run${parallel.length === 1 ? " is" : "s are"} executing in ${parallel.length === 1 ? "its own worktree" : "their own worktrees"}; the working copy is free`,
        }
      : { id: "workspace.busy", status: "ok", title: "No run is executing" };
  const owner = lease.run_id ?? lease.owner_id;
  const alive = leaseOwnerAlive(lease);
  if (alive !== false)
    return {
      id: "workspace.busy",
      status: "fail",
      title: `Run ${owner} is executing in this workspace`,
      ...(alive === null
        ? { detail: "Its process could not be checked, so it counts as running." }
        : {}),
      fix: `Wait for it, or pause it: baked workflow pause ${owner}`,
      subject: owner,
    };
  if (lease.run_id && commandMayBeRunning(store, lease.run_id))
    return {
      id: "workspace.busy",
      status: "fail",
      title: `Run ${owner} stopped with a command of unknown outcome`,
      fix: `baked workflow recover ${owner}`,
      subject: owner,
    };
  return {
    id: "workspace.busy",
    status: "warn",
    title: `Run ${owner} exited without releasing the workspace`,
    detail: "The next run takes the workspace over.",
    subject: owner,
  };
}

/**
 * One line for the project's language servers: a warning per detected language that no enabled,
 * installed server covers (code navigation falls back to tree-sitter there), otherwise ok.
 */
export function languageServerChecks(status: LspStatusView): DoctorCheck[] {
  if (status.uncovered.length)
    return status.uncovered.map((language) => {
      const installable = status.servers.find(
        (s) => s.languages.includes(language) && !s.installed && s.installable,
      );
      return {
        id: "lsp.missing",
        status: "warn",
        title: `No language server for ${language}`,
        detail: "Code navigation and diagnostics fall back to tree-sitter for these files.",
        fix: installable
          ? `baked lsp install ${installable.id}, or Install on the desktop app's Language servers page`
          : `Install a ${language} server, or enable a disabled one (baked lsp status --all)`,
        subject: language,
      };
    });
  const servers = status.servers.filter((s) => s.detected && s.installed && !s.disabled);
  if (servers.length === 0) return [];
  return [
    {
      id: "lsp.servers",
      status: "ok",
      title: "Language servers are installed for the project's languages",
      detail: servers.map((s) => s.id).join(", "),
    },
  ];
}

export async function runDoctor(
  workspace: string,
  config: AppConfig,
  request: PreRunRequest = {},
  deps: DoctorDeps = defaultDoctorDeps,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(
    workflowsEnabled(config)
      ? { id: "config.enabled", status: "ok", title: "Workflows are enabled" }
      : {
          id: "config.enabled",
          status: "fail",
          title: "Workflows are turned off",
          fix: "Remove workflows.enabled: false from the configuration",
        },
  );
  let workflowId = request.workflowId ?? config.workflows?.defaultWorkflow ?? "sdd";
  let prepared: PreparedStart | null = null;
  try {
    const start = startRequest(config, request);
    workflowId = start.workflowId;
    prepared = await prepareStart(workspace, config, start);
    checks.push({
      id: "start",
      status: "ok",
      title: `Workflow ${workflowId} would start`,
      detail: `Policy, definition, routing${prepared.gates.length ? ", gates" : ""} and profiles are valid`,
    });
  } catch (error) {
    checks.push({
      id: "start",
      status: "fail",
      title: `Workflow ${workflowId} would not start`,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const { store, problem } = openStore(workspace);
  let estimate: PreRunEstimate | null = null;
  try {
    if (prepared) {
      checks.push(...(await checkStartModels(workspace, prepared, deps.providerReady)));
      const stageModels = (type: string) =>
        new Set(
          plannedStages(prepared)
            .filter((s) => s.type === type)
            .flatMap((s) => s.models),
        );
      const implementers = stageModels("tasks");
      const shared = [...stageModels("review")].filter((m) => implementers.has(m));
      if (shared.length)
        checks.push({
          id: "review.independent",
          status: "warn",
          title: "Review runs on the implementer's model",
          detail: `${shared.join(", ")} both implements and reviews, so the review is not independent.`,
          fix: "Route review to another model (modelRouting.roles.reviewer or classes.review)",
        });
      checks.push(...commandChecks(workspace, prepared, deps.which));
      for (const { profileId, grant } of unmatchedMcpGrants(
        config.mcpServers ?? [],
        prepared.profiles,
      ))
        checks.push({
          id: "mcp.server",
          status: "warn",
          title: `${profileId}: ${grant} names no configured MCP server`,
          detail: "No enabled server in mcpServers provides it, so the agent never gets it.",
          fix: "Add the server to mcpServers, enable it, or remove the grant",
          subject: profileId,
        });
      try {
        estimate = estimatePrepared(prepared, workflowId, store ? readHistory(store, 0) : []);
      } catch {
        // An estimate is advice; the doctor reports without it.
      }
      if (estimate && estimate.budget.fits !== "yes")
        checks.push({
          id: "budget",
          status: "warn",
          title:
            estimate.budget.fits === "no"
              ? "The run will very likely exceed its token budget"
              : "The run may exceed its token budget",
          detail: `${estimate.label}; budget ${estimate.budget.maxTotalTokens.toLocaleString("en-US")} tokens`,
          fix: "Raise maxTotalTokens in the policy, or extend the run when it stops",
        });
    } else
      checks.push({
        id: "models.key",
        status: "skip",
        title: "Models, commands and estimate need a workflow that starts",
      });
    if (deps.languageServers) {
      const status = await deps.languageServers(workspace).catch(() => null);
      if (status) checks.push(...languageServerChecks(status));
    }
    checks.push(...(await gitChecks(workspace, prepared?.mode ?? null, deps.git)));
    if (store) checks.push(leaseCheck(store));
    else if (problem)
      checks.push({
        id: "workspace.store",
        status: "warn",
        title: "The run database cannot be read by this version",
        detail: problem,
      });
  } finally {
    store?.close();
  }
  const runModel = prepared?.model ?? request.model ?? config.defaultModel;
  return {
    schemaVersion: 1,
    workflowId,
    runModel: runModel && runModel !== "none" ? runModel : null,
    ready: !checks.some((c) => c.status === "fail"),
    checks,
    estimate,
  };
}
