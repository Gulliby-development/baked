import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { OUTPUT_GRACE_MS, processOutput } from "../src/core/spawn.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";

// The Windows queue flake of the follow-up delivery test (#1029): a run waited on a command's
// output until the test timed out. A command that exits while a process it started still holds
// the output pipes kept every caller waiting for as long as that process ran, and on Windows a
// timeout kill cannot reach it once its parent is gone.

const HOLD_MS = 20_000;
/** Prints, starts a detached child that inherits stdout and stderr and sleeps, and exits at once. */
const leaveHolder = `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, ${HOLD_MS})"], { stdio: ["ignore", "inherit", "inherit"], detached: true }).unref(); console.log("parent done");`;

describe("a process that keeps the output pipes open after the command exited", () => {
  test("a check returns once the command exits, with its output", async () => {
    const started = performance.now();
    const result = await new ProcessScope().execute(process.execPath, ["-e", leaveHolder], {
      cwd: tmpdir(),
      env: process.env,
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      sandbox: null,
    });
    expect(performance.now() - started).toBeLessThan(OUTPUT_GRACE_MS + 5000);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(result.output).toStartWith("parent done");
    expect(result.output).toContain("kept its output open");
  }, 40_000);

  test("a Git-style read returns once the process exits, with its output", async () => {
    const started = performance.now();
    const proc = Bun.spawn([process.execPath, "-e", leaveHolder], { stdout: "pipe", stderr: "pipe", cwd: tmpdir() });
    const result = await processOutput(proc);
    expect(performance.now() - started).toBeLessThan(OUTPUT_GRACE_MS + 5000);
    expect(result.code).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe("parent done\n");
  }, 40_000);

  test("output that ends normally is read whole without waiting for the grace period", async () => {
    const started = performance.now();
    const proc = Bun.spawn([process.execPath, "-e", "process.stdout.write('x'.repeat(200000)); console.error('err')"], { stdout: "pipe", stderr: "pipe" });
    const result = await processOutput(proc);
    expect(performance.now() - started).toBeLessThan(OUTPUT_GRACE_MS + 1000);
    expect(result.stdout.length).toBe(200000);
    expect(new TextDecoder().decode(result.stderr)).toBe("err\n");
  });
});
