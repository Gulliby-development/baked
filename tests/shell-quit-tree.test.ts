import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killAllTracked } from "../src/core/process-tracker.js";
import { runBoundedShell } from "../src/core/tools/bounded-process.js";
import { shellTool } from "../src/core/tools/shell.js";
import { removeTempDir } from "./helpers/temp-dir.js";

// Quitting the TUI on Windows left a running shell command behind: the shell tool's process was
// not tracked, so the quit's cleanup never reached cmd.exe or the program it ran (#2826). The
// command here is shell wrapper -> a program that writes its PID and sleeps, the same shape.

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await removeTempDir(dir);
});

/** A command line, the same in sh and cmd.exe, whose program writes its PID to the returned file. */
function sleeper(): { command: string; pidFile: string; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "baked-quit-tree-"));
  dirs.push(cwd);
  const pidFile = join(cwd, "pid");
  const script = join(cwd, "sleep.js");
  writeFileSync(
    script,
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`,
  );
  return { command: `${process.execPath} ${script}`, pidFile, cwd };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The program's PID once it wrote it, read before a deadline inside the test's limit. */
async function programPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (pid > 0) return pid;
    }
    await Bun.sleep(100);
  }
  throw new Error("the command's program never started");
}

/** Waits until `pid` is gone, before a deadline inside the test's limit. */
async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await Bun.sleep(100);
  }
  return false;
}

describe("quitting stops a running shell command's whole tree (#2826)", () => {
  test("the chat shell tool's command and the program it runs", async () => {
    const { command, pidFile, cwd } = sleeper();
    const running = shellTool.execute({ command, cwd, timeout: 50_000 });
    const pid = await programPid(pidFile);
    killAllTracked();
    expect(await gone(pid)).toBe(true);
    await running;
  }, 60_000);

  test("a bounded shell command (formatters) and the program it runs", async () => {
    const { command, pidFile, cwd } = sleeper();
    const running = runBoundedShell(command, { cwd, timeoutMs: 50_000 });
    const pid = await programPid(pidFile);
    killAllTracked();
    expect(await gone(pid)).toBe(true);
    await running;
  }, 60_000);
});
