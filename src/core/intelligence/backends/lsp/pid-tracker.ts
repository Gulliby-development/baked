/**
 * PID tracker + system-wide reaper for LSP child processes.
 *
 * Two independent layers of defense against orphan leaks:
 *
 * 1. Per-session PID log (~/.baked/lsp-pids.json) — PIDs tracked
 *    in-memory and mirrored to disk via append-only writes. Works even
 *    across main thread + worker thread (each owns its own Set, but all
 *    append to the shared file).
 *
 * 2. System scan — ignores the PID file entirely and walks `ps` output
 *    looking for LSP binaries whose parent is init (PPID=1) and owner
 *    matches the current user. Catches every orphan class the PID file
 *    misses: crashed-before-flush, killed-before-write, reaper-never-ran,
 *    PID-file-corrupted, grandchildren reparented by macOS on sudden death.
 *
 * The reaper calls BOTH layers. Layer 2 is the load-bearing one — layer
 * 1 is kept as a fast-path for the common case.
 */
import { execFileSync, execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  configDir,
  dataDir,
  IS_WIN,
  killTree as platformKillTree,
  userDataDir,
} from "../../../platform/index.js";

const BAKED_DIR = configDir();
const PID_LOG = join(BAKED_DIR, "lsp-pids.log");

/** In-memory set of PIDs this thread has spawned */
const activePids = new Set<number>();

function ensureDir(): void {
  if (!existsSync(BAKED_DIR)) {
    try {
      mkdirSync(BAKED_DIR, { recursive: true });
    } catch {}
  }
}

/**
 * Record a newly spawned LSP process — append-only so main+worker don't race.
 * The entry names the BAKED process that owns it, so a reaper in another
 * BAKED process (a second `baked serve`, another terminal) leaves it alone
 * while that owner is alive.
 */
export function trackLspPid(pid: number): void {
  activePids.add(pid);
  try {
    ensureDir();
    appendFileSync(PID_LOG, `+${String(pid)}:${String(process.pid)}\n`, "utf-8");
  } catch {}
}

/** Remove a PID when the process exits normally */
export function untrackLspPid(pid: number): void {
  activePids.delete(pid);
  try {
    appendFileSync(PID_LOG, `-${String(pid)}\n`, "utf-8");
  } catch {}
}

/**
 * Read the PID log: every tracked PID not yet untracked, mapped to the PID of
 * the BAKED process that spawned it (0 for entries written before owners were
 * logged).
 */
export function readLoggedPids(): Map<number, number> {
  const tracked = new Map<number, number>();
  try {
    if (!existsSync(PID_LOG)) return tracked;
    const raw = readFileSync(PID_LOG, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const op = line[0];
      const [pidText, ownerText] = line.slice(1).split(":");
      const pid = Number.parseInt(pidText ?? "", 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (op === "+") {
        const owner = Number.parseInt(ownerText ?? "", 10);
        tracked.set(pid, Number.isFinite(owner) && owner > 0 ? owner : 0);
      } else if (op === "-") tracked.delete(pid);
    }
  } catch {}
  return tracked;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Regex matching LSP server command patterns. Used both for verifying
 * a tracked PID before killing it AND for system-scan discovery.
 */
const LSP_COMMAND_REGEX =
  /\b(?:biome[^/\s]*(?:\s+lsp-proxy|\s+__run_server)|typescript-language-server|tsserver\.js|vtsls|pyright|pylsp|gopls|rust-analyzer|clangd|lua-language-server|taplo|solargraph|intelephense|zls|jdtls|metals|sourcekit-lsp|dart\s+language-server|elixir-ls|ocamllsp|yaml-language-server|bash-language-server|vscode-eslint-language-server|vscode-json-language-server|vscode-css-language-server|vscode-html-language-server|tailwindcss-language-server|emmet-language-server|deno\s+lsp|vue-language-server|csharp-ls|OmniSharp|kotlin-language-server|docker-langserver|expert)\b/i;

const BAKED_PATH_MARKERS = [
  // POSIX layout
  join(userDataDir(), "mason"),
  join(configDir(), "lsp-servers"),
  join(configDir(), "bin"),
  // Windows layout: %LOCALAPPDATA%\baked\{lsp-servers,bin,mason}
  join(dataDir(), "lsp-servers"),
  join(dataDir(), "bin"),
  join(dataDir(), "mason"),
  // node_modules LSPs — project-local typescript/biome/eslint installs
  // that baked spawned. The orphan leak lives here for biome.
  "node_modules/.bin/biome",
  "node_modules/@biomejs/",
  "node_modules/.bin/typescript-language-server",
  "node_modules/typescript/lib/tsserver",
  "node_modules/.bin/vtsls",
  // Windows path-separator variants of the node_modules markers
  "node_modules\\.bin\\biome",
  "node_modules\\@biomejs\\",
  "node_modules\\.bin\\typescript-language-server",
  "node_modules\\typescript\\lib\\tsserver",
  "node_modules\\.bin\\vtsls",
];

interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  user: string;
  command: string;
}

function scanProcessTree(): PsRow[] {
  try {
    if (IS_WIN) {
      // PowerShell over WMIC: WMIC is deprecated since Win10 21H1 but ships
      // through Win11. Get-CimInstance is the modern path and works on every
      // build we target. CSV output is line-stable across locales.
      const ps =
        "Get-CimInstance Win32_Process | " +
        "Select-Object ProcessId,ParentProcessId,@{N='User';E={(Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User}},CommandLine | " +
        "ConvertTo-Csv -NoTypeInformation";
      const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
      const rows: PsRow[] = [];
      const lines = out.split(/\r?\n/);
      // Skip header line (first non-empty)
      let started = false;
      for (const line of lines) {
        if (!line.trim()) continue;
        if (!started) {
          started = true;
          continue;
        }
        // Simple CSV split — fields are quoted; commands rarely contain quotes,
        // but if they do PowerShell escapes them as "". Strip outer quotes per field.
        const fields = line
          .match(/("([^"]|"")*"|[^,]*)(,|$)/g)
          ?.map((f) => f.replace(/,$/, "").trim().replace(/^"|"$/g, "").replace(/""/g, '"'));
        if (!fields || fields.length < 4) continue;
        const pid = Number.parseInt(fields[0] ?? "0", 10);
        const ppid = Number.parseInt(fields[1] ?? "0", 10);
        const user = fields[2] ?? "";
        const command = fields[3] ?? "";
        if (!pid) continue;
        rows.push({ pid, ppid, pgid: 0, user, command });
      }
      return rows;
    }
    const out = execSync("ps -axo pid=,ppid=,pgid=,user=,command=", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const rows: PsRow[] = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      rows.push({
        pid: Number.parseInt(m[1] ?? "0", 10),
        ppid: Number.parseInt(m[2] ?? "0", 10),
        pgid: Number.parseInt(m[3] ?? "0", 10),
        user: m[4] ?? "",
        command: m[5] ?? "",
      });
    }
    return rows;
  } catch {
    return [];
  }
}

function isbakedLspCommand(cmd: string): boolean {
  if (!LSP_COMMAND_REGEX.test(cmd)) return false;
  for (const marker of BAKED_PATH_MARKERS) {
    if (cmd.includes(marker)) return true;
  }
  return false;
}

function killTree(pid: number): boolean {
  // Windows: taskkill /F /T handles the descendant tree.
  if (IS_WIN) {
    return platformKillTree(pid, "SIGKILL");
  }
  // POSIX: kill the process group first (catches grandchildren like biome's
  // native binary launched via spawnSync). Fall through to plain pid
  // kill if the group kill fails (e.g. no pgrp set).
  let ok = false;
  try {
    process.kill(-pid, "SIGKILL");
    ok = true;
  } catch {}
  try {
    process.kill(pid, "SIGKILL");
    ok = true;
  } catch {}
  return ok;
}

/**
 * Kill every LSP-looking orphan (PPID=1) owned by the current user
 * whose command path is under a baked-managed bin directory or
 * node_modules location. Returns the number killed.
 *
 * Runs synchronously — safe to call on every process.exit.
 */
export function reapOrphanedLspProcesses(): number {
  let killed = 0;
  const myUser = safeUser();
  const myPid = process.pid;

  // Layer 1: drain the PID log. Kill anything we previously tracked that we
  // don't still own in-memory, unless another BAKED process that is still
  // running owns it (each project in the desktop app runs its own
  // `baked serve`). Entries with no owner predate owner logging.
  const tracked = readLoggedPids();
  const logged = new Set<number>();
  const keep = new Map<number, number>();
  for (const [pid, owner] of tracked) {
    if (activePids.has(pid)) continue;
    if (owner !== 0 && owner !== myPid && processAlive(owner)) {
      keep.set(pid, owner);
      continue;
    }
    logged.add(pid);
  }
  for (const pid of logged) {
    if (pid === myPid) continue;
    if (!processAlive(pid)) continue;
    if (!pidLooksLikeLsp(pid)) continue;
    if (killTree(pid)) killed++;
  }

  // Layer 2: system scan. Find every orphan LSP regardless of whether
  // we ever logged it — this is the one that actually stops the leak.
  const rows = scanProcessTree();
  // Build a parent map so we can also kill our-own-pid descendants
  // (grandchildren that outlived the wrapper but still have a real ppid).
  const orphaned = new Set<number>();
  for (const row of rows) {
    if (row.user !== myUser) continue;
    if (row.pid === myPid) continue;
    if (!isbakedLspCommand(row.command)) continue;
    // Orphan (reparented to init) OR our descendant we already logged —
    // either way it's ours to clean up.
    if (row.ppid === 1 || logged.has(row.pid) || logged.has(row.ppid)) {
      orphaned.add(row.pid);
    }
  }
  for (const pid of orphaned) {
    if (activePids.has(pid) || keep.has(pid)) continue;
    if (killTree(pid)) killed++;
  }

  // Rewrite the log: every pre-existing entry of a dead owner is handled.
  // Keep the entries of live BAKED processes and re-log the PIDs this
  // process still owns, so a later reap from any process knows about them.
  try {
    const payload = [
      ...[...keep].map(([pid, owner]) => `+${String(pid)}:${String(owner)}\n`),
      ...[...activePids].map((pid) => `+${String(pid)}:${String(myPid)}\n`),
    ].join("");
    if (payload) {
      ensureDir();
      writeFileSync(PID_LOG, payload, "utf-8");
    } else if (existsSync(PID_LOG)) unlinkSync(PID_LOG);
  } catch {}

  return killed;
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

function pidLooksLikeLsp(pid: number): boolean {
  try {
    if (IS_WIN) {
      // tasklist /FI "PID eq <pid>" /FO CSV returns one CSV line; the image
      // name is in the first field. CommandLine is not exposed by tasklist,
      // so we resort to Get-CimInstance for the full path.
      const ps = `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").CommandLine`;
      const cmd = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
        windowsHide: true,
      }).trim();
      if (!cmd) return false;
      return isbakedLspCommand(cmd) || LSP_COMMAND_REGEX.test(cmd);
    }
    const cmd = execSync(`ps -o command= -p ${String(pid)}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    return isbakedLspCommand(cmd) || LSP_COMMAND_REGEX.test(cmd);
  } catch {
    return false;
  }
}

/**
 * Synchronous kill of all LSP PIDs tracked this session.
 * Called during process exit when async operations won't complete.
 * After killing, runs a system scan to catch anything we missed.
 */
export function killAllLspSync(): void {
  for (const pid of activePids) {
    killTree(pid);
  }
  activePids.clear();
  // System scan catches LSPs spawned by the worker thread (separate
  // module scope → separate activePids Set we can't reach directly)
  // plus grandchildren that outlived their wrapper.
  // The reap also rewrites the log down to entries of other live BAKED processes.
  try {
    reapOrphanedLspProcesses();
  } catch {}
}
