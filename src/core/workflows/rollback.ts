import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, hashBytes } from "../specs/hash.js";
import { writeViaTemp } from "./atomic-write.js";
import { effectFile, fileHash, intentRoot, runRootPath } from "./effects.js";
import { WorkflowFault } from "./errors.js";
import { mutationLeaseFor, type WorkspaceLeases } from "./leases.js";
import { type EffectRow, newId, type WorkflowStore } from "./store.js";

/*
 * A run keeps its executed edits: a revision, a failed or interrupted attempt and a fork leave
 * the files as they are, and the runtime treats content the run itself wrote as its own (plan
 * consistency, create targets, the workspace check). Undo is an explicit request. It is possible
 * because every task edit stores the pre-image of the file it changes, and it restores a file
 * only while the file still holds exactly what the run wrote last.
 */

/** Artifact kind of the durable record of one rollback. */
export const ROLLBACK_ARTIFACT_KIND = "workspace-rollback";
const PRE_IMAGES = "pre-images";
const ROLLED_BACK = "rolled-back";

export interface RollbackReport {
  reason: string;
  /** Edits this rollback settled: restored, already undone, or left in place for good. */
  effectIds: string[];
  restored: { path: string; from: string | null; to: string | null; keptAs: string | null }[];
  kept: { path: string; reason: string }[];
}

const pathOf = (effect: EffectRow): string =>
  (JSON.parse(effect.intent_json) as { path: string }).path;
const isRollback = (effect: EffectRow): boolean =>
  (JSON.parse(effect.intent_json) as { tool?: string }).tool === "rollback";

/** Artifacts are text; content that is not valid UTF-8 is kept as base64 under a marked path. */
function encode(bytes: Uint8Array): { suffix: string; content: string } {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("utf8");
  return Buffer.from(text, "utf8").equals(buffer)
    ? { suffix: "", content: text }
    : { suffix: ".base64", content: buffer.toString("base64") };
}

/** Stores file content once per run and hash; null when the artifact caps do not allow it. */
function keepContent(
  store: WorkflowStore,
  runId: string,
  kind: string,
  bytes: Uint8Array,
): string | null {
  const hash = hashBytes(bytes);
  const existing =
    store.latestArtifact(runId, `${kind}/${hash}`) ??
    store.latestArtifact(runId, `${kind}/${hash}.base64`);
  if (existing) return existing.id;
  const { suffix, content } = encode(bytes);
  try {
    return store.artifact(runId, kind, `${kind}/${hash}${suffix}`, content).id;
  } catch (error) {
    if (error instanceof WorkflowFault && error.code === "BUDGET_EXHAUSTED") return null;
    throw error;
  }
}

/** The content a run kept for a file hash before its edit overwrote it, or null when not kept. */
export function readKept(store: WorkflowStore, runId: string, hash: string): Buffer | null {
  for (const suffix of ["", ".base64"]) {
    const row = store.latestArtifact(runId, `${PRE_IMAGES}/${hash}${suffix}`);
    if (!row) continue;
    try {
      const text = store.readArtifact(runId, row.id);
      const bytes = suffix ? Buffer.from(text, "base64") : Buffer.from(text, "utf8");
      // A redacted pre-image keeps only a tombstone; it can no longer restore the file.
      if (hashBytes(bytes) === hash) return bytes;
    } catch {
      // The pre-image blob is missing; report the file as not restorable.
    }
  }
  return null;
}

/**
 * Keeps the content a task edit is about to overwrite or delete, so the run can undo its own
 * edit later. Call it in the transaction that prepares the effect, and use the returned hash as
 * the effect's before hash. Content above the artifact caps is not kept; a later rollback then
 * reports the file instead of restoring it.
 */
export function capturePreImage(
  store: WorkflowStore,
  runId: string,
  absolute: string,
): string | null {
  if (!existsSync(absolute)) return null;
  const bytes = readFileSync(absolute);
  keepContent(store, runId, PRE_IMAGES, bytes);
  return hashBytes(bytes);
}

/** The hash a path has after these edits, or undefined when one of them has an unknown outcome. */
function hashAfter(edits: EffectRow[], start: string | null): string | null | undefined {
  let hash = start;
  for (const edit of edits) {
    if (edit.status === "applied" || edit.status === "reconciled") hash = edit.after_hash;
    else if (edit.status !== "failed") return undefined;
  }
  return hash;
}

function settledEffects(store: WorkflowStore, runId: string): Set<string> {
  const settled = new Set<string>();
  for (const artifact of store.artifacts(runId))
    if (artifact.kind === ROLLBACK_ARTIFACT_KIND)
      for (const id of (JSON.parse(store.readArtifact(runId, artifact.id)) as RollbackReport)
        .effectIds)
        settled.add(id);
  return settled;
}

/**
 * Task file edits, a check fixer's included, that never became part of the run's baseline. A task's edits join the baseline
 * when the runtime snapshots them (the task row then has a snapshot). Edits of a task that is
 * running, failed to implement, was invalidated by a revision, recovery or repair, or was
 * dropped by a revision have no snapshot.
 */
export function uncommittedEdits(
  store: WorkflowStore,
  runId: string,
  taskId?: string,
): EffectRow[] {
  const settled = settledEffects(store, runId);
  const stepOf = new Map(store.attempts(runId).map((a) => [a.id, a.step_id]));
  const stageOf = new Map(store.steps(runId).map((s) => [s.id, s.stage_id]));
  const tasks = new Map(store.tasks(runId).map((t) => [t.id, t]));
  return store.effects(runId).filter((effect) => {
    if (effect.kind !== "file_patch" || settled.has(effect.id) || isRollback(effect)) return false;
    const stage = stageOf.get(stepOf.get(effect.attempt_id) ?? "") ?? "";
    // A check fixer's edit at run level belongs to the task that writes the file.
    const intent = JSON.parse(effect.intent_json) as { tool?: string; taskId?: string };
    const task = stage.startsWith("task-")
      ? tasks.get(stage.slice("task-".length))
      : intent.tool === "apply_fix" && intent.taskId
        ? tasks.get(intent.taskId)
        : undefined;
    return (
      task !== undefined &&
      task.snapshot_id === null &&
      (taskId === undefined || task.id === taskId)
    );
  });
}

/**
 * Undoes the run's uncommitted task edits, or those of the given paths, on an explicit request.
 * The caller holds the run's execution and mutation leases. The expected workspace baseline moves
 * with every restored path, so the workspace check accepts the restored files.
 */
export function undoRunEdits(
  store: WorkflowStore,
  leases: WorkspaceLeases,
  runId: string,
  paths: string[] = [],
): RollbackReport | null {
  const edits = uncommittedEdits(store, runId).filter(
    (edit) => paths.length === 0 || paths.includes(pathOf(edit)),
  );
  if (!edits.length) return null;
  const parent =
    store
      .steps(runId)
      .filter((s) => s.parent_step_id === null)
      .at(-1)?.id ?? null;
  const step = store.transaction(() => store.beginStep(runId, "undo", parent));
  const attempt = store.beginHostAttempt(runId, step);
  let report: RollbackReport | null = null;
  try {
    report = rollbackEdits(store, leases, runId, attempt, edits, "undo");
    return report;
  } finally {
    const done = report;
    store.transaction(() => {
      store.finishAttempt(runId, attempt, done ? "completed" : "failed", 0);
      store.finishStep(runId, step, done ? "completed" : "failed");
      const state = store.state(runId);
      const files = state.expectedFiles;
      if (done && files) {
        for (const restored of done.restored)
          if (restored.to === null) delete files[restored.path];
          else if (restored.path in files) files[restored.path] = restored.to;
        store.saveState(runId, state);
      }
    });
  }
}

/**
 * The hash a path has after the run's last journaled write to it, or undefined when the run did
 * not write it or the outcome of one of its writes is unknown.
 */
export function runWrittenHash(
  store: WorkflowStore,
  runId: string,
  path: string,
): string | null | undefined {
  const root = runRootPath(store, runId);
  const edits = store
    .effects(runId)
    .filter(
      (e) => e.kind === "file_patch" && pathOf(e) === path && intentRoot(e.intent_json) === root,
    );
  if (!edits.length) return undefined;
  return hashAfter(edits, edits[0]?.before_hash ?? null);
}

/**
 * Restores every path these edits touched to the content it had before the first of them. A path
 * is restored only while it still holds exactly what the run wrote last; a later change by a
 * person or another tool is left in place and reported. The run's version is kept as an artifact
 * before it is replaced, each restore is journaled as a file effect, and the outcome is stored as
 * an immutable workspace-rollback artifact.
 */
export function rollbackEdits(
  store: WorkflowStore,
  leases: WorkspaceLeases,
  runId: string,
  attemptId: string,
  edits: EffectRow[],
  reason: string,
): RollbackReport | null {
  if (!edits.length) return null;
  // Edits are grouped by root and path: a restore never crosses into another root.
  const byPath = new Map<string, EffectRow[]>();
  for (const edit of edits) {
    const key = `${intentRoot(edit.intent_json)}\0${pathOf(edit)}`;
    byPath.set(key, [...(byPath.get(key) ?? []), edit]);
  }
  // A check fixer's output in one root reaches a task root rebuilt from it (#1269): there it is
  // the run's own content, not a change made outside the run.
  const fixed = new Map<string, Set<string | null>>();
  for (const edit of edits)
    if (
      JSON.parse(edit.intent_json).tool === "apply_fix" &&
      (edit.status === "applied" || edit.status === "reconciled")
    )
      fixed.set(pathOf(edit), (fixed.get(pathOf(edit)) ?? new Set()).add(edit.after_hash));
  const report: RollbackReport = { reason, effectIds: [], restored: [], kept: [] };
  for (const pathEdits of byPath.values()) {
    const first = pathEdits[0];
    if (!first) continue;
    const path = pathOf(first);
    const root = intentRoot(first.intent_json);
    const ids = pathEdits.map((e) => e.id);
    const target = pathEdits[0]?.before_hash ?? null;
    const written = hashAfter(pathEdits, target);
    if (written === undefined) {
      // Not settled: the next rollback retries once recovery has decided the outcome.
      report.kept.push({
        path,
        reason: "an edit has an unknown outcome; resolve its recovery first",
      });
      continue;
    }
    let absolute: string;
    try {
      absolute = effectFile(store.workspace, first.intent_json);
    } catch {
      report.effectIds.push(...ids);
      report.kept.push({ path, reason: "the root it was written in no longer exists; left as is" });
      continue;
    }
    const lease = mutationLeaseFor(
      store.workspace,
      root ? join(store.workspace, root) : store.workspace,
    );
    const bytes = existsSync(absolute) ? readFileSync(absolute) : null;
    const current = bytes ? hashBytes(bytes) : null;
    if (current === target) {
      report.effectIds.push(...ids);
      continue;
    }
    if (current !== written && !fixed.get(path)?.has(current)) {
      report.effectIds.push(...ids);
      report.kept.push({ path, reason: "changed outside the run after its last edit; left as is" });
      continue;
    }
    const previous = target === null ? null : readKept(store, runId, target);
    if (target !== null && !previous) {
      report.effectIds.push(...ids);
      report.kept.push({ path, reason: "no saved copy of the previous content; left as is" });
      continue;
    }
    const keptAs = bytes
      ? store.transaction(() => keepContent(store, runId, ROLLED_BACK, bytes))
      : null;
    if (bytes && !keptAs) {
      report.effectIds.push(...ids);
      report.kept.push({ path, reason: "the run's version is too large to keep; left as is" });
      continue;
    }
    try {
      leases.assert(lease);
      const effectId = store.transaction(() =>
        store.prepareEffect(
          runId,
          attemptId,
          "file_patch",
          { path, ...(root ? { root } : {}), tool: "rollback", reason, reverts: ids },
          current,
          target,
        ),
      );
      try {
        leases.assert(lease);
        if (fileHash(absolute) !== current)
          throw new WorkflowFault("INPUT_CHANGED", `File changed during rollback: ${path}`);
        if (previous === null) unlinkSync(absolute);
        else {
          const mode = existsSync(absolute) ? statSync(absolute).mode : null;
          mkdirSync(dirname(absolute), { recursive: true });
          writeViaTemp(absolute, previous, { flag: "wx", flush: true });
          if (mode !== null) chmodSync(absolute, mode);
        }
        store.transaction(() => store.effectStatus(runId, effectId, "applied"));
      } catch (error) {
        store.transaction(() => store.effectStatus(runId, effectId, "unknown"));
        throw error;
      }
      report.effectIds.push(...ids);
      report.restored.push({ path, from: current, to: target, keptAs });
    } catch (error) {
      report.kept.push({
        path,
        reason: `restore failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  store.transaction(() =>
    store.artifact(runId, ROLLBACK_ARTIFACT_KIND, `rollbacks/${newId()}.json`, canonical(report)),
  );
  return report;
}

/**
 * True when the file exists only because this run, or a run it was forked from, created it and
 * nothing changed it since: the first journaled edit of the path found no file, and the file
 * still holds what the last edit wrote. Such a file does not make a planned create inconsistent.
 */
export function createdByRunLineage(
  store: WorkflowStore,
  runId: string,
  path: string,
  current: string | null,
): boolean {
  if (current === null) return false;
  const root = runRootPath(store, runId);
  const lineage: string[] = [];
  for (let id: string | null = runId; id && !lineage.includes(id); id = store.run(id).parent_run_id)
    lineage.unshift(id);
  // A prepared edit is the one in flight now (recovery reconciles older ones before a drive).
  const edits = lineage.flatMap((id) =>
    store
      .effects(id)
      .filter(
        (e) =>
          e.kind === "file_patch" &&
          e.status !== "prepared" &&
          pathOf(e) === path &&
          intentRoot(e.intent_json) === root,
      ),
  );
  if (!edits.length || edits[0]?.before_hash !== null) return false;
  return hashAfter(edits, null) === current;
}
