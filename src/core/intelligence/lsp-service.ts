/**
 * Language servers as every front end sees them: the servers baked knows, whether the project
 * uses their language, whether they are installed, disabled or running, and their last start
 * failure; plus the changes `/lsp` makes in the terminal UI (install from the Mason registry,
 * enable, disable, restart). The TUI, `baked lsp` and `/v1/lsp` all go through this module.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { configDir } from "../platform/index.js";
import type { LspServerError } from "./backends/lsp/index.js";
import {
  checkPackageStatus,
  clearPathCache,
  downloadRegistry,
  installPackage,
  loadRegistry,
  type MasonPackage,
  type PackageStatus,
} from "./backends/lsp/installer.js";
import {
  clearProbeCache,
  type LspServerCandidate,
  type LspServerSource,
  listDisablesServer,
  lspServerCandidates,
  type ResolvedServerCommand,
  resolveServerCommand,
} from "./backends/lsp/server-registry.js";
import {
  getDetailedLspServers,
  getLspServerErrors,
  isIntelligenceReady,
  restartLspServers,
} from "./instance.js";
import { detectProjectLanguages } from "./router.js";
import type { Language } from "./types.js";

export type LspScope = "global" | "project";

export interface LspServerView {
  /** The server's command; `disabledLspServers` and every action name it by this. */
  id: string;
  languages: Language[];
  /** The project contains files of one of its languages. */
  detected: boolean;
  installed: boolean;
  source: LspServerSource | null;
  /** The executable that starts: the command when it is on PATH, otherwise its full path. */
  path: string | null;
  disabled: boolean;
  /** The config files whose `disabledLspServers` name it. */
  disabledIn: LspScope[];
  running: boolean;
  /** At least one running instance answered `initialize`. */
  ready: boolean;
  pids: number[];
  openFiles: number;
  diagnosticCount: number;
  lastError: { message: string; at: number } | null;
  /** The Mason package that installs it, when the registry has one. */
  package: string | null;
  /** The toolchain the install needs (`go`, `cargo`, `pip3`), when it needs one. */
  requiresToolchain: string | null;
  /** `package` is known and its toolchain is on PATH. */
  installable: boolean;
}

export interface LspStatusView {
  servers: LspServerView[];
  /** The project's languages, primary first. */
  languages: Language[];
  /** Detected languages that no enabled, installed server covers. */
  uncovered: Language[];
  /** Whether this process started code intelligence; running servers show only then. */
  started: boolean;
  /** Whether the Mason registry is cached locally; `install` downloads it when it is not. */
  registry: boolean;
  /** The config files that hold `disabledLspServers`. */
  paths: Record<LspScope, string>;
}

interface RunningServer {
  language: string;
  command: string;
  pid: number | null;
  openFiles: number;
  diagnosticCount: number;
  ready: boolean;
}

/** What the service reads and runs; tests replace the parts that touch the machine. */
export interface LspServiceDeps {
  candidates(): LspServerCandidate[];
  resolve(command: string): ResolvedServerCommand | null;
  registry(): MasonPackage[];
  downloadRegistry(): Promise<MasonPackage[]>;
  packageStatus(pkg: MasonPackage): Pick<PackageStatus, "requiresToolchain" | "toolchainAvailable">;
  install(
    pkg: MasonPackage,
    onProgress?: (line: string) => void,
  ): Promise<{ success: boolean; error?: string }>;
  detectLanguages(workspace: string): Promise<Language[]>;
  started(): boolean;
  running(): Promise<RunningServer[]>;
  errors(): Promise<LspServerError[]>;
  /** Restarts matching running servers (all without a filter) and returns their names. */
  restart(filter?: string): Promise<string[]>;
  /** Forgets cached executable lookups after an install or a config change. */
  refresh(): void;
}

export const defaultLspServiceDeps: LspServiceDeps = {
  candidates: lspServerCandidates,
  resolve: resolveServerCommand,
  registry: loadRegistry,
  downloadRegistry: () => downloadRegistry(),
  packageStatus: checkPackageStatus,
  install: installPackage,
  detectLanguages: (workspace) => detectProjectLanguages(workspace),
  started: isIntelligenceReady,
  running: getDetailedLspServers,
  errors: getLspServerErrors,
  restart: restartLspServers,
  refresh: () => {
    clearProbeCache();
    clearPathCache();
  },
};

export interface LspServiceOptions {
  workspace: string;
  /** Defaults to `~/.baked/config.json` and `<workspace>/.baked/config.json`. */
  files?: Partial<Record<LspScope, string>>;
  deps?: Partial<LspServiceDeps>;
}

export type LspServiceErrorCode = "NOT_FOUND" | "NOT_INSTALLABLE" | "INSTALL_FAILED";

export class LspServiceError extends Error {
  constructor(
    readonly code: LspServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface Context {
  workspace: string;
  files: Record<LspScope, string>;
  deps: LspServiceDeps;
}

function context(options: LspServiceOptions): Context {
  return {
    workspace: options.workspace,
    files: {
      global: options.files?.global ?? join(configDir(), "config.json"),
      project: options.files?.project ?? join(options.workspace, ".baked", "config.json"),
    },
    deps: { ...defaultLspServiceDeps, ...options.deps },
  };
}

function readConfigObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** `disabledLspServers` of one config file, or null when the file does not set it. */
function readDisabled(file: string): string[] | null {
  const value = readConfigObject(file).disabledLspServers;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
}

function writeDisabled(file: string, list: string[]): void {
  const config = readConfigObject(file);
  config.disabledLspServers = list;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2));
}

/** The name of a server executable without its directory and Windows extension. */
export function serverCommandName(path: string): string {
  return basename(path.replaceAll("\\", "/")).replace(/\.(exe|cmd|bat)$/i, "");
}

/** The Mason package that installs `command`, preferring packages listed as language servers. */
function packageFor(command: string, registry: MasonPackage[]): MasonPackage | null {
  const providing = registry.filter(
    (p) => !p.deprecation && p.bin && Object.hasOwn(p.bin, command),
  );
  return providing.find((p) => p.categories.includes("LSP")) ?? providing[0] ?? null;
}

interface Layers {
  global: string[] | null;
  project: string[] | null;
}

function readLayers(ctx: Context): Layers {
  return { global: readDisabled(ctx.files.global), project: readDisabled(ctx.files.project) };
}

/** The list that applies: a project list replaces the global one, as the language servers read it. */
function effective(layers: Layers): string[] {
  return layers.project ?? layers.global ?? [];
}

/**
 * The names `disabledLspServers` uses for a Mason package: the server commands it installs that
 * baked starts, or the package name when it installs none of them.
 */
export function lspDisableNames(pkg: MasonPackage): string[] {
  const known = new Set(lspServerCandidates().map((c) => c.command));
  const commands = Object.keys(pkg.bin ?? {}).filter((bin) => known.has(bin));
  return commands.length ? commands : [pkg.name];
}

/** The status of every server baked knows, detected languages first. */
export async function lspStatus(options: LspServiceOptions): Promise<LspStatusView> {
  return statusOf(context(options));
}

async function statusOf(ctx: Context): Promise<LspStatusView> {
  const { deps } = ctx;
  const started = deps.started();
  const [languages, running, errors] = await Promise.all([
    deps.detectLanguages(ctx.workspace).catch(() => [] as Language[]),
    started ? deps.running().catch(() => [] as RunningServer[]) : Promise.resolve([]),
    started ? deps.errors().catch(() => [] as LspServerError[]) : Promise.resolve([]),
  ]);
  const registry = deps.registry();
  const layers = readLayers(ctx);
  const disabledList = effective(layers);
  const detected = new Set(languages);

  const servers = deps.candidates().map((candidate): LspServerView => {
    const id = candidate.command;
    const resolved = deps.resolve(id);
    const pkg = packageFor(id, registry);
    const pkgStatus = pkg ? deps.packageStatus(pkg) : null;
    const instances = running.filter((s) => serverCommandName(s.command) === id);
    const error = errors
      .filter((e) => serverCommandName(e.command) === id)
      .sort((a, b) => b.at - a.at)[0];
    const disabledIn = (["global", "project"] as const).filter((scope) => {
      const list = layers[scope];
      return list !== null && listDisablesServer(list, id);
    });
    return {
      id,
      languages: candidate.languages,
      detected: candidate.languages.some((l) => detected.has(l)),
      installed: resolved !== null,
      source: resolved?.source ?? null,
      path: resolved?.path ?? null,
      disabled: listDisablesServer(disabledList, id),
      disabledIn,
      running: instances.length > 0,
      ready: instances.some((s) => s.ready),
      pids: instances.flatMap((s) => (s.pid === null ? [] : [s.pid])),
      openFiles: instances.reduce((n, s) => n + s.openFiles, 0),
      diagnosticCount: instances.reduce((n, s) => n + s.diagnosticCount, 0),
      lastError: error && instances.length === 0 ? { message: error.message, at: error.at } : null,
      package: pkg?.name ?? null,
      requiresToolchain: pkgStatus?.requiresToolchain ?? null,
      installable: pkg !== null && (pkgStatus?.toolchainAvailable ?? false),
    };
  });
  servers.sort((a, b) => Number(b.detected) - Number(a.detected));
  const covered = new Set(
    servers.filter((s) => s.installed && !s.disabled).flatMap((s) => s.languages),
  );
  return {
    servers,
    languages,
    uncovered: languages.filter((l) => !covered.has(l) && isServed(l, servers)),
    started,
    registry: registry.length > 0,
    paths: ctx.files,
  };
}

/** Whether baked knows any server for the language; languages it has none for are not "uncovered". */
function isServed(language: Language, servers: LspServerView[]): boolean {
  return servers.some((s) => s.languages.includes(language));
}

function findServer(ctx: Context, id: string): LspServerCandidate {
  const candidates = ctx.deps.candidates();
  const byCommand = candidates.find((c) => c.command === id);
  if (byCommand) return byCommand;
  const pkg = ctx.deps.registry().find((p) => p.name === id);
  const byPackage = pkg && candidates.find((c) => pkg.bin && Object.hasOwn(pkg.bin, c.command));
  if (byPackage) return byPackage;
  throw new LspServiceError("NOT_FOUND", `No language server named ${id}`);
}

/** Restarts the servers of the languages a server serves, so a change takes effect now. */
async function reload(ctx: Context, server: LspServerCandidate | undefined): Promise<string[]> {
  ctx.deps.refresh();
  if (!server || !ctx.deps.started()) return [];
  const restarted = new Set<string>();
  for (const language of server.languages)
    for (const name of await ctx.deps.restart(language)) restarted.add(name);
  return [...restarted];
}

export interface LspChangeResult {
  status: LspStatusView;
  /** The running servers restarted to apply the change, as `language:command`. */
  restarted: string[];
}

/**
 * Enables or disables a server. Disabling adds it to `scope` (default: the project file when it
 * sets its own list, which replaces the global one, otherwise the global file). Enabling removes
 * it from every file that names it, so it takes effect whichever list applies.
 */
export async function setLspServerDisabled(
  options: LspServiceOptions,
  id: string,
  disabled: boolean,
  scope?: LspScope,
): Promise<LspChangeResult> {
  const ctx = context(options);
  const server = findServer(ctx, id);
  const layers = readLayers(ctx);
  if (disabled) {
    const target: LspScope = scope ?? (layers.project !== null ? "project" : "global");
    const list = layers[target] ?? [];
    if (!listDisablesServer(list, server.command))
      writeDisabled(ctx.files[target], [...list, server.command]);
  } else {
    for (const target of ["global", "project"] as const) {
      const list = layers[target];
      if (list === null || (scope && scope !== target)) continue;
      const names = new Set([server.command, ...packageNames(ctx, server.command)]);
      const next = list.filter((name) => !names.has(name));
      if (next.length !== list.length) writeDisabled(ctx.files[target], next);
    }
  }
  const restarted = await reload(ctx, server);
  return { status: await statusOf(ctx), restarted };
}

function packageNames(ctx: Context, command: string): string[] {
  return ctx.deps
    .registry()
    .filter((p) => p.bin && Object.hasOwn(p.bin, command))
    .map((p) => p.name);
}

export interface LspInstallResult extends LspChangeResult {
  server: string;
  package: string;
}

/**
 * Installs a server from the Mason registry into baked's own directory. `id` is a server
 * command, a Mason package name or a language (the first server for it that can be installed);
 * the registry is downloaded first when it is not cached.
 */
export async function installLspServer(
  options: LspServiceOptions,
  id: string,
  onProgress?: (line: string) => void,
): Promise<LspInstallResult> {
  const ctx = context(options);
  let registry = ctx.deps.registry();
  if (registry.length === 0) {
    onProgress?.("Downloading the Mason registry…");
    registry = await ctx.deps.downloadRegistry();
  }
  const candidates = ctx.deps.candidates();
  let server = candidates.find((c) => c.command === id);
  let pkg = server ? packageFor(server.command, registry) : null;
  if (!server) {
    pkg = registry.find((p) => p.name === id && !p.deprecation) ?? null;
    if (pkg) server = candidates.find((c) => pkg?.bin && Object.hasOwn(pkg.bin, c.command));
  }
  if (!server && !pkg) {
    const forLanguage = candidates.filter((c) => c.languages.includes(id as Language));
    if (forLanguage.length === 0)
      throw new LspServiceError("NOT_FOUND", `No language server, package or language named ${id}`);
    const installed = forLanguage.find((c) => ctx.deps.resolve(c.command));
    if (installed) {
      onProgress?.(`${installed.command} already serves ${id}`);
      return {
        server: installed.command,
        package: packageFor(installed.command, registry)?.name ?? installed.command,
        restarted: [],
        status: await statusOf(ctx),
      };
    }
    const choices = forLanguage.flatMap((c) => {
      const p = packageFor(c.command, registry);
      return p ? [{ c, p }] : [];
    });
    const pick = choices.find(({ p }) => ctx.deps.packageStatus(p).toolchainAvailable);
    if (!pick)
      throw new LspServiceError(
        "NOT_INSTALLABLE",
        choices.length
          ? `The servers for ${id} need a toolchain that is not on PATH: ${choices
              .map(({ c, p }) => `${c.command} (${ctx.deps.packageStatus(p).requiresToolchain})`)
              .join(", ")}`
          : `The Mason registry has no package for the ${id} servers`,
      );
    server = pick.c;
    pkg = pick.p;
  }
  if (!pkg)
    throw new LspServiceError(
      "NOT_INSTALLABLE",
      `The Mason registry has no package that installs ${server?.command ?? id}`,
    );
  const status = ctx.deps.packageStatus(pkg);
  if (!status.toolchainAvailable)
    throw new LspServiceError(
      "NOT_INSTALLABLE",
      `${pkg.name} needs ${status.requiresToolchain ?? "a toolchain"} on PATH`,
    );
  onProgress?.(`Installing ${pkg.name}…`);
  const result = await ctx.deps.install(pkg, onProgress);
  if (!result.success)
    throw new LspServiceError(
      "INSTALL_FAILED",
      `Failed to install ${pkg.name}: ${result.error ?? "unknown error"}`,
    );
  const restarted = await reload(ctx, server);
  return {
    server: server?.command ?? pkg.name,
    package: pkg.name,
    restarted,
    status: await statusOf(ctx),
  };
}

/**
 * Restarts running servers: one server by command, the servers of a language, or all without
 * `id`. Stopped servers start again on the next code-intelligence request (the restart warms the
 * project's languages up at once). A restart also retries servers that failed to start.
 */
export async function restartLspServer(
  options: LspServiceOptions,
  id?: string,
): Promise<LspChangeResult> {
  const ctx = context(options);
  ctx.deps.refresh();
  let filter: string | undefined;
  if (id) {
    const candidates = ctx.deps.candidates();
    const isLanguage = candidates.some((c) => c.languages.includes(id as Language));
    filter = isLanguage ? id : findServer(ctx, id).command;
  }
  const restarted = ctx.deps.started() ? await ctx.deps.restart(filter) : [];
  return { status: await statusOf(ctx), restarted };
}
