import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import type { BackendState, Health } from "../shared/api.js";
import type { BackendCommand } from "./backend-command.js";

/** The part of a child process the backend uses; tests pass a fake. */
export interface ChildLike {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export type Spawner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildLike;

export interface BackendOptions {
  folder: string;
  command: BackendCommand;
  tokenFile: string;
  spawn?: Spawner;
  fetch?: typeof fetch;
  readToken?: (path: string) => string;
  /** Delays between restarts after unexpected exits; the last one repeats until exhausted. */
  restartDelaysMs?: number[];
  /** A backend that ran this long has its restart count reset. */
  stableAfterMs?: number;
  readyTimeoutMs?: number;
  stopGraceMs?: number;
  /** How often a running backend's health is checked for a stopped thread (#1541). */
  stallPollMs?: number;
  platform?: NodeJS.Platform;
  onState?: (state: BackendState) => void;
}

export interface Endpoint {
  url: string;
  token: string;
}

const STDERR_LINES = 40;
/** Longest wait for the last stderr output after `baked serve` exits. */
const STDERR_DRAIN_MS = 500;

export class BackendError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One `baked serve --cwd <folder>` process: starts it, waits for its ready line and a healthy
 * `/v1/health`, restarts it with backoff when it exits unexpectedly, and stops it.
 *
 * `baked serve` drives runs on its main thread. When that thread stops (a synchronous call that
 * never returns, #1541), every protection of the runs stops with it, and so does the API. A running
 * backend that leaves its health unanswered for the server's `supervisorGraceMs` is stopped and
 * restarted with `--take-over PID`, so the new server takes its runs over and drives them again.
 */
export class Backend {
  private child: ChildLike | null = null;
  private endpoint: Endpoint | null = null;
  private ready: Promise<Endpoint> | null = null;
  private stopping = false;
  private restarts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelRestart: ((error: Error) => void) | null = null;
  private startedAt = 0;
  private stderr: string[] = [];
  private current: BackendState = { kind: "stopped" };
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  /** The stopped server whose runs the next one takes over, and the one stopped for not answering. */
  private takeOver: number | null = null;
  private stalled: { child: ChildLike; reason: string } | null = null;

  constructor(private readonly options: BackendOptions) {}

  get state(): BackendState {
    return this.current;
  }

  /** Starts the backend if needed and resolves once it answers. */
  async endpointOrStart(): Promise<Endpoint> {
    if (this.endpoint) return this.endpoint;
    if (this.current.kind === "failed")
      throw new BackendError("BACKEND_FAILED", this.current.lastError);
    // While a restart is scheduled, `ready` is that restart: callers wait out the backoff.
    this.ready ??= this.launch();
    return this.ready;
  }

  start(): Promise<Endpoint> {
    this.stopping = false;
    if (this.current.kind === "failed") {
      this.restarts = 0;
      this.setState({ kind: "stopped" });
    }
    return this.endpointOrStart();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.unwatch();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.cancelRestart?.(new BackendError("BACKEND_STOPPED", "The backend was stopped"));
    this.cancelRestart = null;
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    this.ready = null;
    if (child) await this.terminate(child);
    this.setState({ kind: "stopped" });
  }

  async restart(): Promise<Endpoint> {
    await this.stop();
    this.restarts = 0;
    return this.start();
  }

  private setState(state: BackendState): void {
    this.current = state;
    this.options.onState?.(state);
  }

  private launch(): Promise<Endpoint> {
    const { folder, command, tokenFile } = this.options;
    const spawn = this.options.spawn ?? defaultSpawn;
    const args = [
      ...command.prefix,
      "serve",
      "--cwd",
      folder,
      "--port",
      "0",
      "--token-file",
      tokenFile,
      ...(this.takeOver !== null ? ["--take-over", String(this.takeOver)] : []),
    ];
    this.stderr = [];
    const child = spawn(command.command, args, { cwd: folder, env: { ...process.env } });
    this.child = child;
    this.startedAt = Date.now();

    const ready = new Promise<Endpoint>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new BackendError("BACKEND_TIMEOUT", "baked serve did not report ready")),
        this.options.readyTimeoutMs ?? 30_000,
      );
      let stdout = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (settled) return;
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline === -1) return;
        this.connect(stdout.slice(0, newline)).then(({ endpoint, graceMs }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // The new server took the stopped one's runs over.
          this.takeOver = null;
          this.watch(child, endpoint, graceMs);
          resolve(endpoint);
        }, fail);
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) if (line) this.stderr.push(line);
        if (this.stderr.length > STDERR_LINES)
          this.stderr.splice(0, this.stderr.length - STDERR_LINES);
      });
      child.once("error", (error) => {
        fail(new BackendError("BACKEND_SPAWN", error.message));
        // A process that never started emits no exit event.
        if (child.pid === undefined) this.exited(child, error.message);
      });
      child.once("exit", (code, signal) => {
        const reason = `baked serve exited (${signal ?? `code ${code}`})`;
        const report = (): void => {
          fail(new BackendError("BACKEND_EXITED", this.stderr.at(-1) ?? reason));
          this.exited(child, this.stderr.at(-1) ?? reason);
        };
        // The exit event can come before the last stderr chunk; the error names that line, so
        // wait for the stream to end, but not for a grandchild that keeps it open.
        const stream = child.stderr;
        if (!stream || stream.readableEnded || stream.destroyed) return report();
        let reported = false;
        const once = (): void => {
          if (reported) return;
          reported = true;
          clearTimeout(drain);
          report();
        };
        const drain = setTimeout(once, STDERR_DRAIN_MS);
        stream.once("end", once);
        stream.once("close", once);
      });
    });

    this.ready = ready.then(
      (endpoint) => {
        this.endpoint = endpoint;
        return endpoint;
      },
      (error: unknown) => {
        // The exit handler schedules the restart; a process that is up but unusable is stopped first.
        const exited =
          error instanceof BackendError &&
          (error.code === "BACKEND_EXITED" || error.code === "BACKEND_SPAWN");
        if (this.child === child && !exited) void this.terminate(child);
        throw error;
      },
    );
    // State listeners run only now: one that asks for the endpoint gets this attempt, not a new one.
    if (this.current.kind !== "restarting") this.setState({ kind: "starting" });
    return this.ready;
  }

  private async connect(line: string): Promise<{ endpoint: Endpoint; graceMs: number }> {
    let ready: { url?: unknown; tokenFile?: unknown };
    try {
      ready = JSON.parse(line) as { url?: unknown; tokenFile?: unknown };
    } catch {
      throw new BackendError("BACKEND_PROTOCOL", `Unexpected output from baked serve: ${line}`);
    }
    if (typeof ready.url !== "string" || typeof ready.tokenFile !== "string")
      throw new BackendError("BACKEND_PROTOCOL", `Unexpected output from baked serve: ${line}`);
    const readToken = this.options.readToken ?? ((path: string) => readFileSync(path, "utf8"));
    const endpoint = { url: ready.url, token: readToken(ready.tokenFile).trim() };
    const response = await (this.options.fetch ?? fetch)(`${endpoint.url}/v1/health`, {
      headers: { Authorization: `Bearer ${endpoint.token}` },
    });
    if (!response.ok)
      throw new BackendError("BACKEND_UNHEALTHY", `Health check returned ${response.status}`);
    const health = (await response.json()) as Health;
    this.setState({ kind: "running", version: health.version });
    // An older server reports no grace period and is not watched.
    return { endpoint, graceMs: health.supervisorGraceMs ?? 0 };
  }

  /**
   * Checks the health of a running server every poll. Any answer counts: the thread runs. A gap
   * of several polls in this process's own timers means the host slept, and the wait starts over.
   */
  private watch(child: ChildLike, endpoint: Endpoint, graceMs: number): void {
    this.unwatch();
    if (!(graceMs > 0)) return;
    const pollMs = this.options.stallPollMs ?? 5000;
    let answered = performance.now();
    let last = answered;
    let checking = false;
    const timer = setInterval(() => {
      if (this.child !== child) {
        clearInterval(timer);
        return;
      }
      const now = performance.now();
      if (now - last > pollMs * 3) answered = now;
      last = now;
      if (now - answered >= graceMs) {
        clearInterval(timer);
        if (this.watchTimer === timer) this.watchTimer = null;
        this.stopStalled(child, graceMs);
        return;
      }
      if (checking) return;
      checking = true;
      (this.options.fetch ?? fetch)(`${endpoint.url}/v1/health`, {
        headers: { Authorization: `Bearer ${endpoint.token}` },
        signal: AbortSignal.timeout(pollMs),
      })
        .then(
          () => {
            answered = performance.now();
          },
          () => undefined,
        )
        .finally(() => {
          checking = false;
        });
    }, pollMs);
    timer.unref?.();
    this.watchTimer = timer;
  }

  private unwatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  /** Kills a server that stopped answering; the exit handler restarts it with `--take-over`. */
  private stopStalled(child: ChildLike, graceMs: number): void {
    if (child.pid === undefined) return;
    this.takeOver = child.pid;
    this.stalled = {
      child,
      reason: `baked serve stopped answering for ${Math.round(graceMs / 1000)} s and was restarted`,
    };
    // A stopped thread does not handle SIGTERM; taskkill /T also ends the commands it started.
    if ((this.options.platform ?? process.platform) === "win32")
      nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGKILL");
  }

  private exited(child: ChildLike, exitReason: string): void {
    if (this.child !== child) return;
    const reason = this.stalled?.child === child ? this.stalled.reason : exitReason;
    this.stalled = null;
    this.child = null;
    this.endpoint = null;
    this.ready = null;
    if (this.stopping) return;
    if (Date.now() - this.startedAt >= (this.options.stableAfterMs ?? 60_000)) this.restarts = 0;
    const delays = this.options.restartDelaysMs ?? [1000, 2000, 4000, 8000, 16000];
    if (this.restarts >= delays.length) {
      this.setState({ kind: "failed", lastError: reason, stderr: [...this.stderr] });
      return;
    }
    const delay = delays[this.restarts] ?? 30_000;
    this.restarts += 1;
    const restart = new Promise<Endpoint>((resolve, reject) => {
      this.cancelRestart = reject;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.cancelRestart = null;
        this.launch().then(resolve, reject);
      }, delay);
    });
    restart.catch(() => {
      // The exit handler reports the failure and decides about the next attempt.
    });
    this.ready = restart;
    this.setState({ kind: "restarting", attempt: this.restarts, lastError: reason });
  }

  private terminate(child: ChildLike): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", finish);
      const platform = this.options.platform ?? process.platform;
      // Windows has no SIGTERM; taskkill /T also ends the Bun child of a source checkout.
      if (platform === "win32" && child.pid !== undefined)
        nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGTERM");
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish();
      }, this.options.stopGraceMs ?? 5000);
    });
  }
}

const defaultSpawn: Spawner = (command, args, options) =>
  nodeSpawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
