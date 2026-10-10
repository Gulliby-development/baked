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
  platform?: NodeJS.Platform;
  onState?: (state: BackendState) => void;
}

export interface Endpoint {
  url: string;
  token: string;
}

const STDERR_LINES = 40;

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
        this.connect(stdout.slice(0, newline)).then((endpoint) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
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
        fail(new BackendError("BACKEND_EXITED", this.stderr.at(-1) ?? reason));
        this.exited(child, this.stderr.at(-1) ?? reason);
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

  private async connect(line: string): Promise<Endpoint> {
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
    return endpoint;
  }

  private exited(child: ChildLike, reason: string): void {
    if (this.child !== child) return;
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
