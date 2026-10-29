import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { killTree, PROCESS_SCOPE_ENV } from "../platform/index.js";
import {
  type SandboxApplied,
  type SandboxRequest,
  sandboxEnv,
  sandboxLaunch,
} from "../security/sandbox.js";
import { OUTPUT_GRACE_MS } from "../spawn.js";
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
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
  /** The OS sandbox that applied; absent when the caller asked for none. */
  sandbox?: SandboxApplied;
}
/** A Windows batch script: Bun and Node refuse to spawn it directly (EINVAL) and it needs cmd.exe. */
export const isWindowsBatch = (executable: string): boolean => /\.(cmd|bat)$/i.test(executable);

/**
 * The program a Windows launch names: a bare command (`sbt.bat`, `gradle`, no directory) is looked
 * up on `path` from `cwd`, and the batch script it finds is named by its absolute path. cmd.exe
 * sets a script's `%~dp0` from the name it was given, so a script started by bare name through
 * `cmd /c "sbt.bat"` reads its own directory as the working directory: R77's sbt.bat looked for
 * `<worktree>\bin\sbt-launch.jar`. A name with a directory, or one not found, is kept.
 */
export function windowsProgram(
  executable: string,
  path: string,
  cwd: string,
  which: (bin: string, options: { PATH: string; cwd: string }) => string | null = Bun.which,
): string {
  if (/[\\/]/.test(executable) || /^[a-z]:/i.test(executable)) return executable;
  const found = which(executable, { PATH: path, cwd });
  return found && isWindowsBatch(found) ? found : executable;
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
    const program =
      process.platform === "win32" && !options.verbatim
        ? windowsProgram(executable, options.env.PATH ?? options.env.Path ?? "", options.cwd)
        : executable;
    const batch = process.platform === "win32" && !options.verbatim && isWindowsBatch(program);
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
      let outputGrace: ReturnType<typeof setTimeout> | undefined;
      const stop = (): void => {
        stopTree(child, scope);
        hardKill ??= setTimeout(() => {
          stopTree(child, scope, true);
          child.kill("SIGKILL");
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
        if (outputGrace) clearTimeout(outputGrace);
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
          timedOut,
          cancelled,
          truncated,
          durationMs: Math.ceil(executionClock.now() - started),
          ...(launch ? { sandbox: launch.applied } : {}),
        });
      };
      child.once("exit", (exitCode, signal) => {
        outputGrace = setTimeout(() => {
          // Stops what the command left running where the platform can find it, then stops reading.
          stopTree(child, scope, true);
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(
            exitCode,
            signal,
            "\n[baked] The command exited, but a process it started kept its output open; later output is not captured.",
          );
        }, OUTPUT_GRACE_MS);
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
