/**
 * The terminal driver of the AI acceptance gate: the declared start command, spawned without a
 * shell in a process group the run owns, driven through its standard input and output. It is a
 * pipe, not a pseudo-terminal, so the application sees no TTY.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
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

/** Where the socket table cannot be read, the port rule is reported as not enforced. */
export const PORTS_UNCHECKED =
  "listenPorts could not be enforced: the listening sockets cannot be read on this system";

/**
 * The TCP sockets the given processes and their descendants listen on, or null where the socket
 * table cannot be read. Linux reads `/proc`; macOS asks `ps` and `lsof`; Windows asks PowerShell
 * for the process table and `Get-NetTCPConnection`. Descendants are found by parent PID and, on
 * POSIX, by process group; on Linux the caller also passes processes carrying the scope marker.
 */
export async function listeningSockets(pids: readonly number[]): Promise<Listener[] | null> {
  if (process.platform === "linux") return linuxListeners(pids);
  if (process.platform === "darwin") return darwinListeners(pids);
  if (process.platform === "win32") return windowsListeners(pids);
  return null;
}

/** The process table from `/proc/<pid>/stat`: parent and process group. */
function linuxProcessTable(): ProcessRow[] {
  const rows: ProcessRow[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return rows;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      // The command name in parentheses may hold spaces; the fields after it are fixed.
      const [, parent, group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      rows.push({ pid: Number(entry), parent: Number(parent), group: Number(group) });
    } catch {
      // Exited meanwhile.
    }
  }
  return rows;
}

function linuxListeners(roots: readonly number[]): Listener[] | null {
  const pids = processFamily(roots, linuxProcessTable());
  // A kernel without IPv6 has no tcp6 table; without either the sockets cannot be read.
  const tables = [
    ["/proc/net/tcp", false],
    ["/proc/net/tcp6", true],
  ] as const;
  const table = new Map<string, Listener>();
  let read = false;
  for (const [path, ipv6] of tables) {
    try {
      for (const entry of parseProcNetTcp(readFileSync(path, "utf8"), ipv6)) table.set(...entry);
      read = true;
    } catch {
      // Missing table.
    }
  }
  if (!read) return null;
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

interface CommandResult {
  code: number | null;
  stdout: string;
}

/** Runs a command without a shell; null when it cannot start or times out. */
function capture(file: string, args: string[]): Promise<CommandResult | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (!error) return resolve({ code: 0, stdout });
        const code = (error as { code?: unknown }).code;
        resolve(typeof code === "number" && !error.killed ? { code, stdout } : null);
      },
    );
  });
}

/** A row of the process table: who started whom, and when (Windows) or in which group (POSIX). */
export interface ProcessRow {
  pid: number;
  parent: number;
  /** POSIX process group. */
  group?: number;
  /** Windows creation time, to skip a child of an earlier process whose PID was reused. */
  started?: number;
}

/** The roots, their descendants and (POSIX) members of their process groups. */
export function processFamily(roots: readonly number[], table: readonly ProcessRow[]): Set<number> {
  const family = new Set(roots);
  const byPid = new Map(table.map((row) => [row.pid, row]));
  for (const row of table)
    if (row.group !== undefined && family.has(row.group)) family.add(row.pid);
  let grown = true;
  while (grown) {
    grown = false;
    for (const row of table) {
      if (family.has(row.pid) || !family.has(row.parent) || row.pid === row.parent) continue;
      const parent = byPid.get(row.parent);
      if (
        row.started !== undefined &&
        parent?.started !== undefined &&
        row.started < parent.started
      )
        continue;
      family.add(row.pid);
      grown = true;
    }
  }
  return family;
}

/** Whether a socket address only accepts local connections. */
export function isLoopbackAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    bare === "::1" ||
    bare === "localhost" ||
    bare.startsWith("127.") ||
    bare.startsWith("::ffff:127.")
  );
}

/** Parses `ps -A -o pid=,ppid=,pgid=`. */
export function parsePsTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const [pid, parent, group] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(parent) && Number.isInteger(group))
      rows.push({ pid: pid as number, parent: parent as number, group: group as number });
  }
  return rows;
}

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: a `p<pid>` line, then `n<address>:<port>` lines. */
export function parseLsofListeners(text: string): { pid: number; listener: Listener }[] {
  const found: { pid: number; listener: Listener }[] = [];
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) {
      const name = line.slice(1).trim();
      const colon = name.lastIndexOf(":");
      const port = Number(name.slice(colon + 1));
      if (colon < 0 || !Number.isInteger(port) || port <= 0) continue;
      found.push({ pid, listener: { port, loopback: isLoopbackAddress(name.slice(0, colon)) } });
    }
  }
  return found;
}

async function darwinListeners(pids: readonly number[]): Promise<Listener[] | null> {
  const [ps, lsof] = await Promise.all([
    capture("ps", ["-A", "-o", "pid=,ppid=,pgid="]),
    capture("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]),
  ]);
  // lsof exits 1 when nothing listens at all.
  if (ps?.code !== 0 || !lsof || (lsof.code !== 0 && lsof.code !== 1)) return null;
  const family = processFamily(pids, parsePsTable(ps.stdout));
  return parseLsofListeners(lsof.stdout)
    .filter((entry) => family.has(entry.pid))
    .map((entry) => entry.listener);
}

/** Process rows (`P pid parent created`) and listeners (`L pid address port`) in one call. */
const WINDOWS_SOCKETS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { exit 3 }",
  "Get-CimInstance Win32_Process | ForEach-Object { 'P {0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }",
  "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { 'L {0} {1} {2}' -f $_.OwningProcess, $_.LocalAddress, $_.LocalPort }",
].join("; ");

/** Parses the output of the Windows socket script. */
export function parseWindowsSockets(text: string): {
  table: ProcessRow[];
  listeners: { pid: number; listener: Listener }[];
} {
  const table: ProcessRow[] = [];
  const listeners: { pid: number; listener: Listener }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [kind, a, b, c] = line.trim().split(" ");
    if (kind === "P") {
      const [pid, parent, started] = [a, b, c].map(Number);
      if (Number.isInteger(pid) && Number.isInteger(parent))
        table.push({ pid: pid as number, parent: parent as number, started: started || undefined });
    } else if (kind === "L" && a && b && c) {
      const pid = Number(a);
      const port = Number(c);
      if (Number.isInteger(pid) && Number.isInteger(port))
        listeners.push({ pid, listener: { port, loopback: isLoopbackAddress(b) } });
    }
  }
  return { table, listeners };
}

async function windowsListeners(pids: readonly number[]): Promise<Listener[] | null> {
  const result = await capture("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_SOCKETS_SCRIPT,
  ]);
  if (result?.code !== 0) return null;
  const { table, listeners } = parseWindowsSockets(result.stdout);
  if (!table.length) return null;
  const family = processFamily(pids, table);
  return listeners.filter((entry) => family.has(entry.pid)).map((entry) => entry.listener);
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
