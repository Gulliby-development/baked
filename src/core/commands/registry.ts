import { getCwd } from "../cwd.js";
import { matchCheckpointPrefix, register as registerCheckpoint } from "./checkpoint.js";
import { matchClaimsPrefix, register as registerClaims } from "./claims.js";
import { register as registerClaudeCode } from "./claude-code.js";
import { register as registerCodex } from "./codex.js";
import { matchConfigPrefix, register as registerConfig } from "./config.js";
import { matchContextPrefix, register as registerContext } from "./context.js";
import { expandCustomCommandInput, getCachedCustomCommands, listCustomCommands } from "./custom.js";
import { register as registerDebug } from "./debug.js";
import { matchGitPrefix, register as registerGit } from "./git.js";
import { register as registerGraph } from "./graph.js";
import { register as registerHooks } from "./hooks.js";
import { matchNavPrefix, register as registerNavigation } from "./navigation.js";
import { register as registerProjects } from "./projects.js";
import { matchSessionPrefix, register as registerSession } from "./session.js";
import { register as registerStorage } from "./storage.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";
import { register as registerWorkflow } from "./workflow.js";

const commandMap = new Map<string, CommandHandler>();

registerGit(commandMap);
registerConfig(commandMap);
registerSession(commandMap);
registerContext(commandMap);
registerGraph(commandMap);
registerDebug(commandMap);
registerNavigation(commandMap);
registerStorage(commandMap);
registerClaims(commandMap);
registerCodex(commandMap);
registerClaudeCode(commandMap);
registerHooks(commandMap);
registerCheckpoint(commandMap);
registerWorkflow(commandMap);
registerProjects(commandMap);
commandMap.set("/commands", handleListCustomCommands);

const prefixMatchers = [
  matchContextPrefix,
  matchGitPrefix,
  matchConfigPrefix,
  matchSessionPrefix,
  matchNavPrefix,
  matchClaimsPrefix,
  matchCheckpointPrefix,
];

function resolveHandler(cmd: string): CommandHandler | null {
  const exact = commandMap.get(cmd);
  if (exact) return exact;

  for (const matcher of prefixMatchers) {
    const handler = matcher(cmd);
    if (handler) return handler;
  }

  return null;
}

/**
 * True when `name` (a lowercased first word such as `/fix-ci`) belongs to a
 * built-in command, its first word or an alias. Built-ins win over custom commands.
 */
export function isBuiltinCommandName(name: string): boolean {
  const needle = name.toLowerCase();
  if (resolveHandler(needle)) return true;
  for (const def of COMMAND_DEFS) {
    if (def.cmd.split(" ")[0]?.toLowerCase() === needle) return true;
    if (def.aliases?.some((a) => a.toLowerCase() === needle)) return true;
  }
  return false;
}

function handleListCustomCommands(_input: string, ctx: CommandContext): void {
  const commands = listCustomCommands(ctx.cwd);
  if (commands.length === 0) {
    sysMsg(
      ctx,
      "No custom commands. Add Markdown files to .baked/commands/ (project) or ~/.baked/commands/ (global); fix-ci.md becomes /fix-ci.",
    );
    return;
  }
  const lines = commands.map((c) => {
    const hint = c.argumentHint ? ` ${c.argumentHint}` : "";
    const shadowed = isBuiltinCommandName(c.name) ? " (shadowed by a built-in command)" : "";
    return `${c.name}${hint} [${c.scope}] ${c.description}${shadowed}\n  ${c.path}`;
  });
  sysMsg(ctx, `Custom commands:\n${lines.join("\n")}`);
}

/** Expand `input` when it invokes a runnable custom command from `.baked/commands`. */
export function expandCustomSlashInput(input: string, cwd: string): string | null {
  return expandCustomCommandInput(input, cwd, isBuiltinCommandName)?.prompt ?? null;
}

export function isCustomSlashInput(input: string, cwd: string): boolean {
  return expandCustomSlashInput(input, cwd) !== null;
}

export async function handleCommand(input: string, ctx: CommandContext): Promise<void> {
  const trimmed = input.trim();
  const cmd = trimmed.split(" ")[0]?.toLowerCase() ?? "";

  // Multi-word exact matches (e.g. "/git stash pop")
  const twoWord = trimmed.toLowerCase().split(" ").slice(0, 2).join(" ");
  const threeWord = trimmed.toLowerCase().split(" ").slice(0, 3).join(" ");

  const handler =
    resolveHandler(threeWord) ??
    resolveHandler(twoWord) ??
    resolveHandler(trimmed.toLowerCase()) ??
    resolveHandler(cmd);

  if (handler) {
    try {
      await handler(input, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sysMsg(ctx, `Command error: ${msg}`);
    }
    return;
  }

  if (isCustomSlashInput(trimmed, ctx.cwd)) {
    // useChat.handleSubmit expands the template, so queued and direct runs share one path.
    await ctx.chat.handleSubmit(trimmed);
    return;
  }

  sysMsg(ctx, `Unknown command: ${cmd}. Type /help for available commands.`);
}

/** Command definitions for autocomplete — single source of truth. */
export interface CommandDef {
  cmd: string;
  /** Icon name. */
  ic: string;
  desc: string;
  category: string;
  /** Free-form keywords folded into fuzzy match. */
  tags?: string[];

  hidden?: boolean | (() => boolean);
  /**
   * Promote to the "Suggested" section when palette filter is empty.
   * `boolean` for static, `() => boolean` for context-dependent (e.g. only
   * suggest `/setup` when no model is connected). Evaluated on each render.
   */
  suggested?: boolean | (() => boolean);
  /** Alias slash strings (e.g. `["/q", "/quit"]` for `/exit`). */
  aliases?: string[];
}

export const CATEGORIES = [
  "Session",
  "Git",
  "Models",
  "Intelligence",
  "Settings",
  "Editor",
  "Tabs",
  "System",
  "Custom",
] as const;

const COMMAND_DEFS: CommandDef[] = [
  {
    cmd: "/project",
    ic: "folder",
    desc: "This project: sessions, workflow runs, what waits for you",
    category: "Session",
    tags: ["folder", "workspace", "sessions", "runs", "working set"],
  },
  {
    cmd: "/project waiting",
    ic: "folder",
    desc: "What waits for you here and in your other recent projects",
    category: "Session",
    tags: ["attention", "needs you", "approvals", "projects"],
  },
  {
    cmd: "/project rename",
    ic: "folder",
    desc: "Rename this project in every app; no name restores the default",
    category: "Session",
    tags: ["folder", "workspace", "name", "title"],
  },
  {
    cmd: "/projects",
    ic: "folder",
    desc: "Switch project: known folders, pin, forget, open folder (Alt+O)",
    category: "Session",
    tags: ["folder", "workspace", "switch", "cwd", "open"],
  },
  {
    cmd: "/workflow",
    ic: "list",
    desc: "Spec-driven workflows, approvals and verification",
    category: "Session",
    tags: ["spec", "agents", "review", "tasks"],
  },
  // ── Drafts ──
  {
    cmd: "/editor",
    ic: "edit",
    desc: "Compose a message in $EDITOR and send it (Ctrl+X E)",
    category: "Session",
    tags: ["editor", "vim", "nano", "compose", "draft"],
  },
  {
    cmd: "/stash",
    ic: "archive",
    desc: "Browse stashed drafts (restore, delete)",
    category: "Session",
    tags: ["drafts", "stash", "prompts", "history"],
    aliases: ["/drafts"],
  },
  // ── Session ──
  {
    cmd: "/compact",
    ic: "compress",
    desc: "Compact — run, settings, logs",
    category: "Session",
    tags: ["context", "summarize", "compaction"],
  },
  {
    cmd: "/compact logs",
    ic: "plan",
    desc: "View compaction events",
    category: "Session",
    tags: ["debug", "logs"],
  },
  {
    cmd: "/compact settings",
    ic: "compress",
    desc: "Compaction strategy & pruning settings",
    category: "Session",
    tags: ["v1", "v2", "pruning"],
  },
  {
    cmd: "/session",
    ic: "clock_alt",
    desc: "Session — history, clear, export, compact",
    category: "Session",
    tags: ["history", "restore", "manage"],
  },
  {
    cmd: "/session clear",
    ic: "clear",
    desc: "Clear chat history",
    category: "Session",
    tags: ["reset"],
  },
  {
    cmd: "/session compact",
    ic: "compress",
    desc: "Compact conversation context",
    category: "Session",
    tags: ["context", "summarize"],
    hidden: true,
  },
  {
    cmd: "/session continue",
    ic: "play",
    desc: "Continue interrupted generation",
    category: "Session",
    tags: ["resume"],
  },
  {
    cmd: "/session export",
    ic: "changes",
    desc: "Export chat — markdown, json, clipboard, all",
    category: "Session",
    tags: ["save", "markdown", "json", "clipboard", "diagnostic"],
  },
  {
    cmd: "/session export all",
    ic: "search",
    desc: "Full diagnostic export (system prompt, messages, tools)",
    category: "Session",
    tags: ["debug"],
  },
  {
    cmd: "/session export api",
    ic: "search",
    desc: "Toggle per-step API request dump",
    category: "Session",
    tags: ["debug", "tokens", "cost"],
  },
  {
    cmd: "/session export clipboard",
    ic: "changes",
    desc: "Copy chat to clipboard (markdown)",
    category: "Session",
    tags: ["copy"],
  },
  {
    cmd: "/session export json",
    ic: "changes",
    desc: "Export chat as JSON",
    category: "Session",
    tags: ["save"],
  },
  {
    cmd: "/session history",
    ic: "clock_alt",
    desc: "Browse & restore sessions",
    category: "Session",
    tags: ["history", "restore"],
  },
  {
    cmd: "/session new",
    ic: "add",
    desc: "Start a new session (saves current)",
    category: "Session",
    tags: ["new", "fresh", "reset"],
  },
  {
    cmd: "/session rename",
    ic: "edit",
    desc: "Rename current session",
    category: "Session",
    tags: ["rename", "title", "name"],
  },
  {
    cmd: "/session plan",
    ic: "plan",
    desc: "Toggle plan mode (research & plan only)",
    category: "Session",
    tags: ["architect", "research"],
  },

  // ── Git ──
  { cmd: "/git", ic: "git", desc: "Git menu", category: "Git", tags: ["menu"] },
  {
    cmd: "/git branch",
    ic: "git",
    desc: "Show/create branch",
    category: "Git",
    tags: ["checkout"],
  },
  {
    cmd: "/git co-author",
    ic: "git",
    desc: "Toggle co-author trailer",
    category: "Git",
    tags: ["commit"],
  },
  {
    cmd: "/git commit",
    ic: "git",
    desc: "Git commit with message",
    category: "Git",
    tags: ["save"],
  },
  { cmd: "/git diff", ic: "git", desc: "View changes", category: "Git", tags: ["changes"] },
  {
    cmd: "/git init",
    ic: "git",
    desc: "Initialize git repo",
    category: "Git",
    tags: ["create"],
  },
  { cmd: "/git log", ic: "git", desc: "Show recent commits", category: "Git", tags: ["history"] },
  {
    cmd: "/git pull",
    ic: "git",
    desc: "Pull from remote",
    category: "Git",
    tags: ["fetch", "sync"],
  },
  {
    cmd: "/git push",
    ic: "git",
    desc: "Push to remote",
    category: "Git",
    tags: ["sync", "upload"],
  },
  {
    cmd: "/git stash",
    ic: "git",
    desc: "Stash changes — pop to restore",
    category: "Git",
    tags: ["save", "pop", "restore"],
  },
  {
    cmd: "/git stash pop",
    ic: "git",
    desc: "Pop latest stash",
    category: "Git",
    tags: ["restore"],
  },
  { cmd: "/git status", ic: "git", desc: "Git status", category: "Git", tags: ["info"] },

  // ── Models ──
  {
    cmd: "/keys",
    ic: "cog",
    desc: "Manage LLM provider API keys",
    category: "Models",
    tags: ["api", "auth"],
  },
  {
    cmd: "/codex",
    ic: "model",
    desc: "Show Codex login status",
    category: "Models",
    tags: ["codex", "auth", "status", "account"],
  },
  {
    cmd: "/codex login",
    ic: "model",
    desc: "Log in to Codex with your ChatGPT subscription",
    category: "Models",
    tags: ["codex", "auth", "oauth", "browser", "chatgpt"],
  },
  {
    cmd: "/codex logout",
    ic: "model",
    desc: "Log out of the current Codex account",
    category: "Models",
    tags: ["codex", "auth", "logout", "account"],
  },
  {
    cmd: "/codex switch",
    ic: "model",
    desc: "Switch to a different Codex account",
    category: "Models",
    tags: ["codex", "auth", "switch", "account"],
  },
  {
    cmd: "/codex status",
    ic: "model",
    desc: "Show Codex login status",
    category: "Models",
    tags: ["codex", "auth", "status", "account"],
  },
  {
    cmd: "/claude-code",
    ic: "model",
    desc: "Show Claude Code login status",
    category: "Models",
    tags: ["claude", "claude-code", "auth", "status", "account"],
  },
  {
    cmd: "/claude-code login",
    ic: "model",
    desc: "Log in to Claude Code with your Claude subscription",
    category: "Models",
    tags: ["claude", "claude-code", "auth", "browser", "subscription"],
  },
  {
    cmd: "/claude-code logout",
    ic: "model",
    desc: "Log out of the current Claude Code account",
    category: "Models",
    tags: ["claude", "claude-code", "auth", "logout", "account"],
  },
  {
    cmd: "/claude-code status",
    ic: "model",
    desc: "Show Claude Code login status",
    category: "Models",
    tags: ["claude", "claude-code", "auth", "status", "account"],
  },
  {
    cmd: "/model-scope",
    ic: "cog",
    desc: "Set model scope (project/global)",
    category: "Models",
    tags: ["config"],
  },
  {
    cmd: "/models",
    ic: "system",
    desc: "Switch LLM model (Ctrl+L)",
    category: "Models",
    tags: ["provider", "llm", "switch"],
  },
  {
    cmd: "/provider-settings",
    ic: "system",
    desc: "Provider options — thinking, effort, speed, context",
    category: "Models",
    tags: ["thinking", "effort", "speed", "config"],
  },
  {
    cmd: "/providers",
    ic: "system",
    desc: "Provider & Models",
    category: "Models",
    tags: ["llm", "switch"],
    hidden: true,
  },
  {
    cmd: "/router",
    ic: "router",
    desc: "Route models per task (code, explore, plan, verify)",
    category: "Models",
    tags: ["dispatch", "routing"],
    suggested: true,
  },
  {
    cmd: "/web-search",
    ic: "cog",
    desc: "Web search keys & settings",
    category: "Models",
    tags: ["search", "api"],
  },
  {
    cmd: "/mcp",
    ic: "mcp",
    desc: "MCP servers — status, tools, reconnect",
    category: "Models",
    tags: ["mcp", "servers", "tools", "protocol"],
  },

  // ── Intelligence ──
  {
    cmd: "/context",
    ic: "context",
    desc: "Context & system dashboard",
    category: "Intelligence",
    tags: ["tokens", "budget", "status"],
  },
  {
    cmd: "/context clear",
    ic: "context",
    desc: "Clear injected context (memory, skills)",
    category: "Intelligence",
    tags: ["reset"],
    hidden: true,
  },
  {
    cmd: "/graph",
    ic: "repomap",
    desc: "Code graph at a glance: biggest groups and key files",
    category: "Intelligence",
    tags: ["dependencies", "imports", "structure", "map"],
  },
  {
    cmd: "/diagnose",
    ic: "brain",
    desc: "Health check — LSP, tree-sitter, semantic indexing",
    category: "Intelligence",
    tags: ["health", "debug", "probe"],
  },
  {
    cmd: "/lsp",
    ic: "brain",
    desc: "Manage LSP servers — install, disable, enable",
    category: "Intelligence",
    tags: ["language", "server", "mason", "disable"],
  },
  {
    cmd: "/lsp install",
    ic: "brain",
    desc: "Install & manage LSP servers (Mason registry)",
    category: "Intelligence",
    tags: ["mason", "install", "search"],
  },
  {
    cmd: "/lsp restart",
    ic: "brain",
    desc: "Restart LSP servers (all or specific)",
    category: "Intelligence",
    tags: ["restart"],
  },
  {
    cmd: "/lsp status",
    ic: "brain",
    desc: "LSP status dashboard",
    category: "Intelligence",
    tags: ["language", "server"],
  },
  {
    cmd: "/memory",
    ic: "memory",
    desc: "Manage memory scopes, view & clear",
    category: "Intelligence",
    tags: ["recall", "knowledge"],
  },
  {
    cmd: "/repo-map",
    ic: "tree",
    desc: "Baked map settings (AST index)",
    category: "Intelligence",
    tags: ["semantic", "treesitter"],
  },
  {
    cmd: "/skills",
    ic: "skills",
    desc: "Browse & install skills",
    category: "Intelligence",
    tags: ["plugins", "extensions"],
  },
  {
    cmd: "/tools",
    ic: "search",
    desc: "Enable/disable tools for the agent",
    category: "Intelligence",
    tags: ["tools", "enable", "disable", "toggle"],
  },

  // ── Settings ──
  {
    cmd: "/agent-features",
    ic: "cog",
    desc: "Toggle agent features (de-sloppify, tier routing)",
    category: "Settings",
    tags: ["config", "desloppify", "routing", "verify"],
  },
  {
    cmd: "/chat-style",
    ic: "chat",
    desc: "Toggle chat layout style",
    category: "Settings",
    tags: ["accent", "bubble", "ui"],
  },
  {
    cmd: "/diff-style",
    ic: "git",
    desc: "Change diff display style",
    category: "Settings",
    tags: ["sidebyside", "compact"],
  },
  {
    cmd: "/instructions",
    ic: "system",
    desc: "Toggle instruction files (baked.md, CLAUDE.md, etc.)",
    category: "Settings",
    tags: ["prompt", "config"],
  },
  {
    cmd: "/instructions files",
    ic: "system",
    desc: "List instruction files in prompt order; Enter edits one in $EDITOR",
    category: "Settings",
    tags: ["prompt", "agents", "claude"],
  },
  {
    cmd: "/instructions show",
    ic: "system",
    desc: "Show an instruction file's content",
    category: "Settings",
    tags: ["prompt", "view"],
  },
  {
    cmd: "/instructions edit",
    ic: "system",
    desc: "Edit or create an instruction file in $EDITOR",
    category: "Settings",
    tags: ["prompt", "agents.md", "create"],
  },
  {
    cmd: "/mode",
    ic: "cog",
    desc: "Switch Baked mode",
    category: "Settings",
    tags: ["architect", "plan", "auto"],
    suggested: true,
  },
  {
    cmd: "/motion",
    ic: "cog",
    desc: "Full or reduced animation",
    category: "Settings",
    tags: ["animation", "reduced motion", "accessibility"],
  },
  {
    cmd: "/notifications",
    ic: "info",
    desc: "System notifications and the webhook for runs that wait for you",
    category: "Settings",
    tags: ["webhook", "alerts", "notify", "attention"],
  },
  {
    cmd: "/reasoning",
    ic: "brain",
    desc: "Show or hide reasoning content",
    category: "Settings",
    tags: ["thinking", "display"],
  },
  {
    cmd: "/settings",
    ic: "cog",
    desc: "Settings hub — all options in one place",
    category: "Settings",
    tags: ["config", "preferences", "hub"],
  },
  {
    cmd: "/telemetry",
    ic: "info",
    desc: "Turn anonymous usage telemetry on or off",
    category: "Settings",
    tags: ["privacy", "usage", "opt out", "tracking"],
  },
  {
    cmd: "/theme",
    ic: "palette",
    desc: "Switch color theme (live preview)",
    category: "Settings",
    tags: ["color", "dark", "light", "catppuccin", "dracula", "nord", "gruvbox", "solarized"],
  },
  {
    cmd: "/verbose",
    ic: "cog",
    desc: "Toggle verbose tool output",
    category: "Settings",
    tags: ["debug", "output"],
  },
  {
    cmd: "/verbose-tab",
    ic: "ghost",
    desc: "Toggle verbose render for this tab — off folds tools into a rail, on shows raw stream",
    category: "Settings",
    tags: ["focus", "quiet", "narration", "shush"],
    suggested: true,
  },

  // ── Tabs ──
  {
    cmd: "/changes",
    ic: "changes",
    desc: "Toggle files changed this session",
    category: "Tabs",
    tags: ["files", "diff", "modified"],
  },
  {
    cmd: "/claim",
    ic: "lock",
    desc: "Show active file claims across tabs",
    category: "Tabs",
    tags: ["lock"],
  },
  {
    cmd: "/claim force",
    ic: "lock",
    desc: "Steal a file claim from another tab",
    category: "Tabs",
    tags: ["lock"],
  },
  {
    cmd: "/claim release",
    ic: "lock",
    desc: "Release a file claim from current tab",
    category: "Tabs",
    tags: ["lock"],
  },
  {
    cmd: "/claim release-all",
    ic: "lock",
    desc: "Release all claims from current tab",
    category: "Tabs",
    tags: ["lock"],
  },
  {
    cmd: "/tab",
    ic: "tabs",
    desc: "Tabs — switch, new, close, rename",
    category: "Tabs",
    tags: ["switch", "list"],
  },
  {
    cmd: "/tab close",
    ic: "tabs",
    desc: "Close current tab (Ctrl+W)",
    category: "Tabs",
    tags: ["remove"],
  },
  {
    cmd: "/tab new",
    ic: "tabs",
    desc: "Open new tab (Ctrl+T)",
    category: "Tabs",
    tags: ["create"],
  },
  {
    cmd: "/tab rename",
    ic: "pencil",
    desc: "Rename current tab",
    category: "Tabs",
    tags: ["label"],
  },

  // ── System ──
  {
    cmd: "/errors",
    ic: "error",
    desc: "Browse error log",
    category: "System",
    tags: ["debug", "log"],
  },
  {
    cmd: "/help",
    ic: "help",
    desc: "Command palette (Ctrl+K)",
    category: "System",
    tags: ["commands", "search"],
    suggested: true,
  },
  {
    cmd: "/commands",
    ic: "list",
    desc: "List custom commands from .baked/commands",
    category: "System",
    tags: ["custom", "slash", "prompts", "templates"],
  },
  {
    cmd: "/hooks",
    ic: "cog",
    desc: "View active hooks (PreToolUse, PostToolUse, etc.)",
    category: "System",
    tags: ["hooks", "claude", "lifecycle"],
  },
  {
    cmd: "/quit",
    ic: "quit",
    desc: "Exit baked",
    category: "System",
    tags: ["exit", "close"],
    aliases: ["/q"],
  },
  {
    cmd: "/exit",
    ic: "quit",
    desc: "Exit baked",
    category: "System",
    tags: ["quit", "close"],
    aliases: ["/q"],
  },
  { cmd: "/restart", ic: "ghost", desc: "Full restart", category: "System", tags: ["reboot"] },
  {
    cmd: "/setup",
    ic: "ghost",
    desc: "Check & install prerequisites",
    category: "System",
    tags: ["install", "check"],
  },
  {
    cmd: "/status",
    ic: "info",
    desc: "System status dashboard",
    category: "System",
    tags: ["info", "health", "context", "tokens"],
  },
  {
    cmd: "/model-events",
    ic: "info",
    desc: "Model events — per-call latency, tokens, errors (opt-in)",
    category: "System",
    tags: ["debug", "metrics", "latency", "errors", "performance", "models", "telemetry"],
  },
  {
    cmd: "/storage",
    ic: "system",
    desc: "View & manage storage usage",
    category: "System",
    tags: ["disk", "cleanup"],
  },
  {
    cmd: "/wizard",
    ic: "ghost",
    desc: "Re-run the first-run setup wizard",
    category: "System",
    tags: ["onboarding", "setup", "welcome"],
  },
  {
    cmd: "/timeouts",
    ic: "clock",
    desc: "Configure tool and watchdog timeouts",
    category: "System",
    tags: ["timeout", "shell", "agent", "watchdog", "stall"],
  },

  // ── Session (Checkpoints) ──
  {
    cmd: "/checkpoint",
    ic: "bookmark",
    desc: "Browse checkpoints — undo, redo, save",
    category: "Session",
    tags: ["undo", "redo", "history", "revert"],
  },
  {
    cmd: "/checkpoint undo",
    ic: "bookmark",
    desc: "Undo last checkpoint (revert files)",
    category: "Session",
    tags: ["revert", "rollback"],
    aliases: ["/undo"],
  },
  {
    cmd: "/checkpoint redo",
    ic: "bookmark",
    desc: "Redo last undone checkpoint",
    category: "Session",
    tags: ["restore"],
    aliases: ["/redo"],
  },
  {
    cmd: "/checkpoint fork",
    ic: "bookmark",
    desc: "Fork a checkpoint into a new tab (rolls back files)",
    category: "Session",
    tags: ["branch", "rollback", "tab"],
  },
  {
    cmd: "/checkpoint save",
    ic: "bookmark",
    desc: "Force save current state as git tag",
    category: "Session",
    tags: ["git", "tag", "snapshot"],
  },
  {
    cmd: "/checkpoint live",
    ic: "bookmark",
    desc: "Back to live view",
    category: "Session",
    tags: ["browse"],
  },
];

export function getCommandDefs(): CommandDef[] {
  return [...COMMAND_DEFS, ...getCustomCommandDefs()];
}

function getCustomCommandDefs(): CommandDef[] {
  return getCachedCustomCommands(getCwd())
    .filter((c) => !isBuiltinCommandName(c.name))
    .map((c) => ({
      cmd: c.name,
      ic: "pencil",
      desc: c.argumentHint ? `${c.description} ${c.argumentHint}` : c.description,
      category: "Custom",
      tags: ["custom", c.scope],
    }));
}

export type { CommandContext, CommandHandler };
/**
 * Return command defs flagged as `suggested` — top picks for the palette's
 * empty-filter state. Evaluates predicate suggesteds (e.g. only suggest
 * `/setup` when prerequisites are missing).
 */
export function isDefHidden(def: CommandDef): boolean {
  return typeof def.hidden === "function" ? def.hidden() : def.hidden === true;
}

export function getSuggestedCommandDefs(): CommandDef[] {
  return getCommandDefs().filter((d) => {
    if (isDefHidden(d)) return false;
    return typeof d.suggested === "function" ? d.suggested() : d.suggested === true;
  });
}

/**
 * Resolve a slash command's alias chain — pass a typed slash, get the canonical
 * `cmd` if it's registered as an alias. Used by the autocomplete to surface
 * aliases under their main entry rather than as duplicate rows.
 */
export function resolveAlias(slash: string): string | null {
  const needle = slash.trim().toLowerCase();
  for (const def of getCommandDefs()) {
    if (def.cmd.toLowerCase() === needle) return def.cmd;
    if (def.aliases?.some((a) => a.toLowerCase() === needle)) return def.cmd;
  }
  return null;
}
