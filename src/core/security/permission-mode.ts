import { resolve } from "node:path";
import type { BakeMode, PermissionMode } from "../../types/index.js";
import { isDestructiveCommand, isSensitiveFile } from "./approval-gates.js";
import type { ApprovalDetail, ApproveDestructive } from "./approval-review.js";
import { needsOutsideConfirm } from "./outside-cwd.js";

export type { PermissionMode } from "../../types/index.js";

/**
 * How much a chat may do without asking, independent of its agent mode:
 * - `manual`: every edit, shell command, mutating git action and project command waits for a yes;
 * - `auto`: safe actions run, destructive commands, sensitive files, writes outside the project
 *   and web access ask;
 * - `full`: nothing asks.
 */
export const PERMISSION_MODES = [
  "manual",
  "auto",
  "full",
] as const satisfies readonly PermissionMode[];

export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

export const PERMISSION_LABELS: Record<PermissionMode, { name: string; detail: string }> = {
  manual: {
    name: "Manual",
    detail: "Every edit, command and git change waits for your Allow.",
  },
  auto: {
    name: "Auto",
    detail:
      "Safe actions run; destructive commands, sensitive files, writes outside the project and web access ask.",
  },
  full: {
    name: "Full access",
    detail: "Runs everything without asking, including destructive commands.",
  },
};

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * The agent mode and permission mode a stored or requested pair stands for. The legacy `auto` agent
 * mode meant "default mode without prompts", so it becomes `default` with full access.
 */
export function splitLegacyMode(
  mode: BakeMode,
  permissions: PermissionMode | undefined,
): { mode: Exclude<BakeMode, "auto">; permissions: PermissionMode } {
  if (mode === "auto") return { mode: "default", permissions: "full" };
  return { mode, permissions: permissions ?? DEFAULT_PERMISSION_MODE };
}

/** Edit tools whose `path` argument names the file they change. */
const PATH_EDIT_TOOLS = new Set([
  "edit_file",
  "multi_edit",
  "ast_edit",
  "write_file",
  "create_file",
  "str_replace_based_edit_tool",
]);
/** Other tools that change files in the workspace. */
const OTHER_EDIT_TOOLS = new Set([
  "undo_edit",
  "structural_edit",
  "rename_symbol",
  "move_symbol",
  "rename_file",
  "refactor",
]);
const READ_GIT_ACTIONS = new Set(["status", "diff", "log", "show", "blame"]);
const READ_PROJECT_ACTIONS = new Set(["list"]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The question manual mode asks before a tool call, or null when the call needs no approval of its
 * own. Calls the `auto` gates already ask about (destructive commands, sensitive files, paths
 * outside the project) return null too, so a person is never asked twice for one call.
 */
export function manualApprovalRequest(
  toolName: string,
  input: unknown,
  workspace: string,
): { prompt: string; detail?: ApprovalDetail } | null {
  const cwd = resolve(workspace);
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (toolName === "shell") {
    const command = str(args.command);
    if (!command || isDestructiveCommand(command)) return null;
    const dir = resolve(cwd, str(args.cwd) ?? ".");
    if (needsOutsideConfirm("shell", dir, cwd)) return null;
    return {
      prompt: `Shell: run a command\n\n\`${command}\``,
      detail: { kind: "shell", command, cwd: dir },
    };
  }
  if (toolName === "str_replace_based_edit_tool" && args.command === "view") return null;
  if (PATH_EDIT_TOOLS.has(toolName)) {
    const path = str(args.path);
    if (!path) return { prompt: `${toolName}: edit a file` };
    if (isSensitiveFile(path) || needsOutsideConfirm(toolName, resolve(cwd, path), cwd))
      return null;
    return { prompt: `Edit \`${path}\``, detail: { kind: "edit", path, cwd } };
  }
  if (OTHER_EDIT_TOOLS.has(toolName)) {
    const target = str(args.path) ?? str(args.file) ?? str(args.from) ?? str(args.symbol);
    return { prompt: target ? `${toolName}: change \`${target}\`` : `${toolName}: change files` };
  }
  if (toolName === "git") {
    const action = str(args.action);
    if (!action || READ_GIT_ACTIONS.has(action)) return null;
    return { prompt: `Git: ${action.replace("_", " ")}` };
  }
  if (toolName === "project") {
    const action = str(args.action);
    if (!action || READ_PROJECT_ACTIONS.has(action)) return null;
    const script = action === "run" ? str(args.script) : undefined;
    return { prompt: `Project: ${action}${script ? ` \`${script}\`` : ""}` };
  }
  return null;
}

/**
 * Wraps the tools manual mode gates so each call asks first. Entries are rebuilt, never mutated,
 * because some tool objects are shared with other agents. Without `approve`, nobody can answer, so
 * the gated calls are refused.
 */
export function withManualApproval<T extends Record<string, unknown>>(
  tools: T,
  approve: ApproveDestructive | undefined,
  cwd: string,
): T {
  const wrapped: Record<string, unknown> = { ...tools };
  for (const [name, def] of Object.entries(tools)) {
    const tool = def as { execute?: (input: unknown, ...rest: unknown[]) => unknown };
    const execute = tool.execute;
    if (typeof execute !== "function") continue;
    if (
      name !== "shell" &&
      name !== "git" &&
      name !== "project" &&
      !PATH_EDIT_TOOLS.has(name) &&
      !OTHER_EDIT_TOOLS.has(name)
    )
      continue;
    wrapped[name] = {
      ...(def as Record<string, unknown>),
      execute: async (input: unknown, ...rest: unknown[]) => {
        const request = manualApprovalRequest(name, input, cwd);
        if (request) {
          const approved = approve ? await approve(request.prompt, request.detail) : false;
          if (!approved) {
            const msg = `Denied: ${request.prompt.split("\n")[0]} (manual permission mode, the user did not allow it)`;
            return { success: false, output: msg, error: msg };
          }
        }
        return execute.call(def, input, ...rest);
      },
    };
  }
  return wrapped as T;
}
