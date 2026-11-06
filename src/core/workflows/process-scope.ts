import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { killTree, PROCESS_SCOPE_ENV } from "../platform/index.js";
import {
  type SandboxApplied,
  type SandboxRequest,
  sandboxEnv,
  sandboxLaunch,
} from "../security/sandbox.js";
import { OUTPUT_HELD_NOTE, onOutputHeld } from "../spawn.js";
import { executionClock, executionTimeout } from "./execution-clock.js";

function stopTree(child: ChildProcess, scope: string, force = false): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    killTree(child.pid, force ? "SIGKILL" : "SIGTERM", scope);
    return;
  }
  const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
    windowsHide: true,
    stdio: "ignore",
  });
  killer.once("error", () => child.kill("SIGKILL"));
  killer.once("close", () => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  output: string;
  stdout?: string;
  stderr?: string;
  /**
   * The bytes of both pipes as they arrived (`output` before its note) and in stream order, the
   * stderr block then the stdout block (#2859). The order two pipes arrive in is not fixed, so a
   * comparison of two runs reads `inStreamOrder`, never `output`.
   */
  streams?: { arrival: string; ordered: string };
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
  /** The OS sandbox that applied; absent when the caller asked for none. */
  sandbox?: SandboxApplied;
}
/**
 * `text`, which holds a process's output as its pipes arrived, with that output in stream order:
 * the stderr block, then the stdout block (#2859). A check's notes and reports around it stay as
 * they are. The order two pipes arrive in is not fixed (a Biome stand-in's stderr came after its
 * stdout 1 time in 200), so a signature that compares two runs of a command reads this, while the
 * recorded `output` keeps the arrival order for people. Without `streams` (a scripted process) or
 * when the output is not in `text`, `text` is returned.
 */
export function inStreamOrder(text: string, streams: ProcessResult["streams"]): string {
  if (!streams || streams.arrival === streams.ordered) return text;
  const arrival = streams.arrival.replace(/\n*$/, "");
  const at = arrival ? text.indexOf(arrival) : -1;
  if (at < 0) return text;
  return text.slice(0, at) + streams.ordered.replace(/\n*$/, "") + text.slice(at + arrival.length);
}

/** A Windows batch script: Bun and Node refuse to spawn it directly (EINVAL) and it needs cmd.exe. */
export const isWindowsBatch = (executable: string): boolean => /\.(cmd|bat)$/i.test(executable);

/**
 * The program a Windows launch names (#2432): a bare batch name (`sbt.bat`, `npm.cmd`, no
 * directory) is looked up on `path` from `cwd` and named by its absolute path. cmd.exe expands
 * `%~dp0` of a script started as a quoted bare name to the working directory, so R77's `sbt.bat`
 * looked for `<worktree>\bin\sbt-launch.jar`. A name with a directory, one not found, and a name
 * without `.bat`/`.cmd` (which Bun resolves itself) are kept.
 */
export function windowsProgram(
  executable: string,
  path: string,
  cwd: string,
  which: (bin: string, options: { PATH: string; cwd: string }) => string | null = Bun.which,
): string {
  if (!isWindowsBatch(executable) || /[\\/]/.test(executable) || /^[a-z]:/i.test(executable))
    return executable;
  return which(executable, { PATH: path, cwd }) ?? executable;
}

/**
 * The cmd.exe invocation of a batch script: `cmd.exe /d /s /c "<quoted command line>"`, passed
 * verbatim. Every word is double-quoted, so `& | < > ^ ( )` stay literal. A character that cmd.exe
 * expands or ends a line on even inside quotes (`%`, `"`, a line break, is refused instead of
 * escaped, which keeps an argument from becoming a second command.
 */
export function windowsBatchInvocation(
  executable: string,
  args: string[],
  comspec: string = process.env.ComSpec || "cmd.exe",
): { executable: string; args: string[] } {
  for (const word of [executable, ...args])
    if (/["%\r\n]/.test(word) || word.endsWith("\\"))
      throw new Error(
        `Refusing to run ${executable} through cmd.exe: the argument ${JSON.stringify(word)} contains a quote, percent sign, line break or trailing backslash.`,
      );
  const line = [executable, ...args].map((word) => `"${word}"`).join(" ");
  return { executable: comspec, args: ["/d", "/s", "/c", `"${line}"`] };
}

/** How long `execute` waits for a killed command to exit before it returns without it (#2858). */
export const KILL_EXIT_GRACE_MS = 2000;

/** The note a command's result carries when it was killed and the OS never reported its exit. */
export const KILLED_NO_EXIT_NOTE =
  "[baked] The command was killed but did not report its exit; its result is returned without waiting for it.";

export class ProcessScope {
  private children = new Map<ChildProcess, string>();
  async execute(
    executable: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
      signal: AbortSignal;
      /** Receives the PID and the scope marker its descendants inherit. */
      onSpawn?: (pid: number, scope: string) => void;
      /** The args are a `bunShellArgs` command line, passed to cmd.exe unescaped on Windows. */
      verbatim?: boolean;
      /**
       * OS sandbox for this process; null runs it unsandboxed. Required so every caller decides.
       * "required" with no backend throws SandboxUnavailableError before anything starts.
       */
      sandbox: SandboxRequest | null;
      /** Written to standard input, which is then closed; without it standard input is ignored. */
      stdin?: string;
    },
  ): Promise<ProcessResult> {
    options.signal.throwIfAborted();
    const started = executionClock.now();
    const scope = randomUUID();
    const batch = process.platform === "win32" && !options.verbatim && isWindowsBatch(executable);
    const program = batch
      ? windowsProgram(executable, options.env.PATH ?? options.env.Path ?? "", options.cwd)
      : executable;
    const direct = batch ? windowsBatchInvocation(program, args) : { executable, args };
    // Wrapping follows the batch rewrite; the Windows launcher joins a verbatim line unquoted.
    const verbatim = (options.verbatim === true || batch) && process.platform === "win32";
    const launch = options.sandbox
      ? sandboxLaunch(
          direct.executable,
          direct.args,
          options.sandbox,
          options.cwd,
          undefined,
          undefined,
          {
            verbatim,
          },
        )
      : null;
    const wrapped = launch !== null && launch.applied.backend !== "none";
    const env = launch ? sandboxEnv(options.env, launch) : options.env;
    return new Promise((resolve, reject) => {
      const child = spawn(launch?.executable ?? direct.executable, launch?.args ?? direct.args, {
        cwd: options.cwd,
        env: { ...env, [PROCESS_SCOPE_ENV]: scope },
        shell: false,
        windowsHide: true,
        // The launcher's own argument is one base64 word; only an unwrapped line goes verbatim.
        windowsVerbatimArguments: verbatim && !wrapped,
        detached: process.platform !== "win32",
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      this.children.set(child, scope);
      if (options.stdin !== undefined && child.stdin) {
        // A program that exits without reading its input closes the pipe; that is not an error.
        child.stdin.on("error", () => {});
        child.stdin.end(options.stdin);
      }
      let output = Buffer.alloc(0);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      let cancelled = false;
      let truncated = false;
      let hardKill: ReturnType<typeof setTimeout> | undefined;
      let abandon: ReturnType<typeof setTimeout> | undefined;
      let cancelOutputHeld: (() => void) | undefined;
      const stop = (): void => {
        stopTree(child, scope);
        hardKill ??= setTimeout(() => {
          stopTree(child, scope, true);
          child.kill("SIGKILL");
          // A killed command whose exit the OS does not report (a process held in exec by a
          // policy scan, a lost event) still settles, so a timeout bounds the wait (#2858).
          abandon ??= setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(null, "SIGKILL", `\n${KILLED_NO_EXIT_NOTE}`);
          }, KILL_EXIT_GRACE_MS);
        }, 500);
      };
      const abort = (): void => {
        cancelled = true;
        stop();
      };
      const timer =
        options.timeoutMs > 0
          ? executionTimeout(() => {
              timedOut = true;
              stop();
            }, options.timeoutMs)
          : undefined;
      const collect = (chunk: Buffer, stream: Buffer[]): void => {
        const left = 10 * 1024 * 1024 - output.length;
        if (chunk.length > left) truncated = true;
        if (left > 0) {
          const bounded = chunk.subarray(0, left);
          output = Buffer.concat([output, bounded]);
          stream.push(bounded);
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => collect(chunk, stdout));
      child.stderr?.on("data", (chunk: Buffer) => collect(chunk, stderr));
      options.signal.addEventListener("abort", abort, { once: true });
      child.once("spawn", () => {
        try {
          if (child.pid) options.onSpawn?.(child.pid, scope);
        } catch (error) {
          stop();
          reject(error);
        }
      });
      const cleanup = (): void => {
        timer?.();
        if (hardKill) clearTimeout(hardKill);
        if (abandon) clearTimeout(abandon);
        cancelOutputHeld?.();
        this.children.delete(child);
        options.signal.removeEventListener("abort", abort);
      };
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      let settled = false;
      const finish = (exitCode: number | null, signal: string | null, note = ""): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          exitCode,
          signal,
          output: output.toString("utf8") + note,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          streams: {
            arrival: output.toString("utf8"),
            ordered: Buffer.concat([...stderr, ...stdout]).toString("utf8"),
          },
          timedOut,
          cancelled,
          truncated,
          durationMs: Math.ceil(executionClock.now() - started),
          ...(launch ? { sandbox: launch.applied } : {}),
        });
      };
      cancelOutputHeld = onOutputHeld(child, (exitCode, signal) => {
        // Stops what the command left running where the platform can find it.
        stopTree(child, scope, true);
        finish(exitCode, signal, `\n${OUTPUT_HELD_NOTE}`);
      });
      child.once("close", (exitCode, signal) => finish(exitCode, signal));
    });
  }
  async stop(): Promise<void> {
    await Promise.all(
      [...this.children].map(
        ([child, scope]) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            const timer = setTimeout(() => {
              stopTree(child, scope, true);
              child.kill("SIGKILL");
            }, 500);
            child.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
            stopTree(child, scope);
          }),
      ),
    );
  }
}
