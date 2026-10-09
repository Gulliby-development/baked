/**
 * The terminal driver of the AI acceptance gate: the declared start command, spawned without a
 * shell in a process group the run owns, driven through its standard input and output. It is a
 * pipe, not a pseudo-terminal, so the application sees no TTY.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { killTree, PROCESS_SCOPE_ENV, scopedProcesses } from "../../platform/index.js";

/** Output kept per application; older output is dropped first. */
const MAX_OUTPUT = 1024 * 1024;

export interface TerminalExit {
  exitCode: number | null;
  signal: string | null;
}

export class TerminalApp {
  readonly scope = randomUUID();
  private child: ChildProcess | null = null;
  private output = "";
  private consumed = 0;
  private exit: TerminalExit | null = null;
  private closed: Promise<void> = Promise.resolve();
  private waiters = new Set<() => void>();
  constructor(
    private executable: string,
    private args: string[],
    private options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      onSpawn?: (pid: number, scope: string) => void;
    },
  ) {}
  get pid(): number | null {
    return this.child?.pid ?? null;
  }
  get exited(): TerminalExit | null {
    return this.exit;
  }
  /** Spawns the command; resolves once the process exists, rejects when it cannot start. */
  start(): Promise<void> {
    if (this.child) throw new Error("The application is already started");
    const child = spawn(this.executable, this.args, {
      cwd: this.options.cwd,
      env: { ...this.options.env, [PROCESS_SCOPE_ENV]: this.scope },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const collect = (chunk: Buffer): void => {
      this.output += chunk.toString("utf8");
      if (this.output.length > MAX_OUTPUT) {
        const drop = this.output.length - MAX_OUTPUT;
        this.output = this.output.slice(drop);
        this.consumed = Math.max(0, this.consumed - drop);
      }
      this.notify();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    // A write after the application closed its input is reported by `send`, not thrown here.
    child.stdin?.on("error", () => {});
    this.closed = new Promise((resolve) => {
      child.once("close", (exitCode, signal) => {
        this.exit = { exitCode, signal };
        this.notify();
        resolve();
      });
    });
    return new Promise((resolve, reject) => {
      child.once("error", (error) => {
        this.exit ??= { exitCode: null, signal: null };
        this.notify();
        reject(error);
      });
      child.once("spawn", () => {
        try {
          if (child.pid) this.options.onSpawn?.(child.pid, this.scope);
          resolve();
        } catch (error) {
          void this.stop();
          reject(error);
        }
      });
    });
  }
  private notify(): void {
    for (const waiter of this.waiters) waiter();
  }
  /** Writes text to the application's standard input. */
  send(text: string): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || this.exit) return false;
    stdin.write(text);
    return true;
  }
  /** Closes the application's standard input (end of file). */
  closeInput(): void {
    this.child?.stdin?.end();
  }
  /** Waits until the condition holds, the application exits or the time is up. */
  async waitFor(
    condition: () => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (condition()) return true;
    return new Promise((resolve) => {
      const done = (value: boolean): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
        signal?.removeEventListener("abort", aborted);
        resolve(value);
      };
      const check = (): void => {
        if (condition()) done(true);
        else if (this.exit) done(condition());
      };
      const aborted = (): void => done(false);
      const timer = setTimeout(() => done(condition()), Math.max(0, timeoutMs));
      this.waiters.add(check);
      signal?.addEventListener("abort", aborted, { once: true });
      check();
    });
  }
  /** Output since the previous read, after waiting up to `waitMs` for `until` (or any output). */
  async read(
    waitMs: number,
    until?: string,
    signal?: AbortSignal,
  ): Promise<{ output: string; exit: TerminalExit | null }> {
    const start = this.consumed;
    await this.waitFor(
      () => (until ? this.output.slice(start).includes(until) : this.output.length > start),
      waitMs,
      signal,
    );
    const output = this.output.slice(start);
    this.consumed = this.output.length;
    return { output, exit: this.exit };
  }
  /** The last lines of the whole output: what a terminal would show. */
  frame(lines: number): string {
    return lines <= 0 ? "" : this.output.split(/\r?\n/).slice(-lines).join("\n");
  }
  includes(text: string): boolean {
    return this.output.includes(text);
  }
  /** The process and the descendants the platform can link to it (Linux: the scope marker). */
  pids(): number[] {
    const own = this.child?.pid && !this.exit ? [this.child.pid] : [];
    return [...new Set([...own, ...(scopedProcesses(this.scope) ?? [])])];
  }
  /** Stops the process group and every marked descendant. */
  async stop(): Promise<TerminalExit | null> {
    const child = this.child;
    if (!child?.pid) return this.exit;
    if (!this.exit) {
      killTree(child.pid, "SIGTERM", this.scope);
      const forced = setTimeout(() => {
        killTree(child.pid ?? 0, "SIGKILL", this.scope);
        child.kill("SIGKILL");
      }, 500);
      await this.closed;
      clearTimeout(forced);
    }
    // Descendants that outlived the leader still carry the marker or the group.
    killTree(child.pid, "SIGKILL", this.scope);
    return this.exit;
  }
}

/** A TCP socket in the listening state, as the kernel reports it. */
export interface Listener {
  port: number;
  loopback: boolean;
}

/** Parses `/proc/net/tcp` or `/proc/net/tcp6` into listening sockets by inode. */
export function parseProcNetTcp(text: string, ipv6: boolean): Map<string, Listener> {
  const listeners = new Map<string, Listener>();
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const [address, port] = (fields[1] ?? "").split(":");
    // State 0A is LISTEN; field 9 is the inode.
    if (fields[3] !== "0A" || !address || !port || !fields[9]) continue;
    const loopback = ipv6
      ? address === "00000000000000000000000001000000" ||
        (address.startsWith("0000000000000000FFFF0000") && address.endsWith("7F"))
      : address.endsWith("7F");
    listeners.set(fields[9], { port: Number.parseInt(port, 16), loopback });
  }
  return listeners;
}

/**
 * The TCP sockets the given processes listen on, or null where the process table cannot be read
 * this way (every platform but Linux).
 */
export function listeningSockets(pids: readonly number[]): Listener[] | null {
  if (process.platform !== "linux") return null;
  let table: Map<string, Listener>;
  try {
    table = new Map([
      ...parseProcNetTcp(readFileSync("/proc/net/tcp", "utf8"), false),
      ...parseProcNetTcp(readFileSync("/proc/net/tcp6", "utf8"), true),
    ]);
  } catch {
    return null;
  }
  const found: Listener[] = [];
  for (const pid of pids) {
    let descriptors: string[];
    try {
      descriptors = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${descriptor}`))?.[1];
        const listener = inode ? table.get(inode) : undefined;
        if (listener) found.push(listener);
      } catch {
        // The descriptor closed meanwhile.
      }
    }
  }
  return found;
}

/** Listeners outside the grant: a port not listed, or any address other than loopback. */
export function listenerViolations(
  listeners: readonly Listener[],
  granted: readonly number[],
): string[] {
  return [
    ...new Set(
      listeners.flatMap((l) =>
        !granted.includes(l.port)
          ? [`the application listens on port ${l.port}, which is not granted`]
          : !l.loopback
            ? [`the application listens on port ${l.port} beyond loopback`]
            : [],
      ),
    ),
  ];
}
