import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AppConfig } from "../../types/index.js";
import { getProvider } from "../llm/providers/index.js";
import { getProviderApiKey } from "../secrets.js";
import { defaultWorkflowPolicy } from "./defaults.js";
import { WorkflowFault } from "./errors.js";
import { type PreRunEstimate, readHistory } from "./estimate.js";
import { commandMayBeRunning, leaseOwnerAlive } from "./leases.js";
import { estimatePrepared, type ModelUse, modelsInUse, plannedStages } from "./pre-run.js";
import { PolicySchema, WorkflowConfigSchema } from "./schemas.js";
import { type PreparedStart, prepareStart } from "./start.js";
import { WorkflowStore } from "./store.js";

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
}
export interface DoctorDeps {
  providerReady(providerId: string): Promise<ProviderReadiness>;
  /** The resolved path of an executable, or null when it cannot be found. */
  which(command: string, cwd: string): string | null;
  git(args: string[], cwd: string): Promise<{ code: number; stdout: string }>;
}

const PROBE_TIMEOUT_MS = 5000;

export const defaultDoctorDeps: DoctorDeps = {
  async providerReady(providerId) {
    const provider = getProvider(providerId);
    if (!provider) return { known: false, ready: false };
    // A local provider's availability probe may hang; an unanswered probe counts as unavailable.
    const ready = provider.checkAvailability
      ? await Promise.race([
          provider.checkAvailability().catch(() => false),
          new Promise<boolean>((done) => setTimeout(() => done(false), PROBE_TIMEOUT_MS).unref?.()),
        ])
      : provider.envVar === "" || Boolean(getProviderApiKey(provider.envVar));
    return { known: true, ready, ...(provider.envVar ? { envVar: provider.envVar } : {}) };
  },
  which(command, cwd) {
    if (command.includes("/") || command.includes("\\")) {
      const path = isAbsolute(command) ? command : resolve(cwd, command);
      return existsSync(path) ? path : null;
    }
    return Bun.which(command, { cwd }) ?? null;
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
  return slash > 0 ? model.slice(0, slash) : "";
};

/**
 * One line per model: its provider is known and has a key. Shared with the run start's key
 * preflight so both say the same thing.
 */
export async function checkModels(
  models: ModelUse[],
  providerReady: DoctorDeps["providerReady"],
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const { model, usedBy } of models) {
    const providerId = providerOf(model);
    const used = `Used by ${usedBy.join(", ")}`;
    const readiness = providerId ? await providerReady(providerId) : { known: false, ready: false };
    if (!readiness.known)
      checks.push({
        id: "models.provider",
        status: "fail",
        title: `Unknown provider for ${model}`,
        detail: `${used}. Model IDs are provider/model.`,
        fix: "Route this stage or profile to a model of a configured provider",
        subject: model,
      });
    else if (!readiness.ready)
      checks.push({
        id: "models.key",
        status: "fail",
        title: `No credentials for ${providerId} (${model})`,
        detail: used,
        fix: readiness.envVar
          ? `baked --set-key ${providerId} KEY, or set ${readiness.envVar}`
          : `Sign in to ${providerId}`,
        subject: model,
      });
    else
      checks.push({
        id: "models.key",
        status: "ok",
        title: `${model} is available`,
        detail: used,
        subject: model,
      });
  }
  return checks;
}

function startRequest(config: AppConfig, request: PreRunRequest) {
  return {
    workflowId: request.workflowId ?? config.workflows?.defaultWorkflow ?? "sdd",
    policy: PolicySchema.parse(request.policy ?? config.workflows?.policy ?? defaultWorkflowPolicy),
    ...(request.model ? { model: request.model } : {}),
    ...(request.routes ? { routes: request.routes } : {}),
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
  const lease = store.lease("execution");
  if (!lease) return { id: "workspace.busy", status: "ok", title: "No run is executing" };
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

export async function runDoctor(
  workspace: string,
  config: AppConfig,
  request: PreRunRequest = {},
  deps: DoctorDeps = defaultDoctorDeps,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const enabled = WorkflowConfigSchema.safeParse(config.workflows ?? {});
  checks.push(
    config.workflows && enabled.success && enabled.data.enabled
      ? { id: "config.enabled", status: "ok", title: "Workflows are enabled" }
      : {
          id: "config.enabled",
          status: "fail",
          title: "Workflows are disabled",
          fix: "Set workflows.enabled to true in the project configuration",
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
      const uses = modelsInUse(prepared);
      checks.push(...(await checkModels(uses, deps.providerReady)));
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
