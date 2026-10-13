/**
 * OS sandbox backends: detection and the pure builders of a sandboxed launch.
 *
 * Linux wraps a command in bubblewrap (`bwrap`), macOS in a `sandbox-exec` seatbelt profile and
 * Windows in BAKED's own launcher, which runs it with a low-integrity restricted token in a job
 * object (`windows-sandbox.ts`). The builders take the host (platform, home, filesystem probes) as
 * a parameter, so tests check every backend's output on any machine.
 * Mode handling (off, auto, required) lives in `src/core/security/sandbox.ts`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { findOnPath, userHome } from "./index.js";
import { encodeSpec, WINDOWS_NETWORK_GAP, windowsLauncher } from "./windows-sandbox.js";

/** Path functions of the host a profile is built for, whatever machine builds it. */
export const pathsFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

export type SandboxMode = "off" | "auto" | "required";
export type SandboxBackend = "bwrap" | "seatbelt" | "restricted-token" | "none";
/** The part of BAKED that starts the process; "auto" warns once per surface. */
export type SandboxSurface = "chat" | "workflow" | "acceptance";

/** What a caller asks for: the process is isolated to these paths and this network rule. */
export interface SandboxRequest {
  mode: "auto" | "required";
  surface: SandboxSurface;
  /** Directories the process may write, besides temp and package caches. */
  writable: string[];
  /**
   * Roots whose Git state (`config` and `hooks` of the repository, its submodules and, for a
   * worktree, its common directory) and `.baked` stay read-only even when writable. BAKED runs
   * Git unsandboxed, so a hook or `core.fsmonitor` written here would run on the host.
   */
  workspaces: string[];
  /** Also keep `<workspace>/baked` (workflow definitions) read-only. */
  protectDefinitions?: boolean;
  /**
   * A workspace that is a Git worktree may write its Git state: its gitdir and the common
   * directory (objects, refs) become writable, while their config and hooks stay protected.
   * Set by the workflow runtime for runs in a task worktree only.
   */
  gitWrite?: boolean;
  network: boolean;
}

/** What actually applied to one process; stored with check evidence. */
export interface SandboxApplied {
  backend: SandboxBackend;
  mode: "auto" | "required";
  network: boolean;
  /**
   * Why the process ran without isolation (auto mode with no usable backend), or which part of the
   * request the backend could not enforce (the network on Windows).
   */
  reason?: string;
}

export interface SandboxDetection {
  backend: SandboxBackend;
  available: boolean;
  /** Absolute path of `bwrap`, `sandbox-exec` or the Windows launcher's program, when found. */
  path: string | null;
  reason: string | null;
}

/** The machine a profile is built for. */
export interface SandboxHost {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  realpath(path: string): string;
  /** A small text file's content, or null when it cannot be read. */
  readFile(path: string): string | null;
  /** The entry names of a directory; empty when it cannot be read. */
  list(path: string): string[];
}

export function currentSandboxHost(): SandboxHost {
  return {
    platform: process.platform,
    home: userHome(),
    env: process.env,
    exists: existsSync,
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    realpath: (path) => realpathSync(path),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    list: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
  };
}

export interface SandboxProfile {
  cwd: string;
  writable: string[];
  /** Read-only inside writable directories. Files and directories are kept apart for seatbelt. */
  protectDirs: string[];
  protectFiles: string[];
  /** Package caches, writable when they exist. */
  caches: string[];
  /** Credential stores: replaced by an empty directory or file. */
  hiddenDirs: string[];
  hiddenFiles: string[];
  network: boolean;
}

const HIDDEN_DIRS = [
  ".ssh",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".kube",
  ".gnupg",
  ".config/gh",
  ".config/github-copilot",
  ".codex",
  ".claude",
  ".docker",
  ".password-store",
  ".local/share/keyrings",
  ".mozilla",
  ".config/google-chrome",
  ".config/chromium",
  ".config/BraveSoftware",
  ".config/microsoft-edge",
];
const HIDDEN_DIRS_DARWIN = [
  "Library/Keychains",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Firefox",
  "Library/Application Support/BraveSoftware",
  "Library/Cookies",
];
const HIDDEN_DIRS_WIN32 = ["AppData/Roaming/GitHub CLI"];
const HIDDEN_FILES = [
  ".netrc",
  ".npmrc",
  ".yarnrc.yml",
  ".pypirc",
  ".git-credentials",
  ".config/git/credentials",
  ".docker/config.json",
  // BAKED's own secret store; the rest of ~/.baked (installed binary, language servers) stays readable.
  ".baked/secrets.json",
  ".baked/secrets.dat",
];
const CACHES = [
  ".bun/install/cache",
  ".cache/bun",
  ".cache/go-build",
  ".cache/pip",
  ".npm",
  ".cargo/registry",
  ".cargo/git",
];
const CACHES_WIN32 = [
  "AppData/Local/npm-cache",
  "AppData/Local/pip/Cache",
  "AppData/Local/go-build",
];

/** Environment names removed from a sandboxed process: agent sockets reach keys outside it. */
export const SANDBOX_UNSET_ENV = ["SSH_AUTH_SOCK", "GPG_AGENT_INFO", "DBUS_SESSION_BUS_ADDRESS"];

function inside(host: SandboxHost, path: string, root: string): boolean {
  const { sep } = pathsFor(host.platform);
  const [p, r] =
    host.platform === "win32" ? [path.toLowerCase(), root.toLowerCase()] : [path, root];
  return p === r || p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

/** The real path, or for a missing path the real parent joined with its name. */
function canonicalPath(host: SandboxHost, path: string): string {
  const { basename, dirname, join } = pathsFor(host.platform);
  try {
    return host.realpath(path);
  } catch {
    try {
      return join(host.realpath(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

/** Existing paths, each as written and as its real path, so a dotfile symlink is covered too. */
function existingWithReal(host: SandboxHost, paths: string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (!host.exists(path)) continue;
    for (const candidate of [path, canonicalPath(host, path)])
      if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/** The repository a `.git` file (a worktree or submodule checkout) names with `gitdir:`. */
function gitFileTarget(host: SandboxHost, dotGit: string): string | null {
  const { dirname, resolve } = pathsFor(host.platform);
  const target = host.readFile(dotGit)?.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  return target ? canonicalPath(host, resolve(dirname(dotGit), target)) : null;
}

/** The common directory a worktree's gitdir names in its `commondir` file. */
function commonDirOf(host: SandboxHost, gitDir: string): string | null {
  const { join, resolve } = pathsFor(host.platform);
  const target = host.readFile(join(gitDir, "commondir"))?.trim();
  return target ? canonicalPath(host, resolve(gitDir, target)) : null;
}

const MODULE_DEPTH = 8;

/** Git directories of the submodules under `<gitDir>/modules`, nested submodules included. */
function submoduleGitDirs(host: SandboxHost, gitDir: string): string[] {
  const { join } = pathsFor(host.platform);
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MODULE_DEPTH) return;
    for (const name of host.list(dir).sort()) {
      const path = join(dir, name);
      if (!host.isDirectory(path)) continue;
      if (host.exists(join(path, "HEAD"))) {
        found.push(path);
        walk(join(path, "modules"), depth + 1);
      } else walk(path, depth + 1); // a submodule name with a slash nests directories
    }
  };
  walk(join(gitDir, "modules"), 0);
  return found;
}

/** Where a workspace keeps its Git state. */
export interface WorkspaceGit {
  /** Git directories whose `config` and `hooks` stay read-only, submodules included. */
  gitDirs: string[];
  /** Further files that stay read-only, such as the `.git` file of a worktree. */
  files: string[];
  /** The directories `gitWrite` makes writable: a worktree's gitdir and its common directory. */
  writable: string[];
}

export function workspaceGit(host: SandboxHost, root: string, gitWrite = false): WorkspaceGit {
  const { join } = pathsFor(host.platform);
  const dotGit = join(root, ".git");
  const roots: string[] = [];
  const files: string[] = [];
  const writable: string[] = [];
  if (host.exists(dotGit) && !host.isDirectory(dotGit)) {
    // Rewriting the `.git` file would point host Git at a repository the command wrote.
    files.push(dotGit);
    const gitDir = gitFileTarget(host, dotGit);
    if (gitDir) {
      roots.push(gitDir);
      const common = commonDirOf(host, gitDir);
      if (common && common !== gitDir) roots.push(common);
      if (gitWrite && host.isDirectory(gitDir)) {
        const top = common && host.isDirectory(common) ? common : gitDir;
        writable.push(top);
        if (!inside(host, gitDir, top)) writable.push(gitDir);
        // With the common directory writable, the files that send a worktree's Git elsewhere,
        // and the main checkout's HEAD and index, stay as they are.
        const worktrees = join(top, "worktrees");
        for (const name of host.list(worktrees).sort())
          for (const file of ["commondir", "gitdir", "config.worktree"])
            files.push(join(worktrees, name, file));
        if (top !== gitDir) files.push(join(top, "HEAD"), join(top, "index"));
      }
    }
  } else roots.push(dotGit);
  const gitDirs: string[] = [];
  for (const dir of roots)
    for (const each of [dir, ...submoduleGitDirs(host, dir)])
      if (!gitDirs.includes(each)) gitDirs.push(each);
  return { gitDirs, files, writable };
}

export function sandboxProfile(
  request: SandboxRequest,
  cwd: string,
  host: SandboxHost = currentSandboxHost(),
): SandboxProfile {
  const darwin = host.platform === "darwin";
  const windows = host.platform === "win32";
  const { join } = pathsFor(host.platform);
  const home = host.home;
  const writable: string[] = [];
  const addWritable = (path: string): void => {
    if (!host.exists(path)) return;
    const real = canonicalPath(host, path);
    if (!writable.includes(real)) writable.push(real);
  };
  for (const path of request.writable) addWritable(path);
  const protectDirs: string[] = [];
  const protectFiles: string[] = [];
  // Seatbelt rules hold for paths that do not exist yet; a bind mount needs an existing source.
  const protect = (list: string[], path: string): void => {
    if ((darwin || host.exists(path)) && !list.includes(path)) list.push(path);
  };
  for (const root of request.workspaces) {
    const real = canonicalPath(host, root);
    const git = workspaceGit(host, real, request.gitWrite);
    for (const dir of git.writable) addWritable(dir);
    for (const dir of git.gitDirs) protect(protectDirs, join(dir, "hooks"));
    protect(protectDirs, join(real, ".baked"));
    if (request.protectDefinitions) protect(protectDirs, join(real, "baked"));
    for (const dir of git.gitDirs) {
      protect(protectFiles, join(dir, "config"));
      if (host.exists(join(dir, "config.worktree")))
        protect(protectFiles, join(dir, "config.worktree"));
    }
    for (const file of git.files) if (host.exists(file)) protect(protectFiles, file);
  }
  const fromHome = (paths: string[]): string[] => paths.map((p) => join(home, p));
  const cacheCandidates = fromHome(CACHES);
  const goModCache = host.env.GOMODCACHE;
  cacheCandidates.push(goModCache || join(home, "go", "pkg", "mod"));
  if (darwin) cacheCandidates.push(join(home, "Library", "Caches"));
  if (windows) cacheCandidates.push(...fromHome(CACHES_WIN32));
  const caches = existingWithReal(host, cacheCandidates);
  const hiddenDirCandidates = fromHome(
    darwin
      ? [...HIDDEN_DIRS, ...HIDDEN_DIRS_DARWIN]
      : windows
        ? [...HIDDEN_DIRS, ...HIDDEN_DIRS_WIN32]
        : HIDDEN_DIRS,
  );
  const runtimeDir = host.env.XDG_RUNTIME_DIR;
  if (!darwin && !windows && runtimeDir) hiddenDirCandidates.push(runtimeDir);
  // A credential directory that holds the working directory itself is left visible.
  const hiddenDirs = existingWithReal(host, hiddenDirCandidates).filter(
    (dir) => !writable.some((w) => inside(host, w, dir)) && !inside(host, cwd, dir),
  );
  const hiddenFiles = existingWithReal(host, fromHome(HIDDEN_FILES)).filter(
    (file) => !hiddenDirs.some((dir) => inside(host, file, dir)),
  );
  return {
    cwd: canonicalPath(host, cwd),
    writable,
    protectDirs,
    protectFiles,
    caches,
    hiddenDirs,
    hiddenFiles,
    network: request.network,
  };
}

/**
 * bubblewrap argv. Later mounts win, so the order is: the host read-only, a private /tmp
 * (workspaces often live under /tmp and are bound on top of it), writable binds, read-only
 * protections inside them, then credential masks, which hold even when a workspace is $HOME.
 */
export function bwrapArgv(
  bwrap: string,
  profile: SandboxProfile,
  executable: string,
  args: string[],
): string[] {
  const argv = [bwrap, "--die-with-parent", "--unshare-pid", "--unshare-ipc"];
  if (!profile.network) argv.push("--unshare-net");
  argv.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");
  for (const path of profile.writable) argv.push("--bind", path, path);
  for (const path of profile.caches) argv.push("--bind-try", path, path);
  for (const path of [...profile.protectDirs, ...profile.protectFiles])
    argv.push("--ro-bind", path, path);
  for (const path of profile.hiddenDirs) argv.push("--tmpfs", path);
  for (const path of profile.hiddenFiles) argv.push("--ro-bind", "/dev/null", path);
  argv.push("--chdir", profile.cwd, "--", executable, ...args);
  return argv;
}

/**
 * The seatbelt profile and its `-D` parameters. Paths travel as parameters, so they need no
 * SBPL escaping. In SBPL the last matching rule wins: protections follow the writable allows.
 */
export function seatbeltProfile(profile: SandboxProfile): {
  profile: string;
  params: Record<string, string>;
} {
  const params: Record<string, string> = {};
  const param = (prefix: string, values: string[]): string[] =>
    values.map((value, index) => {
      params[`${prefix}${index}`] = value;
      return `(param "${prefix}${index}")`;
    });
  const writable = param("W", profile.writable).map((p) => `(subpath ${p})`);
  const caches = param("C", profile.caches).map((p) => `(subpath ${p})`);
  const protectDirs = param("P", profile.protectDirs).map((p) => `(subpath ${p})`);
  const protectFiles = param("Q", profile.protectFiles).map((p) => `(literal ${p})`);
  const hiddenDirs = param("H", profile.hiddenDirs).map((p) => `(subpath ${p})`);
  const hiddenFiles = param("F", profile.hiddenFiles).map((p) => `(literal ${p})`);
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${[
      ...writable,
      '(subpath "/private/tmp")',
      '(subpath "/private/var/folders")',
      '(literal "/dev/null")',
      '(literal "/dev/tty")',
      '(regex #"^/dev/fd/")',
      ...caches,
    ].join(" ")})`,
  ];
  const protect = [...protectDirs, ...protectFiles];
  if (protect.length) lines.push(`(deny file-write* ${protect.join(" ")})`);
  const hidden = [...hiddenDirs, ...hiddenFiles];
  if (hidden.length) lines.push(`(deny file-read* file-write* ${hidden.join(" ")})`);
  if (!profile.network)
    lines.push(
      // The keychain daemon reads keychain files outside the sandbox, so hiding them is not enough
      // for the `security` tool. TLS of some tools needs the daemon too: it is cut with the network.
      '(deny mach-lookup (global-name "com.apple.SecurityServer"))',
      "(deny network*)",
      // Outbound is matched on the remote end only: with a `local ip` filter on the outbound
      // rule, connections to other hosts got through on the macOS CI runner.
      '(allow network-bind network-inbound (local ip "localhost:*"))',
      '(allow network-outbound (remote ip "localhost:*") (remote unix-socket))',
    );
  return { profile: `${lines.join("\n")}\n`, params };
}

export function seatbeltArgv(
  sandboxExec: string,
  profile: SandboxProfile,
  executable: string,
  args: string[],
): string[] {
  // sandbox-exec would read a leading dash as one of its own options.
  if (executable.startsWith("-"))
    throw new Error(`Refusing to sandbox an executable named like an option: ${executable}`);
  const built = seatbeltProfile(profile);
  const argv = [sandboxExec, "-p", built.profile];
  for (const [key, value] of Object.entries(built.params)) argv.push("-D", `${key}=${value}`);
  argv.push(executable, ...args);
  return argv;
}

/**
 * The Windows launcher argv: the launcher program, then one encoded argument with the command and
 * the paths to label, so no quoting rule applies to it. `verbatim` args are a ready command line.
 */
export function restrictedTokenArgv(
  launcher: string[],
  profile: SandboxProfile,
  executable: string,
  args: string[],
  verbatim = false,
): string[] {
  const spec = encodeSpec({
    executable,
    args,
    verbatim,
    cwd: profile.cwd,
    writable: profile.writable,
    caches: profile.caches,
    protectDirs: profile.protectDirs,
    protectFiles: profile.protectFiles,
    hiddenDirs: profile.hiddenDirs,
    hiddenFiles: profile.hiddenFiles,
  });
  return [...launcher, spec];
}

/** The argv that runs `executable` inside the detected backend. */
export function sandboxArgv(
  detection: SandboxDetection,
  profile: SandboxProfile,
  executable: string,
  args: string[],
  options: { verbatim?: boolean; launcher?: string[] } = {},
): string[] {
  if (!detection.available || !detection.path) throw new Error("No sandbox backend is available");
  if (detection.backend === "restricted-token")
    return restrictedTokenArgv(
      options.launcher ?? windowsLauncher(),
      profile,
      executable,
      args,
      options.verbatim,
    );
  return detection.backend === "bwrap"
    ? bwrapArgv(detection.path, profile, executable, args)
    : seatbeltArgv(detection.path, profile, executable, args);
}

/** Why a launch on this backend is less isolated than requested, or null. */
export function sandboxGap(detection: SandboxDetection, request: SandboxRequest): string | null {
  return detection.backend === "restricted-token" && !request.network ? WINDOWS_NETWORK_GAP : null;
}

export interface SandboxProbeDeps {
  platform: NodeJS.Platform;
  /** The Windows launcher's program and leading arguments; defaults to `windowsLauncher()`. */
  launcher?: string[];
  find(bin: string): string | null;
  exists(path: string): boolean;
  run(command: string, args: string[]): { status: number | null; stderr: string; error?: string };
}

function defaultProbeDeps(): SandboxProbeDeps {
  return {
    platform: process.platform,
    find: findOnPath,
    exists: existsSync,
    run: (command, args) => {
      const result = spawnSync(command, args, {
        // The Windows probe starts Bun with the launcher, which can take seconds on a cold disk.
        timeout: process.platform === "win32" ? 15_000 : 2000,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      return {
        status: result.status,
        stderr: typeof result.stderr === "string" ? result.stderr : "",
        ...(result.error ? { error: result.error.message } : {}),
      };
    },
  };
}

/** A short reason for a failed bwrap probe. */
export function bwrapFailureReason(stderr: string, error?: string): string {
  const text = `${stderr}\n${error ?? ""}`;
  if (
    /user namespace|Operation not permitted|setting up uid map|No permissions to create/i.test(text)
  )
    return "user namespaces are blocked (container or AppArmor)";
  const line = text.split("\n").find((l) => l.trim());
  return line ? `bwrap does not start: ${line.trim()}` : "bwrap does not start";
}

/**
 * Finds the backend and proves it starts: a binary on PATH is not enough, since containers and
 * Ubuntu's AppArmor user namespace restriction stop bwrap.
 */
export function probeSandbox(deps: SandboxProbeDeps = defaultProbeDeps()): SandboxDetection {
  if (deps.platform === "linux") {
    const path = deps.find("bwrap");
    if (!path)
      return {
        backend: "bwrap",
        available: false,
        path: null,
        reason: "bwrap is not installed (apt install bubblewrap)",
      };
    const result = deps.run(path, [
      "--ro-bind",
      "/",
      "/",
      "--unshare-net",
      "--die-with-parent",
      "true",
    ]);
    if (result.status === 0) return { backend: "bwrap", available: true, path, reason: null };
    return {
      backend: "bwrap",
      available: false,
      path,
      reason: bwrapFailureReason(result.stderr, result.error),
    };
  }
  if (deps.platform === "darwin") {
    const path = "/usr/bin/sandbox-exec";
    if (!deps.exists(path))
      return { backend: "seatbelt", available: false, path: null, reason: `${path} is missing` };
    const result = deps.run(path, ["-p", "(version 1)(allow default)", "/usr/bin/true"]);
    if (result.status === 0) return { backend: "seatbelt", available: true, path, reason: null };
    const line = `${result.stderr}\n${result.error ?? ""}`.split("\n").find((l) => l.trim());
    return {
      backend: "seatbelt",
      available: false,
      path,
      reason: line ? `sandbox-exec does not start: ${line.trim()}` : "sandbox-exec does not start",
    };
  }
  if (deps.platform === "win32") {
    const launcher = deps.launcher ?? windowsLauncher();
    const [program, ...lead] = launcher;
    if (!program)
      return { backend: "restricted-token", available: false, path: null, reason: "no launcher" };
    const spec = encodeSpec({
      executable: "cmd.exe",
      args: ["/d", "/c", "exit 0"],
      verbatim: false,
      cwd: process.env.SystemRoot ?? "C:\\Windows",
      writable: [],
      caches: [],
      protectDirs: [],
      protectFiles: [],
      hiddenDirs: [],
      hiddenFiles: [],
    });
    const result = deps.run(program, [...lead, spec]);
    if (result.status === 0)
      return { backend: "restricted-token", available: true, path: program, reason: null };
    const line = `${result.stderr}\n${result.error ?? ""}`.split("\n").find((l) => l.trim());
    return {
      backend: "restricted-token",
      available: false,
      path: program,
      reason: line
        ? `the sandbox launcher does not start: ${line.trim()}`
        : `the sandbox launcher does not start (${
            result.status === null ? "no exit status: timed out or killed" : `exit ${result.status}`
          })`,
    };
  }
  return {
    backend: "none",
    available: false,
    path: null,
    reason: `no OS sandbox backend for ${deps.platform}`,
  };
}

let detected: SandboxDetection | undefined;

/** The backend of this machine, probed once per process. */
export function detectSandbox(): SandboxDetection {
  detected ??= probeSandbox();
  return detected;
}
