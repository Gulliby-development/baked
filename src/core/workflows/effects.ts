import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { hashBytes } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { writeViaTemp } from "./atomic-write.js";
import { WorkflowFault } from "./errors.js";
import { mutationLeaseFor, type WorkspaceLeases } from "./leases.js";
import type { WorkflowStore } from "./store.js";

/** The file part of an effect intent. `root` is absent for the project root. */
export interface FileIntent {
  path: string;
  /** Directory the path is relative to, itself relative to the project root (a run worktree). */
  root?: string;
}
/** The intent field that binds an effect to `root`; nothing for the project root. */
export function rootField(workspace: string, root: string): { root?: string } {
  const path = relative(workspace, root).replaceAll("\\", "/");
  return path === "" ? {} : { root: path };
}
/** The root an effect intent names, relative to the project root; "" for the project root. */
export function intentRoot(intentJson: string): string {
  return (JSON.parse(intentJson) as { root?: string }).root ?? "";
}
/** Where a run reads and writes, relative to the project root: its worktree, or "" inline. */
export function runRootPath(store: WorkflowStore, runId: string): string {
  return store.state(runId).worktree?.path ?? "";
}
/**
 * The absolute file an effect touched: its path under its own root. An effect is never resolved
 * against another root, so a record without `root` always means the project root.
 */
export function effectFile(workspace: string, intentJson: string): string {
  const intent = JSON.parse(intentJson) as FileIntent;
  return workspacePath(intent.root ? join(workspace, intent.root) : workspace, intent.path);
}

export function fileHash(path: string): string | null {
  return existsSync(path) ? hashBytes(readFileSync(path)) : null;
}
export class EffectJournal {
  constructor(
    private store: WorkflowStore,
    private leases: WorkspaceLeases,
  ) {}
  publish(
    runId: string,
    attemptId: string,
    relativePath: string,
    content: string | null,
    expected: string | null,
    kind: "file_patch" | "artifact_write" = "artifact_write",
    root: string = this.store.workspace,
  ): string {
    const lease = mutationLeaseFor(this.store.workspace, root);
    this.leases.assert(lease);
    const path = workspacePath(root, relativePath);
    if (fileHash(path) !== expected)
      throw new WorkflowFault("INPUT_CHANGED", `File changed before publication: ${relativePath}`);
    const after = content === null ? null : hashBytes(content);
    const id = this.store.transaction(() =>
      this.store.prepareEffect(
        runId,
        attemptId,
        kind,
        { path: relativePath, ...rootField(this.store.workspace, root) },
        expected,
        after,
      ),
    );
    try {
      this.leases.assert(lease);
      if (fileHash(path) !== expected)
        throw new WorkflowFault(
          "INPUT_CHANGED",
          `File changed during publication: ${relativePath}`,
        );
      if (content === null) {
        if (existsSync(path)) unlinkSync(path);
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeViaTemp(path, content, { flag: "wx", flush: true });
      }
      this.store.transaction(() => this.store.effectStatus(runId, id, "applied"));
    } catch (error) {
      this.store.transaction(() => this.store.effectStatus(runId, id, "unknown"));
      throw error;
    }
    return id;
  }
  reconcile(runId: string): string[] {
    const unknown: string[] = [];
    for (const effect of this.store.effects(runId)) {
      // Delivery effects live outside the workspace; delivery probes and reconciles them itself.
      if (effect.kind === "delivery") continue;
      if (effect.status !== "prepared" && effect.status !== "unknown") continue;
      if (effect.kind === "command") {
        unknown.push(effect.id);
        continue;
      }
      let current: string | null;
      try {
        current = fileHash(effectFile(this.store.workspace, effect.intent_json));
      } catch {
        // The effect's own root is gone (a removed worktree): its outcome cannot be observed.
        this.store.transaction(() => this.store.effectStatus(runId, effect.id, "unknown"));
        unknown.push(effect.id);
        continue;
      }
      const status =
        current === effect.after_hash
          ? "reconciled"
          : current === effect.before_hash
            ? "failed"
            : "unknown";
      this.store.transaction(() => this.store.effectStatus(runId, effect.id, status));
      if (status === "unknown") unknown.push(effect.id);
    }
    return unknown;
  }
}
