/**
 * Setting up a project's gates from a conversation: which workflows cannot start without them,
 * what BAKED detects in the project, turning short gate requests into checks and saving them.
 * The coordinator uses it before it proposes a run, so the user is asked about missing gates
 * before the "Run workflow?" card, not after approving it (#1079).
 */
import type { AppConfig } from "../../types/index.js";
import { defaultWorkflowPolicy } from "./defaults.js";
import {
  checkFromDraft,
  detectGates,
  formatCommandLine,
  type GateSuggestion,
  readGates,
  writeGates,
} from "./gates.js";
import { PolicySchema } from "./schemas.js";
import type { Check } from "./types.js";
import { lacksFeatureChecks, loadDefinition } from "./v2/definitions.js";

/** One gate as a conversation asks for it: a detected suggestion by ID, or a command. */
export interface GateRequest {
  id: string;
  /** Left out: the detected suggestion with this ID. */
  command?: string | undefined;
  required?: boolean | undefined;
  timeoutSeconds?: number | undefined;
  scope?: "feature" | "task" | undefined;
}

/** The gates the project has now: the project file first, then the configuration. */
export const projectGates = (workspace: string, config: AppConfig): Check[] =>
  readGates(workspace, config.workflows);

/**
 * Whether `workflowId` refuses to start because it has a check stage and no feature gates, with
 * `added` saved first. False for an unknown workflow; the start reports that itself.
 */
export function needsGates(
  workspace: string,
  config: AppConfig,
  workflowId: string,
  added: Check[] = [],
): boolean {
  const ids = new Set(added.map((c) => c.id));
  const checks = [...projectGates(workspace, config).filter((c) => !ids.has(c.id)), ...added];
  const policy = PolicySchema.parse({
    ...(config.workflows?.policy ?? defaultWorkflowPolicy),
    checks,
  });
  try {
    return lacksFeatureChecks(loadDefinition(workspace, workflowId, policy));
  } catch {
    return false;
  }
}

/** The project's checks BAKED detects and that are not configured yet. */
export const gateSuggestions = (workspace: string, config: AppConfig): GateSuggestion[] =>
  detectGates(workspace, projectGates(workspace, config));

/**
 * Turns gate requests into checks, validated as the gate editor validates them. A request without
 * a command takes the detected suggestion with its ID, fixer included.
 */
export function resolveGateRequests(
  workspace: string,
  config: AppConfig,
  requests: GateRequest[],
): { ok: true; checks: Check[] } | { ok: false; error: string } {
  const suggestions = gateSuggestions(workspace, config);
  const ids = new Set(requests.map((r) => r.id));
  const others = projectGates(workspace, config).filter((c) => !ids.has(c.id));
  if (ids.size !== requests.length) return { ok: false, error: "Gate IDs must be unique" };
  const checks: Check[] = [];
  for (const request of requests) {
    const suggested = suggestions.find((s) => s.check.id === request.id)?.check;
    if (!request.command && !suggested)
      return {
        ok: false,
        error: `No detected gate ${request.id}; give its command${suggestions.length ? ` or use one of ${suggestions.map((s) => s.check.id).join(", ")}` : ""}`,
      };
    const sameCommand =
      suggested &&
      (!request.command ||
        request.command.trim() === formatCommandLine(suggested.executable, suggested.args));
    const base = sameCommand ? suggested : undefined;
    const result = checkFromDraft(
      {
        id: request.id,
        command:
          request.command ?? formatCommandLine(suggested?.executable ?? "", suggested?.args ?? []),
        cwd: base?.cwd ?? ".",
        timeoutSeconds: String(
          request.timeoutSeconds ?? Math.round((base?.timeoutMs ?? 600_000) / 1000),
        ),
        required: request.required ?? base?.required ?? true,
        scope: request.scope ?? base?.scope ?? "feature",
        envNames: (base?.envNames ?? []).join(", "),
        writes: (base?.writes ?? []).join(", "),
        jsonReport: base?.report === "json",
      },
      workspace,
      [...others, ...checks],
    );
    if (!result.ok) return { ok: false, error: `Gate ${request.id}: ${result.error}` };
    checks.push(
      base?.fix
        ? {
            ...result.check,
            fix: base.fix,
            ...(base.fixUnsafe ? { fixUnsafe: base.fixUnsafe } : {}),
          }
        : result.check,
    );
  }
  return { ok: true, checks };
}

/**
 * Saves `checks` over the project's gates (same ID replaces, `remove` drops) into
 * `.baked/config.json`, and into `config` so new runs of this process read them. Returns the list.
 */
export function saveGateChanges(
  workspace: string,
  config: AppConfig,
  checks: Check[],
  remove: string[] = [],
): Check[] {
  const replaced = new Set([...checks.map((c) => c.id), ...remove]);
  const next = [...projectGates(workspace, config).filter((c) => !replaced.has(c.id)), ...checks];
  writeGates(workspace, next, config.workflows);
  config.workflows = {
    ...(config.workflows ?? {
      enabled: true,
      importsEnabled: false,
      defaultWorkflow: "sdd",
    }),
    policy: { ...(config.workflows?.policy ?? defaultWorkflowPolicy), checks: next },
  };
  return next;
}

/** One line per gate for a card or the model: `id: command (required)`. */
export const gateLine = (check: Check): string =>
  `${check.id}: ${formatCommandLine(check.executable, check.args)}${check.required ? "" : " (optional)"}${check.scope === "task" ? " (per task)" : ""}`;

/** What the model reads before setting gates up: configured, detected, and who needs them. */
export function renderGateSetup(
  workspace: string,
  config: AppConfig,
  workflowIds: string[],
): string {
  const configured = projectGates(workspace, config);
  const suggestions = gateSuggestions(workspace, config);
  const blocked = workflowIds.filter((id) => needsGates(workspace, config, id));
  return [
    "## Configured gates",
    ...(configured.length ? configured.map((c) => `- ${gateLine(c)}`) : ["None."]),
    "",
    "## Detected in the project (not configured)",
    ...(suggestions.length
      ? suggestions.map(
          (s) =>
            `- ${gateLine(s.check)} [from ${s.source}${s.preselected ? "" : "; offered, not preselected"}]`,
        )
      : ["None. Ask the user which command checks the work (build, tests, lint)."]),
    "",
    "## Workflows that cannot start until a feature gate exists",
    blocked.length ? blocked.join(", ") : "None.",
  ].join("\n");
}
