import { statSync } from "node:fs";
import { join } from "node:path";
import { runSandbox, type SandboxRequest, SandboxUnavailableError } from "../security/sandbox.js";
import { buildSafeEnv } from "../spawn.js";
import { canonical, hashJson } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { rootField } from "../workflows/effects.js";
import type { ProcessResult, ProcessScope } from "../workflows/process-scope.js";
import { generatedPaths, type RunPolicy } from "../workflows/schemas.js";
import { recordWouldStop, stopMode } from "../workflows/stop-reasons.js";
import type { WorkflowStore } from "../workflows/store.js";
import { withPerTestTimeout } from "../workflows/test-timeout.js";
import { toolchainCommand } from "../workflows/toolchain.js";
import type { Check } from "../workflows/types.js";
import { type CommandTimeout, fileArgs, recordCommandTimeout } from "./command-timeouts.js";
import { environmentFault, environmentNote, unpreparedNote } from "./environment-faults.js";
import { isFailedTestLine } from "./failed-test-line.js";
import { MISSING_GATE_REPORT, readGateReport, renderGateReport } from "./gate-report.js";
import { testsRan } from "./output-counts.js";
import { changedPaths, sourceManifest } from "./snapshot.js";
import { gradleTestReport } from "./test-reports.js";

/**
 * Shared process execution for native checks and the legacy project formatter. A Gradle run gets
 * the totals of the test reports it wrote appended to its output (`gradleTestReport`, #1489).
 */
export const executeCheckCommand = async (
  scope: ProcessScope,
  executable: string,
  args: string[],
  options: Parameters<ProcessScope["execute"]>[2],
): Promise<ProcessResult> => {
  const started = Date.now();
  const result = await scope.execute(
    executable,
    withPerTestTimeout({ executable, args }, options.cwd),
    options,
  );
  const report =
    result.timedOut || result.cancelled
      ? null
      : gradleTestReport(executable, args, options.cwd, started);
  return report
    ? {
        ...result,
        output: `${result.output.replace(/\n*$/, "")}\n\n${report}\n`,
      }
    : result;
};

/** The environment every check and on-demand gate run gets: safe base plus the names it declares. */
export function buildCheckEnv(check: Pick<Check, "envNames">): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = buildSafeEnv();
  for (const name of check.envNames)
    if (process.env[name] !== undefined) env[name] = process.env[name];
  // A build server a check leaves running keeps its working directory, and so a task worktree,
  // locked on Windows (EBUSY when the worktree is removed): .NET and MSBuild reuse worker nodes and
  // a shared compiler server by default.
  env.MSBUILDDISABLENODEREUSE ??= "1";
  env.DOTNET_CLI_USE_MSBUILD_SERVER ??= "0";
  env.UseSharedCompilation ??= "false";
  if (process.platform === "win32") {
    const path = env.PATH ?? env.Path;
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    if (path) env.PATH = path;
  }
  return env;
}

/**
 * A check whose command lists the files it finds wrong and exits 0 whatever it lists: `gofmt -l`
 * (#1480). Any file it lists fails the check, so formatting is verified like `cargo fmt --check`.
 */
export function listsFailures(check: Pick<Check, "executable" | "args">): boolean {
  const { program, args } = toolchainCommand(check.executable, check.args);
  return program === "gofmt" && args.includes("-l");
}

/**
 * A check that must run tests, whose output says it ran none (#1832): every test of the files was
 * compiled out or skipped. A summary that does not tell is not taken as none.
 */
export const ranNoTests = (check: Pick<Check, "requireTests">, output: string): boolean =>
  check.requireTests === true && testsRan(output)?.count === 0;

/**
 * The selection fault of a check that runs the test classes its files declare (#2363): it exited
 * 0 and ran no test, so its filter selected none of them. Null otherwise. maskback (bench round
 * 75) filtered `dotnet test` by a file's name while the file declared another class, and the task
 * was sent back twice to keep a class the filter could find.
 */
export function unselectedTests(
  check: Pick<Check, "id" | "executable" | "args" | "requireTests" | "declaredTests">,
  exitCode: number | null,
  output: string,
): { checkId: string; command: string; declared: string[] } | null {
  if (exitCode !== 0 || !check.declaredTests?.length || !ranNoTests(check, output)) return null;
  return {
    checkId: check.id,
    command: [check.executable, ...check.args].join(" "),
    declared: check.declaredTests,
  };
}

/**
 * The `written_tests_unselected` decisions of a run's recorded written-tests checks on the current
 * rule, for the replay (#2363): each recorded check artifact's definition and output.
 */
export function replayUnselectedTests(
  store: WorkflowStore,
  runId: string,
): NonNullable<ReturnType<typeof unselectedTests>>[] {
  return store
    .artifacts(runId)
    .filter((row) => row.kind === "check" && /^checks\/[^/]+-written\//.test(row.logical_path))
    .flatMap((row) => {
      try {
        const body = JSON.parse(store.readArtifact(runId, row.id)) as {
          definition?: Check;
          exitCode?: number | null;
          output?: string;
        };
        const found = body.definition
          ? unselectedTests(body.definition, body.exitCode ?? null, body.output ?? "")
          : null;
        return found ? [found] : [];
      } catch {
        return [];
      }
    });
}

/**
 * The status of a check's finished command: its exit code, the files a listing check names, and
 * for a check that must run tests, whether any ran.
 */
export function exitStatus(
  check: Pick<Check, "executable" | "args" | "requireTests">,
  exitCode: number,
  output: string,
): "passed" | "failed" {
  return exitCode === 0 && !(listsFailures(check) && output.trim()) && !ranNoTests(check, output)
    ? "passed"
    : "failed";
}

const noTestsNote = (check: Check): string =>
  `Note: ${check.id} exited 0 but ran no test: every test of the files it runs was compiled out or skipped under its command (${[check.executable, ...check.args].join(" ")}), so it verified nothing. Make the tests run under this command. A file behind a Cargo feature, a Go build tag or another gate the request requires is run with that gate when the file declares it the way the language does (\`#![cfg(feature = "name")]\`, \`//go:build name\`); a test skipped at module level or excluded by a profile, group or filter does not run at all.`;

const listedNote = (check: Check): string =>
  `Note: ${check.executable} ${check.args.join(" ")} lists the files that are not formatted and exits 0, so every file listed above fails ${check.id}.${check.fix ? ` Its fixer (${check.fix.executable} ${check.fix.args.join(" ")}) formats them.` : ""}`;

const ALL_PASSED =
  /^\s*(?:\d+ pass\b[\s\S]*^\s*0 fail\b|=+ \d+ passed(?: in [\d.]+s)? =+$|Tests?:\s+\d+ passed, \d+ total)/m;
const ANY_FAILED = /^\s*[1-9]\d* fail\b|\b[1-9]\d* (?:failed|errors?)\b/m;

/**
 * Explains a failed exit whose output reports every test passing. Run 1185f909: a test called
 * the CLI in-process, the CLI set `process.exitCode = 1` for an error case, and the agent read
 * "9 pass 0 fail" with exit 1 as an unexplained mismatch and gave up.
 */
export function passedOutputNote(output: string, exitCode: number | null): string | null {
  if (!exitCode || !ALL_PASSED.test(output) || ANY_FAILED.test(output)) return null;
  return `Note: the command exited with code ${exitCode} although its output reports every test passing. Something the tests ran left a nonzero exit code in the test process, for example code that sets \`process.exitCode\` or calls \`process.exit\` when called in-process. Fix that (run such code in a child process, or restore the exit code in the test) instead of the assertions.`;
}

/** Characters of a check's output a tool result carries to the model (#993). */
export const MODEL_OUTPUT_LIMIT = 40_000;
const OUTPUT_HEAD = 4_000;
const OUTPUT_TAIL = 32_000;
// The output the model sees also keeps `ERROR` lines, which name pytest errors and Maven summaries.
const shownFailureLine = (line: string): boolean =>
  isFailedTestLine(line) || /^\s*ERROR\b/.test(line);
const FAILED_TEST_LINES = 40;

/**
 * The output of a check as a tool result shows it to the model: whole up to `MODEL_OUTPUT_LIMIT`,
 * otherwise its start, the lines naming failed tests and its end. Bench round 17 (expenses-py
 * T007): a failing pytest printed a 2 MB diff of a generated CSV, the tool result carried all of
 * it, and the codex app-server rejected the next call (`input_too_large`) twice. The full output
 * stays in the check's evidence.
 */
export function modelCheckOutput(
  output: string,
  evidenceId?: string,
): { output: string; truncated?: true; outputChars?: number } {
  if (output.length <= MODEL_OUTPUT_LIMIT) return { output };
  const middle = output.slice(OUTPUT_HEAD, output.length - OUTPUT_TAIL);
  const failed = [
    ...new Set(
      middle
        .split("\n")
        .filter((line) => shownFailureLine(line))
        .map((line) => line.trimEnd().slice(0, 300)),
    ),
  ].slice(0, FAILED_TEST_LINES);
  const where = evidenceId ? ` The full output is in evidence ${evidenceId}.` : "";
  return {
    output: [
      output.slice(0, OUTPUT_HEAD),
      `\n[... ${String(middle.length)} characters of output left out.${where}${failed.length ? " Lines naming failed tests in that part:" : ""}]`,
      ...failed,
      "[...]\n",
      output.slice(output.length - OUTPUT_TAIL),
    ].join("\n"),
    truncated: true,
    outputChars: output.length,
  };
}

/** Whether the output of a check that timed out names a failed test before it stopped. */
export function timedOutFailure(output: string): boolean {
  return output.split("\n").some(isFailedTestLine);
}

export class CheckRunner {
  constructor(
    private store: WorkflowStore,
    private processes: ProcessScope,
  ) {}
  /**
   * Records a check as failed without running it, for a precondition the host checked itself
   * (for example a promoted test whose file no longer has its pinned hash).
   */
  async refuse(
    runId: string,
    attemptId: string,
    check: Check,
    reason: string,
    message: string,
    root: string = this.store.workspace,
  ): Promise<{
    status: "failed";
    evidenceId: string;
    snapshotId: string;
    output: string;
  }> {
    const generated = generatedPaths(JSON.parse(this.store.run(runId).policy_json) as RunPolicy);
    const files = await sourceManifest(root, generated);
    const evidence = this.store.transaction(() => {
      const snapshot = this.store.putSnapshot(runId, files);
      const artifact = this.store.artifact(
        runId,
        "check",
        `checks/${check.id}/refused-${attemptId}.json`,
        canonical({
          definition: check,
          definitionHash: hashJson(check),
          beforeHash: snapshot.hash,
          afterHash: snapshot.hash,
          reason,
          exitCode: null,
          output: message,
          durationMs: 0,
        }),
      );
      const id = this.store.addEvidence(runId, "command", snapshot.id, artifact.id, attemptId);
      this.store.checkResult(runId, check.id, id, "failed", null, reason, 0);
      return { id, snapshotId: snapshot.id };
    });
    return {
      status: "failed",
      evidenceId: evidence.id,
      snapshotId: evidence.snapshotId,
      output: message,
    };
  }
  /**
   * Runs a check's command once and records nothing: the polls of a wait stage. Only the run that
   * decides the stage goes through `run`, so hours of polling leave one evidence per gate.
   */
  async probe(
    runId: string,
    check: Check,
    signal: AbortSignal,
    root: string,
    timeoutMs: number,
  ): Promise<"passed" | "failed" | "inconclusive"> {
    const policy = JSON.parse(this.store.run(runId).policy_json) as RunPolicy;
    return (
      await this.measure(
        check,
        signal,
        root,
        runSandbox(policy, root, { gitWrite: root !== this.store.workspace }),
        timeoutMs,
      )
    ).status;
  }
  /** Like `probe`, and also returns the output: a baseline count records no evidence either. */
  async measure(
    check: Check,
    signal: AbortSignal,
    root: string,
    sandbox: SandboxRequest | null,
    timeoutMs: number = check.timeoutMs,
  ): Promise<{
    status: "passed" | "failed" | "inconclusive";
    output: string;
    truncated: boolean;
    /** The recorded timeout when the command ran out of time (#2358). */
    timeout?: CommandTimeout;
  }> {
    try {
      const executable = check.executable === "bun" ? process.execPath : check.executable;
      const limit = Math.min(check.timeoutMs, timeoutMs);
      const result = await executeCheckCommand(this.processes, executable, check.args, {
        cwd: check.cwd === "." ? root : workspacePath(root, check.cwd),
        env: buildCheckEnv(check),
        timeoutMs: limit,
        signal,
        sandbox,
      });
      const status =
        result.timedOut || result.cancelled || result.exitCode === null
          ? "inconclusive"
          : exitStatus(check, result.exitCode, result.output);
      // A baseline or poll that ran out of time names the command and its files (#2358).
      if (result.timedOut && !result.cancelled && !signal.aborted) {
        const timeout = recordCommandTimeout({
          source: "measure",
          command: [check.executable, ...check.args],
          files: fileArgs(check.args),
          root,
          timeoutMs: limit,
        });
        return {
          status,
          output: `${result.output}\n\nNote: ${check.id}: ${timeout.note}.`,
          truncated: result.truncated,
          timeout,
        };
      }
      return { status, output: result.output, truncated: result.truncated };
    } catch {
      return { status: "inconclusive", output: "", truncated: false };
    }
  }
  async run(
    runId: string,
    attemptId: string,
    check: Check,
    signal: AbortSignal,
    root: string = this.store.workspace,
  ): Promise<{
    status: "passed" | "failed" | "inconclusive";
    evidenceId: string;
    snapshotId: string;
    output: string;
    /** Why the status is what it is: `exit`, `spawn_error`, `timeout`, `cancelled`, `source_changed`, `environment_broken`. */
    reason: string;
  }> {
    const policy = JSON.parse(this.store.run(runId).policy_json) as RunPolicy;
    const generated = generatedPaths(policy);
    for (const path of check.writes) workspacePath(root, path);
    const before = await sourceManifest(root, generated, signal);
    const snapshot = this.store.transaction(() => this.store.putSnapshot(runId, before));
    const effectId = this.store.transaction(() =>
      this.store.prepareEffect(
        runId,
        attemptId,
        "command",
        // A check in a worktree names its root, like file effects, so recovery knows where it ran.
        {
          checkId: check.id,
          definitionHash: hashJson(check),
          ...rootField(this.store.workspace, root),
        },
        null,
        null,
      ),
    );
    let reason = "exit";
    const execute = async (): Promise<ProcessResult> => {
      try {
        const env = buildCheckEnv(check);
        const executable = check.executable === "bun" ? process.execPath : check.executable;
        return await executeCheckCommand(this.processes, executable, check.args, {
          cwd: check.cwd === "." ? root : workspacePath(root, check.cwd),
          env,
          timeoutMs: check.timeoutMs,
          signal,
          onSpawn: (pid, scope) =>
            this.store.transaction(() => this.store.recordProcess(runId, effectId, pid, scope)),
          sandbox: runSandbox(policy, root, {
            gitWrite: root !== this.store.workspace,
          }),
        });
      } catch (error) {
        reason = error instanceof SandboxUnavailableError ? "sandbox_unavailable" : "spawn_error";
        return {
          exitCode: null,
          signal: null,
          output: error instanceof Error ? error.message : String(error),
          timedOut: false,
          cancelled: signal.aborted,
          truncated: false,
          durationMs: 0,
          ...(error instanceof SandboxUnavailableError && policy.sandbox
            ? {
                sandbox: {
                  backend: "none" as const,
                  mode: policy.sandbox,
                  network: false,
                  reason: error.reason,
                },
              }
            : {}),
        };
      }
    };
    // The first run of a check in a run builds the toolchain's cache (Go's GOCACHE, cargo's
    // target, a Gradle daemon): on a cold Windows runner `go test` of one new file took 60 s to
    // compile and ran in 5.6 s again, and the timeout sent a finished task back to its worker
    // (#2162). A written-tests check that timed out without a result is therefore run once more
    // when it has no earlier result in the run; a file that never ends times out again and fails.
    const earlier = this.store.checks(runId).filter((c) => c.check_id === check.id);
    const firstRun = !earlier.length;
    let result = await execute();
    if (
      firstRun &&
      result.timedOut &&
      check.onTimeout === "failed" &&
      !result.cancelled &&
      !signal.aborted &&
      !timedOutFailure(result.output)
    ) {
      const cold = result.durationMs;
      result = await execute();
      if (!result.timedOut)
        result = {
          ...result,
          output: `${result.output}\n\nNote: ${check.id} timed out after ${String(cold)} ms on its first run in this run, which also builds the toolchain's cache, and was run once more.`,
        };
    }
    // The test setup turns this on in CI, so a check that is slow only on one runner shows in the log (#1177).
    if (process.env.BAKED_TRACE_RUN_BLOCKS === "1" && result.durationMs > 3000)
      process.stderr.write(
        `[slow-check] ${check.id} ${result.durationMs}ms exit=${result.exitCode} timedOut=${result.timedOut} ${result.output.slice(0, 300)}\n`,
      );
    const vacuous = result.exitCode === 0 && ranNoTests(check, result.output);
    const unselected = unselectedTests(check, result.exitCode, result.output);
    const unselectedMode = unselected ? stopMode(policy, "written_tests_unselected") : null;
    if (unselected && unselectedMode && unselectedMode !== "enforce")
      recordWouldStop(this.store, runId, {
        reason: "written_tests_unselected",
        mode: unselectedMode,
        key: `${check.id}-${hashJson(check.args).slice(0, 16)}`,
        summary: `${check.id} ran no test of the classes its files declare (${unselected.declared.join(", ")}) under ${unselected.command}: the host's selection selected none, and the check would fail as the host's, not the task's`,
        inputs: { ...unselected },
      });
    const listed = result.exitCode === 0 && exitStatus(check, 0, result.output) === "failed";
    const note = vacuous
      ? noTestsNote(check)
      : listed
        ? listedNote(check)
        : passedOutputNote(result.output, result.exitCode);
    if (note) result = { ...result, output: `${result.output}\n\n${note}` };
    const after = await sourceManifest(root, generated);
    const unstable = changedPaths(before, after).length > 0;
    let status: "passed" | "failed" | "inconclusive" =
      unstable || result.timedOut || result.cancelled || result.exitCode === null
        ? "inconclusive"
        : listed
          ? "failed"
          : result.exitCode === 0
            ? "passed"
            : "failed";
    if (unstable) reason = "source_changed";
    else if (result.timedOut && timedOutFailure(result.output)) {
      // A test failed before the run hung (url-shortener aa8fbd5d, #1271): the failure is real, so
      // it repairs like any failed check instead of ending the run as inconclusive.
      status = "failed";
      reason = "timeout_after_failure";
      result = {
        ...result,
        output: `${result.output}\n\nNote: ${check.id} timed out after ${check.timeoutMs} ms, after the failure above. Run the failing test file alone first and fix what keeps it from finishing (an unbounded loop, an open handle, a pending promise) together with the failure.`,
      };
    } else if (result.timedOut && check.onTimeout === "failed" && !result.cancelled) {
      // The test files a task wrote ran past the timeout without printing a result
      // (url-shortener f1648a92: one synchronous loop of about 10k file-database transactions,
      // #1308). They are the task's own work, so the timeout repairs like a failure.
      status = "failed";
      reason = "timeout_no_result";
      result = {
        ...result,
        output: `${result.output}\n\nNote: ${check.id} ran ${
          check.args.filter((arg) => /[/\\]|\.\w+$/.test(arg)).join(" ") || check.args.join(" ")
        } and did not finish within ${check.timeoutMs} ms, without printing a test result. These tests are too slow or never end. ${timeoutAdvice(check)}`,
      };
    } else if (result.timedOut && !result.cancelled && !signal.aborted) {
      // A formatter or linter is deterministic: a hang on files it passed earlier in the run, or
      // one a run on each written file alone pins to a file, is the run's own work (#2240: rustfmt
      // never finished on a 20-deep nested literal, and the inconclusive check blocked the run
      // with nothing to repair). Without either it stays inconclusive (a cold toolchain, #1177).
      const passed = earlier.some((c) => c.status === "passed");
      const hanging = await this.hangingFile(
        runId,
        check,
        root,
        signal,
        runSandbox(policy, root, { gitWrite: root !== this.store.workspace }),
      );
      if (passed || hanging) {
        status = "failed";
        reason = "timeout_slow";
        result = { ...result, output: `${result.output}\n\n${timeoutSlowNote(check, hanging)}` };
      } else reason = "timeout";
    } else if (result.timedOut) reason = "timeout";
    else if (result.cancelled) reason = "cancelled";
    else if (check.report === "json" && reason === "exit") {
      const report = readGateReport(result.output);
      // A passing report from a command that exited nonzero contradicts itself; neither is trusted.
      const contradicts = report?.status === "passed" && result.exitCode !== 0;
      status = report && !contradicts ? report.status : "inconclusive";
      reason = !report ? "no_report" : contradicts ? "report_exit_mismatch" : "report";
      result = {
        ...result,
        output: `${result.output}\n\n${report ? renderGateReport(report) : MISSING_GATE_REPORT}`,
      };
    }
    // A failure the machine causes (the JDK's loopback pipe on a short Windows TEMP, #2273) says
    // nothing about the code: inconclusive, so no correction is opened for correct code.
    const environment =
      status === "failed" && reason === "exit"
        ? environmentFault(check.executable, check.args, result.output)
        : null;
    // So is one in a worktree whose packages its prepare command could not resolve (#2372).
    const unprepared =
      status === "failed" && reason === "exit" && !environment
        ? unpreparedNote(check.id, root, this.store.workspace, check.executable, check.args)
        : null;
    if (environment || unprepared) {
      status = "inconclusive";
      reason = "environment_broken";
      result = {
        ...result,
        output: `${result.output}\n\n${environment ? environmentNote(check.id, environment) : unprepared}`,
      };
    }
    // After the chain, so a JSON gate's report is still read when its log mentions a test that
    // timed out (#1426).
    const perTest = status === "failed" && !result.timedOut ? perTestTimeout(result.output) : null;
    if (perTest !== null)
      result = {
        ...result,
        output: `${result.output}\n\n${perTestTimeoutNote(perTest)}`,
      };
    // `output` already holds stdout and stderr interleaved; storing them again tripled a 2 MB
    // pytest diff in one artifact (#993).
    const { stdout: _stdout, stderr: _stderr, ...recorded } = result;
    const evidenceId = this.store.transaction(() => {
      this.store.effectStatus(runId, effectId, "reconciled");
      const artifact = this.store.artifact(
        runId,
        "check",
        `checks/${check.id}/${effectId}.json`,
        canonical({
          definition: check,
          definitionHash: hashJson(check),
          beforeHash: snapshot.hash,
          afterHash: hashJson(after),
          reason,
          ...recorded,
        }),
      );
      const evidence = this.store.addEvidence(
        runId,
        "command",
        snapshot.id,
        artifact.id,
        attemptId,
      );
      this.store.checkResult(
        runId,
        check.id,
        evidence,
        status,
        result.exitCode,
        reason,
        result.durationMs,
      );
      if (unstable) this.store.invalidateEvidence(runId, snapshot.id, "source_changed");
      return evidence;
    });
    return {
      status,
      evidenceId,
      snapshotId: snapshot.id,
      output: result.output,
      reason,
    };
  }
  /**
   * The first file the run wrote that the check's formatter, run on that file alone, does not
   * finish within `BISECT_FILE_MS` (or the check's own timeout, when shorter): the largest
   * `BISECT_FILES` code files of the check's language under its directory, one at a time. Null for
   * a check with no file-scoped form (`fileScopedFormat`) or when every file finishes.
   */
  private async hangingFile(
    runId: string,
    check: Check,
    root: string,
    signal: AbortSignal,
    sandbox: SandboxRequest | null,
  ): Promise<string | null> {
    // Loaded here: format-written reaches gate detection, which imports this module.
    const { fileScopedFormat } = await import("../workflows/format-written.js");
    const dir = check.cwd === "." ? root : workspacePath(root, check.cwd);
    const prefix = check.cwd === "." ? "" : `${check.cwd.replace(/\\/g, "/").replace(/\/$/, "")}/`;
    let tasks: { writes: { path: string; action: string }[] }[] = [];
    try {
      tasks = this.store.state(runId).graph?.tasks ?? [];
    } catch {
      return null;
    }
    const paths = [
      ...new Set(
        tasks.flatMap((t) =>
          t.writes.filter((w) => w.action !== "delete").map((w) => w.path.replace(/\\/g, "/")),
        ),
      ),
    ].filter((path) => path.startsWith(prefix));
    // The edit tools saw the formatter time out on one of them: name it without a bisect (#2242).
    const { formatTimeoutsUnder } = await import("../tools/auto-format.js");
    const known = new Set([
      ...formatTimeoutsUnder(root).keys(),
      // A task edits in its own worktree, `.baked/worktrees/<run>/<task>/`.
      ...[
        ...formatTimeoutsUnder(join(this.store.workspace, ".baked", "worktrees", runId)).keys(),
      ].map((path) => path.slice(path.indexOf("/") + 1)),
    ]);
    const hung = paths.find(
      (path) => known.has(path) && fileScopedFormat(check, dir, path.slice(prefix.length)),
    );
    if (hung) return hung;
    const written = paths
      .map((path) => {
        const local = path.slice(prefix.length);
        const command = fileScopedFormat(check, dir, local);
        const size = command
          ? (statSync(join(dir, local), { throwIfNoEntry: false })?.size ?? 0)
          : 0;
        return { path, command, size };
      })
      .filter((file) => file.command && file.size > 0)
      .sort((a, b) => b.size - a.size)
      .slice(0, BISECT_FILES);
    for (const file of written) {
      if (signal.aborted || !file.command) return null;
      const executable =
        file.command.executable === "bun" ? process.execPath : file.command.executable;
      try {
        const alone = await executeCheckCommand(this.processes, executable, file.command.args, {
          cwd: dir,
          env: buildCheckEnv(check),
          timeoutMs: Math.min(BISECT_FILE_MS, check.timeoutMs),
          signal,
          sandbox,
        });
        if (alone.timedOut && !alone.cancelled) return file.path;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** How many written files a timed-out formatter is run on alone, and how long each may take. */
const BISECT_FILES = 5;
const BISECT_FILE_MS = 20_000;

/** What a check that timed out on the run's own work should change (#2240). */
export function timeoutSlowNote(check: Check, hanging: string | null): string {
  const timeout = `${check.id} did not finish within ${String(check.timeoutMs)} ms`;
  if (hanging)
    return `Note: ${timeout}. Run on each file the run wrote alone, the formatter does not finish on ${hanging} either: the tool hangs on its content (rustfmt on a data literal of deeply nested macro or tuple arguments). Restructure that code (build the nested value in steps, or a helper per level), or put the tool's skip marker on the item (\`#[rustfmt::skip]\` on the function in Rust); the fixer is not run on it.`;
  return `Note: ${timeout}, although it passed earlier in this run. A file the run changed since makes the tool run far longer or never end: run the check's command on the files changed since its last pass, one at a time, and simplify the one it does not finish on.`;
}

/**
 * What a test file that ran past its timeout should change. With a required number of generated
 * inputs it keeps that number and makes each case cheap: "tens" there made a corrective cut the
 * cases below what the plan and the review require (#1367).
 */
const PER_TEST_TIMEOUT =
  /\btimed out after (\d+)\s?ms\b|\bExceeded timeout of (\d+)\s?ms for a test\b|\bTest timed out in (\d+)\s?ms\b/i;

/** The per-test limit a bun, jest or vitest timeout line in `output` names, or null. */
export function perTestTimeout(output: string): number | null {
  const match = PER_TEST_TIMEOUT.exec(output);
  const ms = match?.slice(1).find((value) => value !== undefined);
  return ms === undefined ? null : Number(ms);
}

/**
 * Names the runner's per-test limit next to its timeout line. md-site 095b7b11 (bench round 38,
 * #1385) hit bun's default 5000 ms per test twice although the check allowed 60 s, and the one
 * web search of the round looked up how to raise it.
 */
export function perTestTimeoutNote(ms: number): string {
  return `Note: a test ran into the test runner's own per-test limit of ${String(ms)} ms, which is separate from the check's timeout. Make each case cheaper so the test fits; when one test really needs longer, give that test its own limit (the third argument of \`test(name, fn, ms)\` in bun, jest and vitest) instead of cutting the cases the task requires.`;
}

function timeoutAdvice(check: Check): string {
  if (check.minCases === undefined)
    return "Run the file alone with run_probe and time it; keep generated samples to a representative few cases (tens, not the whole accepted domain the spec allows), avoid one long synchronous loop, and keep each test to a few seconds.";
  const n = String(check.minCases);
  return `The task requires at least ${n} generated inputs: do not reduce that number. Make each case cheap so ${n} cases fit in ${String(check.timeoutMs)} ms: one in-memory store or one temporary directory set up once and reused across the cases, no process, server or new file per case, and no sleeps. Run the file alone with run_probe, time it, and divide by the cases to see the cost of one.`;
}
