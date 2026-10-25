import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { loadConfig, loadProjectConfig } from "../../../../config/index.js";
import { getCwd } from "../../../cwd.js";
import {
  commandExists,
  configDir,
  IS_WIN,
  pwshExecutable,
  userDataDir,
} from "../../../platform/index.js";
import type { Language } from "../../types.js";
import { loadRegistry } from "./installer.js";

export interface LspServerConfig {
  command: string;
  args: string[];
  language: Language;
}

interface ServerCandidate {
  command: string;
  args: string[];
}

const SERVER_CANDIDATES: Record<string, ServerCandidate[]> = {
  typescript: [
    { command: "typescript-language-server", args: ["--stdio"] },
    { command: "biome", args: ["lsp-proxy"] },
    { command: "deno", args: ["lsp"] },
    { command: "vscode-eslint-language-server", args: ["--stdio"] },
  ],
  javascript: [
    { command: "typescript-language-server", args: ["--stdio"] },
    { command: "biome", args: ["lsp-proxy"] },
    { command: "deno", args: ["lsp"] },
    { command: "vscode-eslint-language-server", args: ["--stdio"] },
  ],
  python: [
    { command: "pyright-langserver", args: ["--stdio"] },
    { command: "pylsp", args: [] },
  ],
  go: [{ command: "gopls", args: ["serve"] }],
  rust: [{ command: "rust-analyzer", args: [] }],
  lua: [
    { command: "lua-language-server", args: [] },
    // luau-lsp serves both .lua and .luau (.luau maps to `lua` in EXT_TO_LANGUAGE).
    // Listed second so existing pure-Lua setups keep lua-language-server.
    { command: "luau-lsp", args: ["lsp"] },
  ],
  c: [{ command: "clangd", args: [] }],
  cpp: [{ command: "clangd", args: [] }],
  ruby: [{ command: "solargraph", args: ["stdio"] }],
  php: [{ command: "intelephense", args: ["--stdio"] }],
  zig: [{ command: "zls", args: [] }],
  bash: [{ command: "bash-language-server", args: ["start"] }],
  css: [
    { command: "vscode-css-language-server", args: ["--stdio"] },
    { command: "biome", args: ["lsp-proxy"] },
    { command: "tailwindcss-language-server", args: ["--stdio"] },
  ],
  html: [
    { command: "vscode-html-language-server", args: ["--stdio"] },
    { command: "emmet-language-server", args: ["--stdio"] },
  ],
  json: [
    { command: "vscode-json-language-server", args: ["--stdio"] },
    { command: "biome", args: ["lsp-proxy"] },
  ],
  yaml: [{ command: "yaml-language-server", args: ["--stdio"] }],
  toml: [{ command: "taplo", args: ["lsp", "stdio"] }],
  dockerfile: [{ command: "docker-langserver", args: ["--stdio"] }],
  java: [{ command: "jdtls", args: [] }],
  kotlin: [{ command: "kotlin-language-server", args: [] }],
  scala: [{ command: "metals", args: [] }],
  csharp: [
    { command: "csharp-ls", args: [] },
    { command: "OmniSharp", args: ["--languageserver"] },
  ],
  swift: [{ command: "sourcekit-lsp", args: [] }],
  dart: [{ command: "dart", args: ["language-server", "--protocol=lsp"] }],
  elixir: [
    { command: "elixir-ls", args: [] },
    { command: "expert", args: [] },
  ],
  ocaml: [{ command: "ocamllsp", args: [] }],
  vue: [{ command: "vue-language-server", args: ["--stdio"] }],
  // sqls reads its database connections from its own config; without one it still parses (#1499).
  sql: [
    { command: "sqls", args: [] },
    { command: "sql-language-server", args: ["up", "--method", "stdio"] },
  ],
  // A release bundle started by PowerShell, not a program on PATH: see `SERVER_BUNDLES` (#2125).
  powershell: [{ command: "powershell-editor-services", args: [] }],
};

/**
 * A server shipped as a release folder that a runtime starts, named by its Mason package: the
 * folder is `lsp-servers/NAME` (where `/lsp` installs it) or Mason's `packages/NAME` (#2125).
 */
export interface ServerBundle {
  /** A file inside the folder that shows the bundle is installed. */
  entry: string;
  /** The program that runs the bundle. */
  runtime: () => string;
  /** The runtime's arguments for the bundle in `folder`. */
  args: (folder: string) => string[];
}

const PSES_STATE = () => join(userDataDir(), "powershell-editor-services");
const quoted = (path: string) => `'${path.replaceAll("'", "''")}'`;
// The entry path keeps the install folder's own separators: Node's `join` on Windows would turn a
// POSIX folder's slashes into backslashes, so the command would name a path that is not the folder.
const inFolder = (folder: string, ...parts: string[]) =>
  (folder.includes("\\") ? win32 : posix).join(folder, ...parts);

const SERVER_BUNDLES: Record<string, ServerBundle> = {
  // PowerShell Editor Services, by PowerShell 7 (Windows PowerShell 5.1 on a Windows machine
  // without it, as the gates run). Its log and session file go to BAKED's data folder, not the
  // project; the bundle's own PSScriptAnalyzer gives the diagnostics.
  "powershell-editor-services": {
    entry: join("PowerShellEditorServices", "Start-EditorServices.ps1"),
    runtime: pwshExecutable,
    args: (folder) => [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        `& ${quoted(inFolder(folder, "PowerShellEditorServices", "Start-EditorServices.ps1"))}`,
        "-Stdio",
        `-BundledModulesPath ${quoted(folder)}`,
        `-LogPath ${quoted(join(PSES_STATE(), "logs"))}`,
        "-LogLevel Warning",
        `-SessionDetailsPath ${quoted(join(PSES_STATE(), "session.json"))}`,
        "-FeatureFlags @()",
        "-HostName baked",
        "-HostProfileId baked",
        // Any version parses; the real one would bundle package.json, whose dependency list trips
        // the worker bundle's TUI canary (scripts/build.ts).
        "-HostVersion 1.0.0",
      ].join(" "),
    ],
  },
};

/** The bundle a server command names, or undefined for a program. */
export const serverBundle = (command: string): ServerBundle | undefined => SERVER_BUNDLES[command];

/**
 * How to start a server: a program runs as itself, a bundle through its runtime (resolved is
 * the bundle's folder then).
 */
export function serverLaunch(
  command: string,
  resolved: string,
  args: string[],
): { command: string; args: string[] } {
  const bundle = SERVER_BUNDLES[command];
  return bundle
    ? { command: bundle.runtime(), args: bundle.args(resolved) }
    : { command: resolved, args };
}

/**
 * What a server writes into the project it is started on, and how it is kept out of the user's
 * checkout (#1508). Workflow task files map to the checkout root (`serverRootFor`), so a server
 * that imports a project in place leaves its files in the user's working tree.
 */
export interface ServerProjectState {
  /** Arguments that move the server's own state out of the project, by project root. */
  args?: (root: string) => string[];
  /** `initializationOptions` of the initialize request. */
  initializationOptions?: unknown;
  /** `.git/info/exclude` patterns for files the server can still create in the project. */
  excludes: string[];
}

const SERVER_PROJECT_STATE: Record<string, ServerProjectState> = {
  // jdtls imports Maven and Gradle projects as Eclipse projects. Its workspace goes to a
  // per-project data directory, and the Eclipse files with it; older servers that ignore the
  // preference still write `.project`, `.classpath` and `.settings/` next to each module.
  jdtls: {
    args: (root) => [
      "-data",
      join(
        userDataDir(),
        "jdtls-workspaces",
        createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16),
      ),
    ],
    initializationOptions: {
      settings: { java: { import: { generatesMetadataFilesAtProjectRoot: false } } },
    },
    excludes: [".project", ".classpath", ".settings/", ".factorypath"],
  },
  // Metals keeps its database and the Bloop build server's state in the project.
  metals: { excludes: ["/.metals/", "/.bloop/", "/.bsp/"] },
  // ElixirLS builds the project into `.elixir_ls/`.
  "elixir-ls": { excludes: ["/.elixir_ls/"] },
};

/** The project state of a server, by its command name or resolved path. */
export function serverProjectState(command: string): ServerProjectState | undefined {
  const name = basename(command.replaceAll("\\", "/")).replace(/\.(?:exe|cmd|bat)$/i, "");
  return SERVER_PROJECT_STATE[name];
}

/**
 * Lists the server's files in the repository's local `.git/info/exclude`, so they never show as
 * untracked in the user's checkout or reach a commit. Nothing changes outside a Git repository.
 */
export function excludeServerFiles(root: string, patterns: readonly string[]): void {
  if (patterns.length === 0) return;
  const result = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  const path = result.status === 0 ? result.stdout.trim() : "";
  if (!path) return;
  const file = isAbsolute(path) ? path : join(root, path);
  try {
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    const lines = new Set(current.split(/\r?\n/));
    const missing = patterns.filter((pattern) => !lines.has(pattern));
    if (missing.length === 0) return;
    mkdirSync(dirname(file), { recursive: true });
    const separator = current && !current.endsWith("\n") ? "\n" : "";
    appendFileSync(file, `${separator}${missing.join("\n")}\n`);
  } catch {
    // A read-only repository keeps its state; the server still starts.
  }
}

const MASON_BIN_DIR = join(userDataDir(), "mason", "bin");

/** baked installs LSP servers here via /lsp-install */
const BAKED_BIN_DIR = join(configDir(), "lsp-servers");

/** Suffixes to probe when looking up a server binary. Windows installs as
 * `.cmd` shims (npm) or `.exe` (native), so we must try those before giving up. */
const BIN_SUFFIXES = IS_WIN ? [".exe", ".cmd", ""] : [""];

function firstExisting(dir: string, cmd: string): string | null {
  for (const sfx of BIN_SUFFIXES) {
    const p = join(dir, cmd + sfx);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Check if a command exists in Mason's bin directory */
function commandExistsInMason(cmd: string): string | null {
  return firstExisting(MASON_BIN_DIR, cmd);
}

/** Check baked's own install directory */
function findInbaked(cmd: string): string | null {
  // npm-installed servers go to node_modules/.bin/
  const npmBin = firstExisting(join(BAKED_BIN_DIR, "node_modules", ".bin"), cmd);
  if (npmBin) return npmBin;
  // pip/go/cargo-installed servers go to bin/
  const directBin = firstExisting(join(BAKED_BIN_DIR, "bin"), cmd);
  if (directBin) return directBin;
  return null;
}

export type LspServerSource = "PATH" | "baked" | "mason";
export interface ResolvedServerCommand {
  /** The command name when it is on PATH, otherwise the absolute path. */
  path: string;
  source: LspServerSource;
}

/** Cache of resolved commands: name → where it was found (or null) */
const probeCache = new Map<string, ResolvedServerCommand | null>();

/** The folder of an installed bundle whose runtime is on PATH. */
function probeBundle(name: string, bundle: ServerBundle): ResolvedServerCommand | null {
  if (!commandExists(bundle.runtime())) return null;
  for (const [folder, source] of [
    [join(BAKED_BIN_DIR, name), "baked"],
    [join(userDataDir(), "mason", "packages", name), "mason"],
  ] as const)
    if (existsSync(join(folder, bundle.entry))) return { path: folder, source };
  return null;
}

function probe(cmd: string): ResolvedServerCommand | null {
  const bundle = SERVER_BUNDLES[cmd];
  if (bundle) return probeBundle(cmd, bundle);
  if (commandExists(cmd)) return { path: cmd, source: "PATH" };
  const sfPath = findInbaked(cmd);
  if (sfPath) return { path: sfPath, source: "baked" };
  const masonPath = commandExistsInMason(cmd);
  if (masonPath) return { path: masonPath, source: "mason" };
  return null;
}

/**
 * Resolve a server command to an executable: $PATH first, then baked's install directory, then
 * Mason's. Returns null when it is not installed.
 */
export function resolveServerCommand(cmd: string): ResolvedServerCommand | null {
  const cached = probeCache.get(cmd);
  if (cached !== undefined) return cached;
  const found = probe(cmd);
  probeCache.set(cmd, found);
  return found;
}

/** One language server baked can start: its command and the languages it serves. */
export interface LspServerCandidate {
  command: string;
  args: string[];
  languages: Language[];
}

/** Every server baked knows, once each, in the order they are first listed. */
export function lspServerCandidates(): LspServerCandidate[] {
  const byCommand = new Map<string, LspServerCandidate>();
  for (const [language, candidates] of Object.entries(SERVER_CANDIDATES)) {
    for (const candidate of candidates) {
      const entry = byCommand.get(candidate.command);
      if (entry) entry.languages.push(language as Language);
      else
        byCommand.set(candidate.command, {
          command: candidate.command,
          args: candidate.args,
          languages: [language as Language],
        });
    }
  }
  return [...byCommand.values()];
}

/** The Mason packages whose binaries include `cmd`; `/lsp` used to disable servers by these. */
export function packagesProvidingCommand(cmd: string): string[] {
  return loadRegistry()
    .filter((p) => p.bin && Object.hasOwn(p.bin, cmd))
    .map((p) => p.name);
}

/**
 * Whether a disabled list names the server: by its command, or by the Mason package that
 * installs it (older `/lsp` versions wrote package names such as `pyright`).
 */
export function listDisablesServer(disabled: readonly string[], cmd: string): boolean {
  if (disabled.length === 0) return false;
  if (disabled.includes(cmd)) return true;
  return packagesProvidingCommand(cmd).some((name) => disabled.includes(name));
}

/** Check if a server command is disabled by user config */
function isServerDisabled(cmd: string): boolean {
  const cwd = getCwd();
  const global = loadConfig();
  const project = loadProjectConfig(cwd);
  const disabled = project?.disabledLspServers ?? global.disabledLspServers ?? [];
  return listDisablesServer(disabled, cmd);
}

/**
 * Find ALL available LSP servers for the given language.
 * Returns them in priority order (first = highest priority).
 * Skips servers that are disabled in user config or not found on PATH.
 */
export function findServersForLanguage(language: Language): LspServerConfig[] {
  const candidates = SERVER_CANDIDATES[language];
  if (!candidates) return [];

  const results: LspServerConfig[] = [];
  for (const candidate of candidates) {
    if (isServerDisabled(candidate.command)) continue;
    const resolved = resolveServerCommand(candidate.command);
    if (resolved)
      results.push({ ...serverLaunch(candidate.command, resolved.path, candidate.args), language });
  }
  return results;
}

/** Clear the probe cache, so newly installed or removed servers are found again */
export function clearProbeCache(): void {
  probeCache.clear();
}
