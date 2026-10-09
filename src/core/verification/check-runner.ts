import { buildSafeEnv } from "../spawn.js";
import { canonical, hashJson } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { rootField } from "../workflows/effects.js";
import type { ProcessResult, ProcessScope } from "../workflows/process-scope.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { Check } from "../workflows/types.js";
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
  if (process.platform === "win32") {
    const path = env.PATH ?? env.Path;
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    if (path) env.PATH = path;
  }
  return env;
}

export class CheckRunner {
  constructor(
    private store: WorkflowStore,
    private processes: ProcessScope,
  ) {}
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
    const generated = JSON.parse(this.store.run(runId).policy_json).checks.flatMap(
      (c: Check) => c.writes,
    ) as string[];
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
    const after = await sourceManifest(root, generated);
    const unstable = changedPaths(before, after).length > 0;
    const status =
      unstable || result.timedOut || result.cancelled || result.exitCode === null
        ? "inconclusive"
        : result.exitCode === 0
          ? "passed"
          : "failed";
    if (unstable) reason = "source_changed";
    else if (result.timedOut) reason = "timeout";
    else if (result.cancelled) reason = "cancelled";
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
