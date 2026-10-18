import { runSandbox, type SandboxRequest, SandboxUnavailableError } from "../security/sandbox.js";
import { buildSafeEnv } from "../spawn.js";
import { canonical, hashJson } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { rootField } from "../workflows/effects.js";
import { launchedCommand } from "../workflows/launcher.js";
import type { ProcessResult, ProcessScope } from "../workflows/process-scope.js";
import { generatedPaths, type RunPolicy } from "../workflows/schemas.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { Check } from "../workflows/types.js";
import { isFailedTestLine } from "./failed-test-line.js";
import { MISSING_GATE_REPORT, readGateReport, renderGateReport } from "./gate-report.js";
import { changedPaths, sourceManifest } from "./snapshot.js";

/** Shared process execution for native checks and the legacy project formatter. */
export const executeCheckCommand = (
  scope: ProcessScope,
  ...args: Parameters<ProcessScope["execute"]>
): Promise<ProcessResult> => scope.execute(...args);

/** The environment every check and on-demand gate run gets: safe base plus the names it declares. */
export function buildCheckEnv(check: Check): NodeJS.ProcessEnv {
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
  const { program, args } = launchedCommand(check.executable, check.args);
  return program === "gofmt" && args.includes("-l");
}

/** The status of a check's finished command: its exit code, and the files a listing check names. */
export function exitStatus(
  check: Pick<Check, "executable" | "args">,
  exitCode: number,
  output: string,
): "passed" | "failed" {
  return exitCode === 0 && !(listsFailures(check) && output.trim()) ? "passed" : "failed";
}

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
  ): Promise<{ status: "failed"; evidenceId: string; snapshotId: string; output: string }> {
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
  ): Promise<{ status: "passed" | "failed" | "inconclusive"; output: string; truncated: boolean }> {
    try {
      const executable = check.executable === "bun" ? process.execPath : check.executable;
      const result = await executeCheckCommand(this.processes, executable, check.args, {
        cwd: check.cwd === "." ? root : workspacePath(root, check.cwd),
        env: buildCheckEnv(check),
        timeoutMs: Math.min(check.timeoutMs, timeoutMs),
        signal,
        sandbox,
      });
      const status =
        result.timedOut || result.cancelled || result.exitCode === null
          ? "inconclusive"
          : exitStatus(check, result.exitCode, result.output);
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
    /** Why the status is what it is: `exit`, `spawn_error`, `timeout`, `cancelled`, `source_changed`. */
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
    let result: ProcessResult;
    let reason = "exit";
    try {
      const env = buildCheckEnv(check);
      const executable = check.executable === "bun" ? process.execPath : check.executable;
      result = await executeCheckCommand(this.processes, executable, check.args, {
        cwd: check.cwd === "." ? root : workspacePath(root, check.cwd),
        env,
        timeoutMs: check.timeoutMs,
        signal,
        onSpawn: (pid, scope) =>
          this.store.transaction(() => this.store.recordProcess(runId, effectId, pid, scope)),
        sandbox: runSandbox(policy, root, { gitWrite: root !== this.store.workspace }),
      });
    } catch (error) {
      reason = error instanceof SandboxUnavailableError ? "sandbox_unavailable" : "spawn_error";
      result = {
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
    // The test setup turns this on in CI, so a check that is slow only on one runner shows in the log (#1177).
    if (process.env.BAKED_TRACE_RUN_BLOCKS === "1" && result.durationMs > 3000)
      process.stderr.write(
        `[slow-check] ${check.id} ${result.durationMs}ms exit=${result.exitCode} timedOut=${result.timedOut} ${result.output.slice(0, 300)}\n`,
      );
    const listed = result.exitCode === 0 && exitStatus(check, 0, result.output) === "failed";
    const note = listed ? listedNote(check) : passedOutputNote(result.output, result.exitCode);
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
    // After the chain, so a JSON gate's report is still read when its log mentions a test that
    // timed out (#1426).
    const perTest = status === "failed" && !result.timedOut ? perTestTimeout(result.output) : null;
    if (perTest !== null)
      result = { ...result, output: `${result.output}\n\n${perTestTimeoutNote(perTest)}` };
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
    return { status, evidenceId, snapshotId: snapshot.id, output: result.output, reason };
  }
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
