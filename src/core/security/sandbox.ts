/**
 * Sandbox mode resolution: which processes run in the OS sandbox, the one-time warning when
 * "auto" finds no backend, and the refusal when "required" finds none. The backends and argv
 * builders are in `src/core/platform/sandbox.ts`. See docs/sandbox.md.
 */

import { mkdirSync } from "node:fs";
import { loadConfig, loadProjectConfig } from "../../config/index.js";
import {
  currentSandboxHost,
  detectSandbox,
  pathsFor,
  SANDBOX_UNSET_ENV,
  type SandboxApplied,
  type SandboxDetection,
  type SandboxHost,
  type SandboxMode,
  type SandboxRequest,
  type SandboxSurface,
  sandboxArgv,
  sandboxGap,
  sandboxProfile,
  workspaceGit,
} from "../platform/sandbox.js";

export type {
  SandboxApplied,
  SandboxDetection,
  SandboxMode,
  SandboxRequest,
} from "../platform/sandbox.js";

export const SANDBOX_MODES: readonly SandboxMode[] = ["off", "auto", "required"];
const rank: Record<SandboxMode, number> = { off: 0, auto: 1, required: 2 };

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" && (SANDBOX_MODES as readonly string[]).includes(value);
}

/** The stricter of the modes; a missing or unknown value counts as off. */
export function stricterSandboxMode(...modes: unknown[]): SandboxMode {
  let result: SandboxMode = "off";
  for (const mode of modes) if (isSandboxMode(mode) && rank[mode] > rank[result]) result = mode;
  return result;
}

/**
 * The global setting (or the CLI override) tightened by the project layer. A project config
 * ships with a cloned repository, so it may raise the mode but never lower it.
 */
export function effectiveSandboxMode(global: unknown, project: unknown): SandboxMode {
  return stricterSandboxMode(global, project);
}

export class SandboxUnavailableError extends Error {
  readonly reason: string;
  constructor(detection: SandboxDetection, platform: NodeJS.Platform = process.platform) {
    const reason = detection.reason ?? "no backend";
    const hint =
      platform === "linux"
        ? "Install bubblewrap (apt install bubblewrap) or set sandbox to auto."
        : "Set sandbox to auto to run without it.";
    super(`Sandbox required but unavailable on ${platform}: ${reason}. ${hint}`);
    this.name = "SandboxUnavailableError";
    this.reason = reason;
  }
}

let override: SandboxMode | undefined;

/** The headless `--sandbox MODE` flag: replaces the global setting for this process. */
export function setSandboxOverride(mode: SandboxMode | undefined): void {
  override = mode;
}

export interface SandboxSettings {
  /** Global setting, or the CLI override when one is set. */
  mode: SandboxMode;
  project: SandboxMode | null;
  effective: SandboxMode;
  source: "config" | "override" | "project";
  /** Network inside the chat sandbox. */
  network: boolean;
}

/** Reads the configuration on each call, like the tool timeout, so a change applies at once. */
export function sandboxSettings(cwd: string): SandboxSettings {
  const global = loadConfig();
  const projectValue = loadProjectConfig(cwd)?.sandbox;
  const project = isSandboxMode(projectValue) ? projectValue : null;
  const mode = override ?? stricterSandboxMode(global.sandbox);
  const effective = effectiveSandboxMode(mode, project);
  return {
    mode,
    project,
    effective,
    source: effective !== mode ? "project" : override ? "override" : "config",
    network: global.sandboxNetwork !== "deny",
  };
}

/** The sandbox of a chat shell or project command, or null when it is off. */
export function chatSandbox(
  projectRoot: string,
  extraWritable: string[] = [],
): SandboxRequest | null {
  const settings = sandboxSettings(projectRoot);
  if (settings.effective === "off") return null;
  return {
    mode: settings.effective,
    surface: "chat",
    writable: [projectRoot, ...extraWritable.filter((p) => p !== projectRoot)],
    workspaces: [projectRoot],
    network: settings.network,
  };
}

/**
 * The sandbox of a workflow process from the run's frozen policy, or null when the run has none.
 * `gitWrite` is set for a run root that is the run's own worktree, so Git commands of a check
 * can write the worktree's Git state; it has no effect on a root that is not a worktree.
 */
export function runSandbox(
  policy: { sandbox?: "auto" | "required"; network: "deny" | "ask" | "allow" },
  root: string,
  options: { surface?: SandboxSurface; gitWrite?: boolean } = {},
): SandboxRequest | null {
  if (!policy.sandbox) return null;
  return {
    mode: policy.sandbox,
    surface: options.surface ?? "workflow",
    writable: [root],
    workspaces: [root],
    protectDefinitions: true,
    ...(options.gitWrite ? { gitWrite: true } : {}),
    // "ask" cannot prompt from inside a process, so only "allow" grants the network.
    network: policy.network === "allow",
  };
}

/**
 * The sandbox of an AI acceptance application, command or promoted test. Only the gate's granted
 * write paths are writable: the workspace stays read-only. The network stays shared while the
 * gate grants ports or hosts, because the host browser and filter proxy must reach the
 * application and its listeners are read from the host's network namespace.
 */
export function acceptanceSandbox(
  policy: { sandbox?: "auto" | "required"; network: "deny" | "ask" | "allow" },
  workspace: string,
  writePaths: string[],
  grantsNetwork: boolean,
): SandboxRequest | null {
  if (!policy.sandbox) return null;
  return {
    mode: policy.sandbox,
    surface: "acceptance",
    writable: writePaths,
    workspaces: [workspace],
    protectDefinitions: true,
    network: grantsNetwork || policy.network === "allow",
  };
}

/**
 * The sandbox of a gate run outside any run (`workflow gate run`): the configured mode, with the
 * network denied as in a run whose policy does not allow it.
 */
export function gateSandbox(workspace: string): SandboxRequest | null {
  const mode = sandboxSettings(workspace).effective;
  return mode === "off" ? null : runSandbox({ sandbox: mode, network: "deny" }, workspace);
}

export interface SandboxLaunch {
  executable: string;
  args: string[];
  /** Environment names to remove from the child. */
  unsetEnv: string[];
  /** Environment values to set in the child. */
  setEnv: Record<string, string>;
  applied: SandboxApplied;
}

const warned = new Set<SandboxSurface>();

/** Forgets the one-time fallback warnings; for tests. */
export function resetSandboxWarnings(): void {
  warned.clear();
}

/**
 * The one-line note for a command that ran without the sandbox it asked for, the first time per
 * surface in this process; null afterwards and when the sandbox applied. Chat tools append it to
 * the tool result rather than writing to stderr, which would corrupt the terminal UI.
 */
export function sandboxNotice(
  applied: SandboxApplied | undefined,
  surface: SandboxSurface,
): string | null {
  if (applied?.backend !== "none" || warned.has(surface)) return null;
  warned.add(surface);
  return `[sandbox] ${applied.reason ?? "no backend"}; ran without OS sandbox`;
}

/**
 * Wraps one launch for the request. "auto" with no backend runs the command as it is and records
 * why; "required" with no backend throws SandboxUnavailableError. `verbatim` marks args that are a
 * ready Windows command line (`bunShellArgs`), which the Windows launcher joins without quoting.
 */
export function sandboxLaunch(
  executable: string,
  args: string[],
  request: SandboxRequest,
  cwd: string,
  detection: SandboxDetection = detectSandbox(),
  host: SandboxHost = currentSandboxHost(),
  options: { verbatim?: boolean; launcher?: string[] } = {},
): SandboxLaunch {
  if (!detection.available) {
    if (request.mode === "required") throw new SandboxUnavailableError(detection, host.platform);
    return {
      executable,
      args,
      unsetEnv: [],
      setEnv: {},
      applied: {
        backend: "none",
        mode: request.mode,
        network: true,
        reason: detection.reason ?? "no backend",
      },
    };
  }
  if (host.platform !== "darwin") ensureHooksDirs(request, host);
  const profile = sandboxProfile(request, cwd, host);
  const argv = sandboxArgv(detection, profile, executable, args, options);
  const gap = sandboxGap(detection, request);
  return {
    executable: argv[0] ?? executable,
    args: argv.slice(1),
    unsetEnv: SANDBOX_UNSET_ENV,
    setEnv: host.platform === "linux" ? { TMPDIR: "/tmp" } : {},
    applied: {
      backend: detection.backend,
      mode: request.mode,
      // The record says what held: a backend that cannot deny the network reports it open.
      network: request.network || gap !== null,
      ...(gap ? { reason: gap } : {}),
    },
  };
}

/**
 * A bind mount needs an existing path, so a missing `hooks` directory of the workspace's Git
 * directories is created (as `git init` would) before it is mounted read-only; otherwise the
 * sandbox could create it with a hook.
 */
function ensureHooksDirs(request: SandboxRequest, host: SandboxHost): void {
  for (const root of request.workspaces) {
    let gitDirs: string[];
    try {
      gitDirs = workspaceGit(host, host.realpath(root), request.gitWrite).gitDirs;
    } catch {
      continue;
    }
    for (const dir of gitDirs) {
      const hooks = pathsFor(host.platform).join(dir, "hooks");
      if (!host.isDirectory(dir) || host.exists(hooks)) continue;
      try {
        mkdirSync(hooks);
      } catch {}
    }
  }
}

/** The child's environment with the launch's changes applied. */
export function sandboxEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  launch: Pick<SandboxLaunch, "unsetEnv" | "setEnv">,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const name of launch.unsetEnv) delete out[name];
  return { ...out, ...launch.setEnv };
}

export interface SandboxStatus {
  /** Global setting, or the CLI override. */
  mode: SandboxMode;
  /** The project config's value, which can only tighten. */
  project: SandboxMode | null;
  effectiveMode: SandboxMode;
  source: SandboxSettings["source"];
  backend: SandboxDetection["backend"];
  available: boolean;
  path: string | null;
  reason: string | null;
  /** Network inside the chat sandbox. */
  network: "allow" | "deny";
  /** Whether chat commands run isolated right now. */
  active: boolean;
}

export function sandboxStatus(
  cwd: string,
  detection: SandboxDetection = detectSandbox(),
): SandboxStatus {
  const settings = sandboxSettings(cwd);
  return {
    mode: settings.mode,
    project: settings.project,
    effectiveMode: settings.effective,
    source: settings.source,
    backend: detection.backend,
    available: detection.available,
    path: detection.path,
    reason: detection.reason,
    network: settings.network ? "allow" : "deny",
    active: settings.effective !== "off" && detection.available,
  };
}

/** Status as text lines for the terminal command and the CLI. */
export function formatSandboxStatus(status: SandboxStatus): string[] {
  const backend = status.available
    ? `${status.backend} (${status.path ?? "found"})`
    : `unavailable: ${status.reason ?? "no backend"}`;
  const lines = [
    `Sandbox mode: ${status.effectiveMode}${
      status.source === "project"
        ? ` (project config raised it from ${status.mode})`
        : status.source === "override"
          ? " (command-line override)"
          : ""
    }`,
    `Backend: ${backend}`,
    `Chat network: ${status.network}`,
  ];
  if (status.effectiveMode === "off")
    lines.push("Shell, project and check commands run without OS sandbox.");
  else if (status.active) {
    lines.push("Shell, project and check commands run in the OS sandbox.");
    if (status.backend === "restricted-token")
      lines.push("Windows: writes and credential reads are isolated; the network is not.");
  } else if (status.effectiveMode === "auto")
    lines.push("No backend: commands run without OS sandbox.");
  else lines.push("No backend: sandboxed commands are refused.");
  return lines;
}
