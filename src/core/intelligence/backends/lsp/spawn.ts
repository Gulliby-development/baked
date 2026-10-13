import { type ChildProcess, spawn } from "node:child_process";
import { extname, isAbsolute } from "node:path";
import { findOnPath, IS_WIN, killTree } from "../../../platform/index.js";
import { isWindowsBatch, windowsBatchInvocation } from "../../../workflows/process-scope.js";

export interface LspLaunch {
  executable: string;
  args: string[];
  /** The args are a cmd.exe command line and go to the process unescaped. */
  verbatim: boolean;
}

/**
 * How a server command is spawned. Windows refuses to spawn a `.cmd` or `.bat` file directly
 * (EINVAL), and `baked lsp install` writes `.cmd` shims for Mason generic and pypi packages (jdtls),
 * as npm does for node servers: a batch script runs through cmd.exe instead. A bare command name
 * is looked up on the PATH first, since a `.cmd` found there has the same problem.
 */
export function lspLaunch(
  command: string,
  args: string[],
  options: {
    windows?: boolean;
    which?: (bin: string) => string | null;
    comspec?: string;
  } = {},
): LspLaunch {
  const windows = options.windows ?? IS_WIN;
  if (!windows) return { executable: command, args, verbatim: false };
  const bare = !isAbsolute(command) && !/[\\/]/.test(command) && extname(command) === "";
  const resolved = bare ? ((options.which ?? findOnPath)(command) ?? command) : command;
  if (!isWindowsBatch(resolved)) return { executable: command, args, verbatim: false };
  return { ...windowsBatchInvocation(resolved, args, options.comspec), verbatim: true };
}

/** Spawns a language server with piped stdio, as the client and the install check both do. */
export function spawnLspServer(command: string, args: string[], cwd: string): ChildProcess {
  const launch = lspLaunch(command, args);
  // On POSIX, spawn detached so the child becomes its own process group leader.
  // This lets us kill the entire process tree via negative PID, which is critical
  // for LSP wrappers (e.g. biome's Mason shim) that use spawnSync to launch
  // a native binary grandchild — without this, SIGTERM only hits the wrapper
  // and the grandchild becomes an orphan.
  return spawn(launch.executable, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    // On Windows a detached child has no console, so console grandchildren
    // (e.g. node behind the biome.exe shim) open visible windows. Tree kill
    // there goes through taskkill, so the process group is not needed.
    detached: !IS_WIN,
    windowsHide: true,
    windowsVerbatimArguments: launch.verbatim,
  });
}

/**
 * Starts a server and reports why it could not run: a spawn error, or an exit within `waitMs`.
 * Null when it is still running after `waitMs` (it is then stopped). The server is not sent an
 * initialize request; this only catches a server that cannot start at all.
 */
export function probeLspServer(
  command: string,
  args: string[],
  cwd: string,
  waitMs = 3000,
): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnLspServer(command, args, cwd);
    } catch (error) {
      resolve(error instanceof Error ? error.message : String(error));
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-400);
    });
    child.stdout?.resume();
    let settled = false;
    const finish = (result: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (child.pid) killTree(child.pid);
      else child.kill();
      finish(null);
    }, waitMs);
    child.once("error", (error) => finish(error.message));
    child.once("exit", (code, signal) => {
      const detail = stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).slice(-3).join(" ")}` : "";
      finish(`exited with ${code !== null ? `code ${code}` : `signal ${signal}`}${detail}`);
    });
  });
}
