import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  readLoggedPids,
  reapOrphanedLspProcesses,
} from "../src/core/intelligence/backends/lsp/pid-tracker.js";
import { configDir } from "../src/core/platform/index.js";

const IS_WIN = process.platform === "win32";
const log = join(configDir(), "lsp-pids.log");
const children: ChildProcess[] = [];

/** A long-running process; on POSIX `name` replaces argv[0] so `ps` shows it like an LSP binary. */
function start(name?: string): ChildProcess {
  const child = IS_WIN
    ? spawn("powershell", ["-NoProfile", "-Command", "Start-Sleep 30"], { windowsHide: true })
    : spawn("bash", ["-c", name ? `exec -a ${name} sleep 30` : "exec sleep 30"]);
  children.push(child);
  return child;
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => child.once("exit", () => done()));
}

function writeLog(lines: string[]): void {
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, lines.map((line) => `${line}\n`).join(""), "utf-8");
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

test("keeps LSP entries owned by another running BAKED process", () => {
  const owner = start();
  const lsp = start("gopls");
  writeLog([`+${String(lsp.pid)}:${String(owner.pid)}`]);
  reapOrphanedLspProcesses();
  expect(lsp.exitCode).toBeNull();
  expect(readLoggedPids().get(lsp.pid ?? 0)).toBe(owner.pid);
});

test.skipIf(IS_WIN)("kills LSPs whose owner has exited and drops their entries", async () => {
  const owner = start();
  owner.kill("SIGKILL");
  await exited(owner);
  const lsp = start("gopls");
  // Give bash time to exec, so `ps` reports the LSP-like name.
  await Bun.sleep(200);
  writeLog([`+${String(lsp.pid)}:${String(owner.pid)}`, "+999999"]);
  reapOrphanedLspProcesses();
  await exited(lsp);
  expect(lsp.signalCode).toBe("SIGKILL");
  // Other tests in this process may still own LSPs, so only these entries are checked.
  const logged = readLoggedPids();
  expect(logged.has(lsp.pid ?? 0)).toBe(false);
  expect(logged.has(999999)).toBe(false);
});
