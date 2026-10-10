import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { killTree, PROCESS_SCOPE_ENV } from "../platform/index.js";

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
    },
  ): Promise<ProcessResult> {
    options.signal.throwIfAborted();
    const started = performance.now();
    const scope = randomUUID();
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: options.cwd,
        env: { ...options.env, [PROCESS_SCOPE_ENV]: scope },
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: options.verbatim === true && process.platform === "win32",
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.children.set(child, scope);
      let output = Buffer.alloc(0);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      let cancelled = false;
      let truncated = false;
      let hardKill: ReturnType<typeof setTimeout> | undefined;
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
          ? setTimeout(() => {
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
        if (timer) clearTimeout(timer);
        if (hardKill) clearTimeout(hardKill);
        this.children.delete(child);
        options.signal.removeEventListener("abort", abort);
      };
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        cleanup();
        resolve({
          exitCode,
          signal,
          output: output.toString("utf8"),
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timedOut,
          cancelled,
          truncated,
          durationMs: Math.ceil(performance.now() - started),
        });
      });
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
