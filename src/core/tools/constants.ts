/** Core tools — always exposed to the model (schemas sent on every API call).
 *  Keep this minimal — every extra schema adds ~300 tokens per API roundtrip. */
export const CORE_TOOL_NAMES: string[] = [
  "read",
  "edit_file",
  "multi_edit",
  "grep",
  "glob",
  "shell",
  "project",
  "memory",
];

/** Tool catalog — name + one-liner for all tools. Used by /tools popup and request_tools listing.
 *  Frozen at module load. Use `getToolCatalog()` for a mutable copy. */
export const TOOL_CATALOG: Record<string, string> = {
  request_tools: "Let the agent load tools on demand (saves ~300 tokens/tool/call)",
  release_tools: "Let the agent unload tools it no longer needs",
  skills: "Let the agent search, install, and load skills from skills.sh",
  baked_help: "Search and read BAKED's own bundled documentation",
  baked_setup:
    "Read and change BAKED's setup: workflows, agent context, memory, skills, packages, hooks, MCP, LSP",
  artifact: "Save, read and list HTML artifacts shared by every project; deploy one to your Vercel",
  read: "Read file contents with optional line range or symbol target",
  edit_file: "Edit, create, or write files with line-anchored matching",
  multi_edit: "Apply multiple edits to one or more files atomically",
  undo_edit: "Undo recent edits to a file",
  grep: "Search file contents with regex patterns",
  glob: "Find files by glob pattern",
  shell: "Execute shell commands",
  project: "Auto-detected lint, format, test, build, typecheck across 23 ecosystems",
  dispatch: "Spawn parallel subagents for multi-file tasks",
  plan: "Create an implementation plan for large changes (7+ files)",
  update_plan_step: "Update a plan step's status during execution",
  ask_user: "Ask the user a question and wait for their response",
  navigate: "LSP symbol lookup: definitions, references, callers, type hierarchies",
  bake_find: "Fuzzy file and symbol search ranked by importance",
  bake_grep: "Token-efficient search with count mode and word-boundary matching",
  bake_analyze: "Codebase analysis: file profiles, dead code, packages, symbol queries",
  bake_impact: "Dependency graph: dependents, dependencies, cochanges, blast radius",
  bake_vision: "Display images and videos inline in chat (PNG, JPG, GIF, video files/URLs)",
  analyze: "LSP diagnostics, type info, outline, code actions on a file",
  discover_pattern: "Discover recurring patterns/conventions in the codebase",
  web_search: "Search the web for documentation, APIs, error messages",
  fetch_page: "Fetch and extract content from a URL",
  git: "Git operations: status, diff, log, commit, push, pull, stash, branch",
  list_dir: "List directory contents (supports multiple paths + recursive depth in one call)",
  rename_symbol: "Rename a symbol across all files (LSP-powered)",
  move_symbol: "Move a symbol between files with import updates",
  rename_file: "Rename/move a file with import path updates",
  refactor: "LSP code transforms: extract function/variable, format, organize imports",
  memory: "Read/write persistent memories across sessions",
  task_list: "Create and track tasks for the current session",
  ast_edit: "Surgical AST editing for TS/JS — prefer over edit_file/multi_edit",
  structural_edit: "Polyglot AST find/rewrite via ast-grep — non-TS/JS (Go, Rust, Python, …)",
};

export function getToolCatalog(): Record<string, string> {
  return { ...TOOL_CATALOG };
}

export const RESTRICTED_TOOL_NAMES: string[] = [
  "read",
  "grep",
  "glob",
  "bake_grep",
  "bake_find",
  "bake_analyze",
  "bake_impact",
  "list_dir",
  "web_search",
  "navigate",
  "analyze",
  "discover_pattern",
  "memory",
  "skills",
  "baked_help",
  "fetch_page",
  "ask_user",
  "plan",
  "update_plan_step",
];

/**
 * Tools that restricted modes allow for some actions only: the read-only actions of a tool that
 * can also write. Its other actions get the same refusal as a disallowed tool.
 */
export const RESTRICTED_TOOL_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  artifact: ["list", "read"],
  baked_setup: ["list", "show", "inspect"],
  git: ["status", "diff", "log", "show", "blame", "branch", "stash"],
};

/** Git flags that write files or run programs, which a read-only git call must not pass. */
const GIT_WRITING_FLAG = /^--?(output|ext-diff|textconv|exec|upload-pack)\b|^-o/;

/**
 * Further checks on the input of an allowed read-only action: git's branch and stash only list or
 * show, and no git call passes a flag that writes a file or runs a program.
 */
export const RESTRICTED_TOOL_INPUTS: Readonly<
  Record<string, (input: Record<string, unknown>) => boolean>
> = {
  git: (input) => {
    const flags = Array.isArray(input.flags) ? input.flags : [];
    if (flags.some((flag) => typeof flag !== "string" || GIT_WRITING_FLAG.test(flag))) return false;
    const sub = input.sub_action;
    if (input.action === "branch") return sub === undefined || sub === null || sub === "list";
    if (input.action === "stash") return sub === "list" || sub === "show";
    return true;
  },
};

/** Tools available during plan execution.
 *  Executor gets edit/shell/project + read (fallback if edit fails) + update_plan_step.
 *  No dispatch, explore, discover_pattern, web_search — the plan already contains everything. */
export const PLAN_EXECUTION_TOOL_NAMES: string[] = [
  "read",
  "edit_file",
  "undo_edit",
  "multi_edit",
  "task_list",
  "list_dir",
  "shell",
  "project",
  "grep",
  "glob",
  "navigate",
  "analyze",
  "git",
  "rename_symbol",
  "move_symbol",
  "rename_file",
  "refactor",
  "update_plan_step",
  "memory",
  "skills",
  "bake_grep",
  "bake_find",
  "bake_analyze",
  "bake_impact",
];

const SUBAGENT_MAX_LINES = 750;
const SUBAGENT_MAX_OUTPUT_BYTES = 8192;

export function truncateLines(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= SUBAGENT_MAX_LINES) return output;
  return `${lines.slice(0, SUBAGENT_MAX_LINES).join("\n")}\n\n... [${String(lines.length)} lines total — use startLine/endLine for specific sections]`;
}

export function truncateBytes(output: string): string {
  if (output.length <= SUBAGENT_MAX_OUTPUT_BYTES) return output;
  return `${output.slice(0, SUBAGENT_MAX_OUTPUT_BYTES)}\n\n... [output capped — narrow with glob or path params]`;
}

export function planFileName(sessionId?: string): string {
  return sessionId ? `plan-${sessionId}.md` : "plan.md";
}
