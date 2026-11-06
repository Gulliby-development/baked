import { describe, expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { KILL_EXIT_GRACE_MS, KILLED_NO_EXIT_NOTE, ProcessScope } from "../src/core/workflows/process-scope.js";

// #2858: a check ran into the 30 s test limit on macOS although its command had a 10 s timeout.
// `execute` waited for `close` after the kill, and a process the OS does not let die at once (one
// held in exec by a policy scan) or an exit event that never arrives kept that wait open. Here the
// kill is swallowed, so the command outlives it the way such a process does.
describe.skipIf(process.platform === "win32")("a killed command that does not exit (#2858)", () => {
  test("execute returns timedOut a bounded time after the kill instead of waiting for the exit", async () => {
    const kill = process.kill;
    const childKill = ChildProcess.prototype.kill;
    const pids: number[] = [];
    process.kill = ((pid: number, signal?: string | number) =>
      signal === 0 ? kill.call(process, pid, 0) : true) as typeof process.kill;
    ChildProcess.prototype.kill = function () {
      return true;
    };
    const started = Date.now();
    try {
      const result = await new ProcessScope().execute("/bin/sh", ["-c", "echo started; sleep 30"], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 500,
        signal: new AbortController().signal,
        sandbox: null,
        onSpawn: (pid) => pids.push(pid),
      });
      const elapsed = Date.now() - started;
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("started");
      expect(result.output).toContain(KILLED_NO_EXIT_NOTE);
      expect(elapsed).toBeLessThan(500 + 500 + KILL_EXIT_GRACE_MS + 3000);
    } finally {
      process.kill = kill;
      ChildProcess.prototype.kill = childKill;
      for (const pid of pids)
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
    }
  });

  test("a command that exits on the kill still returns its own exit, without the note", async () => {
    const result = await new ProcessScope().execute("/bin/sh", ["-c", "echo started; sleep 30"], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 500,
      signal: new AbortController().signal,
      sandbox: null,
    });
    expect(result.timedOut).toBe(true);
    expect(result.output).not.toContain(KILLED_NO_EXIT_NOTE);
    expect(result.signal).not.toBeNull();
  });
});
