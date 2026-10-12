import { buildSafeEnv } from "../spawn.js";
import { canonical, hashJson } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { rootField } from "../workflows/effects.js";
import type { ProcessResult, ProcessScope } from "../workflows/process-scope.js";
import { generatedPaths, type RunPolicy } from "../workflows/schemas.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { Check } from "../workflows/types.js";
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
  }> {
    const generated = generatedPaths(JSON.parse(this.store.run(runId).policy_json) as RunPolicy);
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
      });
    } catch (error) {
      reason = "spawn_error";
      result = {
        exitCode: null,
        signal: null,
        output: error instanceof Error ? error.message : String(error),
        timedOut: false,
        cancelled: signal.aborted,
        truncated: false,
        durationMs: 0,
      };
    }
    const note = passedOutputNote(result.output, result.exitCode);
    if (note) result = { ...result, output: `${result.output}\n\n${note}` };
    const after = await sourceManifest(root, generated);
    const unstable = changedPaths(before, after).length > 0;
    let status: "passed" | "failed" | "inconclusive" =
      unstable || result.timedOut || result.cancelled || result.exitCode === null
        ? "inconclusive"
        : result.exitCode === 0
          ? "passed"
          : "failed";
    if (unstable) reason = "source_changed";
    else if (result.timedOut) reason = "timeout";
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
          ...result,
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
    return { status, evidenceId, snapshotId: snapshot.id, output: result.output };
  }
}
