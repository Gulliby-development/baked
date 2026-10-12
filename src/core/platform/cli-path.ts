/**
 * Finds the CLIs BAKED drives (Codex, Claude Code) when the process PATH does not name them.
 *
 * An app started from the macOS Finder or Dock, and the `baked serve` it spawns, inherit the
 * launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), not the PATH the user's shell profile builds,
 * so Homebrew, npm, bun and installer folders are missing. A Claude Code local install may also
 * exist only as a shell alias. When a command is not on PATH this module asks the login shell
 * for its PATH once, then looks in the folders installers use, and adds the folder it finds to
 * `process.env.PATH`, so the CLI's own `#!/usr/bin/env node` and its child processes work too.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface CliResolution {
  /** What to spawn: the absolute path, or on Windows the bare name, which PATH then finds. */
  command: string;
  /** False when nothing was found; `command` is then the bare name. */
  found: boolean;
  /** Folders that were searched, for the "not found" message. */
  searched: string[];
}

/** What the resolver reads from the machine; tests pass a fake. */
export interface CliPathHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  isFile(path: string): boolean;
  listDir(path: string): string[];
  /** PATH printed by the user's login shell, or null when it cannot be read. */
  loginShellPath(): string | null;
}

const MARK = "__BAKED_PATH__";
const SHELL_TIMEOUT_MS = 5_000;

/** Runs `$SHELL -ilc` and returns the PATH its profile builds; `BAKED_LOGIN_SHELL_PATH=0` skips it. */
export function readLoginShellPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  if (platform === "win32" || env.BAKED_LOGIN_SHELL_PATH === "0") return null;
  const shell = env.SHELL?.trim() || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  try {
    const result = spawnSync(shell, ["-ilc", `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`], {
      encoding: "utf-8",
      timeout: SHELL_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      // Keeps oh-my-zsh and similar profiles from prompting for updates.
      env: { ...env, DISABLE_AUTO_UPDATE: "true", ZSH_DISABLE_COMPFIX: "true" },
    });
    return parseLoginShellPath(result.stdout ?? "");
  } catch {
    return null;
  }
}

/** The PATH between the markers; profiles may print banners around it. */
export function parseLoginShellPath(output: string): string | null {
  const start = output.indexOf(MARK);
  if (start < 0) return null;
  const end = output.indexOf(MARK, start + MARK.length);
  if (end < 0) return null;
  const path = output.slice(start + MARK.length, end).trim();
  return path || null;
}

function defaultHost(): CliPathHost {
  return {
    platform: process.platform,
    env: process.env,
    home: (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || homedir(),
    isFile: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    listDir: (path) => {
      try {
        return existsSync(path) ? readdirSync(path) : [];
      } catch {
        return [];
      }
    },
    loginShellPath: () => readLoginShellPath(process.env, process.platform),
  };
}

/** Folders installers put CLIs in, most specific first. */
export function wellKnownBinDirs(host: CliPathHost): string[] {
  const { home, env } = host;
  const { join } = pathApi(host);
  const join2 = (...parts: string[]) => join(home, ...parts);
  if (host.platform === "win32") {
    const dirs = [join2(".local", "bin"), join2(".bun", "bin")];
    if (env.APPDATA) dirs.push(join(env.APPDATA, "npm"));
    return dirs;
  }
  const dirs = [
    join2(".local", "bin"),
    join2(".claude", "local"),
    join2(".claude", "local", "node_modules", ".bin"),
    join2(".bun", "bin"),
    join2(".npm-global", "bin"),
    join2(".volta", "bin"),
    join2(".asdf", "shims"),
    join2(".local", "share", "mise", "shims"),
    join2(".local", "share", "pnpm"),
  ];
  if (env.PNPM_HOME) dirs.unshift(env.PNPM_HOME);
  if (env.BUN_INSTALL) dirs.push(join(env.BUN_INSTALL, "bin"));
  if (env.npm_config_prefix) dirs.push(join(env.npm_config_prefix, "bin"));
  if (host.platform === "darwin") dirs.push(join2("Library", "pnpm"));
  // nvm keeps one folder per Node version; prefer the newest.
  const nvm = env.NVM_DIR || join2(".nvm");
  const versions = host
    .listDir(join(nvm, "versions", "node"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) dirs.push(join(nvm, "versions", "node", version, "bin"));
  dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin");
  return dirs;
}

/** Path helpers of the host's platform, so the resolver can be tested for another OS. */
function pathApi(host: CliPathHost): typeof posix {
  return host.platform === "win32" ? win32 : posix;
}

function splitPath(host: CliPathHost, path: string | undefined): string[] {
  return (path ?? "").split(pathApi(host).delimiter).filter(Boolean);
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

function findIn(dirs: string[], name: string, host: CliPathHost): string | null {
  const exts =
    host.platform === "win32"
      ? ["", ...(host.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())]
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = pathApi(host).join(dir, name + ext);
      if (host.isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Puts `dirs` in front of the host PATH, keeping the rest in order without duplicates. */
function prependPath(host: CliPathHost, dirs: string[]): void {
  const key = pathKey(host.env);
  const merged = [...dirs, ...splitPath(host, host.env[key])];
  host.env[key] = [...new Set(merged)].join(pathApi(host).delimiter);
}

export class CliPathResolver {
  private shellPathRead = false;
  private readonly found = new Map<string, string>();

  constructor(private readonly host: CliPathHost = defaultHost()) {}

  /**
   * Where `name` lives. PATH first; then, outside Windows, the login shell PATH, which is
   * merged into the host PATH; then the installer folders. Found paths are cached, misses are
   * not, so a CLI installed while BAKED runs is picked up at the next check.
   */
  resolve(name: string): CliResolution {
    const cached = this.found.get(name);
    if (cached && this.host.isFile(cached)) return this.hit(name, cached);

    const searched: string[] = [];
    const onPath = splitPath(this.host, this.host.env[pathKey(this.host.env)]);
    searched.push(...onPath);
    const direct = findIn(onPath, name, this.host);
    if (direct) return this.hit(name, direct);

    if (this.host.platform !== "win32" && !this.shellPathRead) {
      this.shellPathRead = true;
      const shellDirs = splitPath(this.host, this.host.loginShellPath() ?? "");
      const added = shellDirs.filter((dir) => !onPath.includes(dir));
      if (added.length > 0) prependPath(this.host, shellDirs);
      const viaShell = findIn(added, name, this.host);
      searched.push(...added);
      if (viaShell) return this.hit(name, viaShell);
    }

    const extra = wellKnownBinDirs(this.host).filter((dir) => !searched.includes(dir));
    searched.push(...extra);
    const viaDirs = findIn(extra, name, this.host);
    if (viaDirs) {
      prependPath(this.host, [pathApi(this.host).dirname(viaDirs)]);
      return this.hit(name, viaDirs);
    }
    return { command: name, found: false, searched: [...new Set(searched)] };
  }

  private hit(name: string, path: string): CliResolution {
    this.found.set(name, path);
    // Windows spawns the bare name from PATH, so an npm `.cmd` shim keeps working as before.
    return { command: this.host.platform === "win32" ? name : path, found: true, searched: [] };
  }
}

let shared: CliPathResolver | null = null;

/** Resolves a CLI with the process-wide resolver. */
export function resolveCli(name: string): CliResolution {
  shared ??= new CliPathResolver();
  return shared.resolve(name);
}

/** Forgets cached locations and the login shell PATH read (tests). */
export function resetCliPathCache(): void {
  shared = null;
}

/** One line naming where a missing CLI was looked for. */
export function describeSearch(resolution: CliResolution, max = 12): string {
  const dirs = resolution.searched;
  if (dirs.length === 0) return "";
  const shown = dirs.slice(0, max).join(", ");
  return dirs.length > max ? `${shown} and ${dirs.length - max} more` : shown;
}
