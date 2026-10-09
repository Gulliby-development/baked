import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { hashBytes } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { writeViaTemp } from "./atomic-write.js";
import { WorkflowFault } from "./errors.js";
import type { WorkspaceLeases } from "./leases.js";
import type { WorkflowStore } from "./store.js";

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
  ): string {
    this.leases.assert("mutation");
    const path = workspacePath(this.store.workspace, relativePath);
    if (fileHash(path) !== expected)
      throw new WorkflowFault("INPUT_CHANGED", `File changed before publication: ${relativePath}`);
    const after = content === null ? null : hashBytes(content);
    const id = this.store.transaction(() =>
      this.store.prepareEffect(runId, attemptId, kind, { path: relativePath }, expected, after),
    );
    try {
      this.leases.assert("mutation");
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
      if (effect.status !== "prepared" && effect.status !== "unknown") continue;
      if (effect.kind === "command") {
        unknown.push(effect.id);
        continue;
      }
      const intent = JSON.parse(effect.intent_json) as { path: string };
      const current = fileHash(workspacePath(this.store.workspace, intent.path));
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
