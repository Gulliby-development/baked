import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECK_PREFLIGHT_ARTIFACT,
  failFastUnavailable,
  smokeChecks,
  unresolvedChecks,
} from "../src/core/workflows/check-preflight.js";
import { environmentRunners, PROGRAM_NOT_STARTED_LINES, programNotStarted, RUNNER_LINES } from "../src/core/verification/program-not-started.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import type { Check } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const check = (patch: Partial<Check> = {}): Check => ({
  ...(fixturePolicy.checks[0] as Check),
  ...patch,
});

describe("a required check that cannot be started", () => {
  test("failFastUnavailable stops on a spawn_error of a required check only", () => {
    const required = check({ id: "mvn-test", executable: "mvn", args: ["test"] });
    expect(() => failFastUnavailable(required, { reason: "spawn_error", output: "spawn mvn EINVAL" })).toThrow(
      WorkflowFault,
    );
    expect(() => failFastUnavailable(required, { reason: "timeout" })).not.toThrow();
    expect(() => failFastUnavailable(required, { reason: "exit" })).not.toThrow();
    expect(() =>
      failFastUnavailable({ ...required, required: false }, { reason: "spawn_error" }),
    ).not.toThrow();
    try {
      failFastUnavailable(required, { reason: "spawn_error", output: "spawn mvn EINVAL" });
    } catch (error) {
      expect((error as WorkflowFault).details).toMatchObject({
        reason: "check_unavailable",
        checkId: "mvn-test",
      });
      expect((error as WorkflowFault).message).toContain("mvn test");
    }
  });

  test("the start smoke finds bare executables that do not resolve", () => {
    const checks = [
      check({ id: "ok", executable: "cargo" }),
      check({ id: "gone", executable: "nope-tool" }),
      check({ id: "generated", executable: "./gradlew" }),
      check({ id: "runtime", executable: "bun" }),
    ];
    const found = unresolvedChecks(checks, process.cwd(), (command) =>
      command === "cargo" ? "/usr/bin/cargo" : null,
    );
    expect(found).toEqual([{ checkId: "gone", executable: "nope-tool", required: true }]);
  });

  test("a run blocks at the first spawn_error with check_unavailable, at its baseline before any task", async () => {
    const fixture = workflowFixture({
      policy: {
        ...fixturePolicy,
        checks: [check({ executable: "baked-fixture-command-does-not-exist" })],
      },
    });
    cleanups.push(fixture.dispose);
    const signal = new AbortController().signal;
    const run = await fixture.start();
    // The check baseline before approval already stops on it (#3040).
    const snapshot = await fixture.service.drive(run.runId, signal);
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.reason).toBe("check_unavailable");
    expect(fixture.executor.calls).not.toContain("implementation");
    expect(fixture.executor.calls).not.toContain("review");
  });
});

/** A check executable that resolves but cannot be spawned, as `mvn.cmd` was in R8 propdrift. */
const unspawnable: Partial<Check> =
  // cmd.exe would expand the percent sign, so the batch launch refuses the line.
  process.platform === "win32" ? { executable: "./tool.cmd", args: ["100%"] } : { executable: "./tool", args: [] };
function writeUnspawnable(dir: string): void {
  const file = join(dir, process.platform === "win32" ? "tool.cmd" : "tool");
  writeFileSync(file, process.platform === "win32" ? "@echo off\r\n" : "not a program\n");
  if (process.platform !== "win32") chmodSync(file, 0o644);
}

describe("the start-time check smoke", () => {
  test("starts each check once outside the workspace and reports what could not start", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-smoke-"));
    cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
    writeUnspawnable(root);
    const checks = [
      check({ id: "runs", executable: process.execPath, args: ["-e", "await Bun.write('touched.txt', 'x'); await Bun.sleep(60000)"] }),
      check({ id: "broken", ...unspawnable }),
      check({ id: "gone", executable: "baked-fixture-command-does-not-exist", required: false }),
      check({ id: "generated", executable: "./gradlew" }),
      check({ id: "runtime", executable: "bun" }),
    ];
    const started = performance.now();
    const smoke = await smokeChecks(checks, root);
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(Object.fromEntries(smoke.map((s) => [s.checkId, s.status]))).toEqual({
      runs: "started",
      broken: "cannot_start",
      gone: "not_found",
      generated: "not_probed",
      runtime: "not_probed",
    });
    expect(smoke.find((s) => s.checkId === "broken")?.detail).toBeTruthy();
    expect(existsSync(join(root, "touched.txt"))).toBe(false);
  });

  test("a required check that cannot start refuses the run before it begins; the smoke is recorded", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    fixture.service.providerReady = async () => ({ known: true, ready: true });
    const refused = workflowFixture({
      policy: { ...fixturePolicy, checks: [check({ id: "broken", ...unspawnable })] },
    });
    cleanups.push(refused.dispose);
    refused.service.providerReady = async () => ({ known: true, ready: true });
    writeUnspawnable(refused.root);
    await expect(refused.start()).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "check_unavailable" },
    });
    expect((await refused.service.list({ limit: 10 })).items).toHaveLength(0);

    const run = await fixture.start();
    const row = fixture.service.store.latestArtifact(run.runId, CHECK_PREFLIGHT_ARTIFACT);
    expect(row).toBeTruthy();
    const recorded = JSON.parse(fixture.service.store.readArtifact(run.runId, row?.id ?? "")) as {
      checks: { checkId: string; status: string }[];
    };
    expect(recorded.checks).toEqual([expect.objectContaining({ checkId: "check", status: "not_probed" })]);
  });
});

// R109 callfence (#3040): cmd.exe printed `'bundle' is not recognized as an internal or external
// command` and exited 1 on every check. The baseline recorded it as the project's debt and the run
// implemented every task (1.97M tokens, $6.55) before it stopped at the checks stage.
/** A launcher at `dir` that starts and cannot find the program it runs: `bundle exec rubocop`. */
function writeLauncher(dir: string, line: string, exit: number): string {
  const file = join(dir, process.platform === "win32" ? "bundle.cmd" : "bundle");
  writeFileSync(
    file,
    process.platform === "win32" ? `@echo off\r\necho ${line} 1>&2\r\nexit /b ${exit}\r\n` : `#!/bin/sh\necho "${line}" >&2\nexit ${exit}\n`,
  );
  if (process.platform !== "win32") chmodSync(file, 0o755);
  return file;
}

describe("scenario: a required check whose launcher cannot find its program (#3040)", () => {
  test("the run blocks check_unavailable at the baseline, before approval and before any task", async () => {
    const bin = mkdtempSync(join(tmpdir(), "baked-launcher-"));
    cleanups.push(async () => rmSync(bin, { recursive: true, force: true }));
    const launcher = writeLauncher(bin, "bundler: command not found: rubocop", 127);
    const fixture = workflowFixture({ policy: { ...fixturePolicy, checks: [check({ id: "rubocop", executable: launcher, args: ["exec", "rubocop"] })] } });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const signal = new AbortController().signal;
    const first = await fixture.service.drive(run.runId, signal);
    const snapshot = first.status === "blocked" ? first : (await fixture.approve(run.runId), await fixture.service.drive(run.runId, signal));
    // On main: the baseline recorded the failure as debt and the run implemented every task.
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.reason).toBe("check_unavailable");
    expect(fixture.executor.calls).not.toContain("implementation");
  });
});

describe("programNotStarted (#3040)", () => {
  test("each launcher's line for the check's own program, and not for another program", () => {
    expect(programNotStarted("bundle", ["exec", "rubocop"], "'bundle' is not recognized as an internal or external command,\r\noperable program or batch file.", 1)).toMatchObject({ launcher: "cmd.exe", program: "bundle" });
    expect(programNotStarted("sh", ["-c", "ruff check ."], "sh: 1: ruff: not found", 127)).toMatchObject({ launcher: "POSIX shell", program: "ruff" });
    expect(programNotStarted("bash", ["-c", "ruff check ."], "bash: line 1: ruff: command not found", 127)?.program).toBe("ruff");
    expect(programNotStarted("bundle", ["exec", "rspec"], "bundler: command not found: rspec\nInstall missing gem executables with `bundle install`", 127)).toMatchObject({ launcher: "Bundler (bundle exec)", program: "rspec" });
    expect(programNotStarted("uv", ["run", "pytest"], "error: Failed to spawn: `pytest`\n  Caused by: No such file or directory (os error 2)", 2)).toMatchObject({ launcher: "uv run" });
    expect(programNotStarted("poetry", ["run", "pytest"], "Command not found: pytest", 1)).toMatchObject({ launcher: "poetry run" });
    // A test that prints such a line about another command stays a plain failure.
    expect(programNotStarted("bundle", ["exec", "rspec"], "  expected output: 'git' is not recognized as an internal or external command", 1)).toBeNull();
    expect(programNotStarted("sh", ["-c", "make test"], "test_cli.sh: line 3: jq: command not found\nFAIL", 2)).toBeNull();
    // The POSIX line needs exit 127; a passing run is never a start failure.
    expect(programNotStarted("sh", ["-c", "ruff check ."], "sh: 1: ruff: not found", 1)).toBeNull();
    expect(programNotStarted("bundle", ["exec", "rubocop"], "bundler: command not found: rubocop", 0)).toBeNull();
  });

  test("every environment runner has a row in the table", () => {
    for (const runner of environmentRunners()) {
      const launcher = RUNNER_LINES[runner];
      expect(launcher, runner).toBeDefined();
      expect(PROGRAM_NOT_STARTED_LINES.some((row) => row.launcher === launcher), runner).toBe(true);
    }
  });
});
