import { isAbsolute, relative } from "node:path";
import { workspacePath } from "../specs/validate.js";
import { fileHash } from "./effects.js";
import { WorkflowFault } from "./errors.js";
import type { WorkspaceLeases } from "./leases.js";
import { capturePreImage, createdByRunLineage } from "./rollback.js";
import type { AgentProfile, RunPolicy } from "./schemas.js";
import type { WorkflowStore } from "./store.js";
import type { Task } from "./types.js";

export const pureWorkflowTools = new Set(["read", "navigate", "bake_find", "bake_impact"]);
export class WorkflowToolPolicy {
  constructor(
    private store: WorkflowStore,
    private leases: WorkspaceLeases,
    private runId: string,
    private attemptId: string,
    private profile: AgentProfile,
    private policy: RunPolicy,
    private task?: Task,
    private root: string = store.workspace,
  ) {}
  path(value: string): string {
    const path = (isAbsolute(value) ? relative(this.root, value) : value).replaceAll("\\", "/");
    workspacePath(this.root, path);
    if (
      /^\.(baked|git)(\/|$)/i.test(path) ||
      /(^|\/)(\.env(?:\..*)?|credentials(?:\..*)?)$/i.test(path)
    )
      throw new WorkflowFault("CAPABILITY_DENIED", `Protected workflow path: ${path}`);
    return path;
  }
  validate(name: string, args: Record<string, unknown>): string | null {
    if (this.store.run(this.runId).status !== "running")
      throw new WorkflowFault("CAPABILITY_DENIED", "Run is not executing");
    if (!this.profile.allowedTools.includes(name) || !this.policy.allowedTools.includes(name))
      throw new WorkflowFault(
        "CAPABILITY_DENIED",
        `Tool ${name} is not allowed by profile and run policy`,
      );
    for (const field of ["path", "file", "from", "to"])
      if (typeof args[field] === "string") this.path(args[field]);
    if (Array.isArray(args.files))
      for (const file of args.files) {
        if (typeof file === "string") this.path(file);
        else if (
          file &&
          typeof file === "object" &&
          "path" in file &&
          typeof file.path === "string"
        )
          this.path(file.path);
      }
    if (pureWorkflowTools.has(name)) return null;
    if (
      !["edit_file", "multi_edit", "delete_file"].includes(name) ||
      this.profile.role !== "implementer" ||
      !this.task ||
      typeof args.path !== "string"
    )
      throw new WorkflowFault("CAPABILITY_DENIED", `Unclassified or mutating tool denied: ${name}`);
    const path = this.path(args.path);
    const write = this.task.writes.find((w) => w.path === path);
    if (!write || (write.action === "delete") !== (name === "delete_file"))
      throw new WorkflowFault("CAPABILITY_DENIED", `Task ${this.task.id} cannot write ${path}`);
    const existing = fileHash(workspacePath(this.root, path));
    const ownEffect = this.store
      .effects(this.runId)
      .filter(
        (effect) =>
          effect.attempt_id === this.attemptId &&
          effect.kind === "file_patch" &&
          ["applied", "reconciled"].includes(effect.status) &&
          JSON.parse(effect.intent_json).path === path,
      )
      .at(-1);
    const baseline = this.store.state(this.runId).expectedFiles;
    // The baseline lists the files the snapshot can see. A file that exists but is not listed is
    // git-ignored and untracked (for example a docs directory in .gitignore): the snapshot has no
    // reference hash for it, so there is nothing to compare, and refusing it would make an approved
    // scope file impossible to write. A missing file is still expected to be missing.
    const unseen = baseline !== null && !(path in baseline) && !ownEffect && existing !== null;
    if (
      baseline &&
      !unseen &&
      existing !== (ownEffect ? ownEffect.after_hash : (baseline[path] ?? null))
    )
      throw new WorkflowFault("INPUT_CHANGED", `File changed outside this attempt: ${path}`);
    if (
      write.action === "create" &&
      existing !== null &&
      !ownEffect &&
      !createdByRunLineage(this.store, this.runId, path, existing)
    )
      throw new WorkflowFault("INPUT_CHANGED", `Create target already exists: ${path}`);
    if (write.action === "modify" && existing === null)
      throw new WorkflowFault("INPUT_CHANGED", `Modify target is missing: ${path}`);
    this.leases.assert("mutation");
    return path;
  }
  async execute(
    name: string,
    args: Record<string, unknown>,
    action: () => Promise<unknown>,
  ): Promise<unknown> {
    const path = this.validate(name, args);
    if (!path) return action();
    const absolute = workspacePath(this.root, path);
    // The pre-image lets `workflow undo` restore the file if this edit is never committed.
    const effectId = this.store.transaction(() =>
      this.store.prepareEffect(
        this.runId,
        this.attemptId,
        "file_patch",
        { path, tool: name },
        capturePreImage(this.store, this.runId, absolute),
        null,
      ),
    );
    try {
      this.validate(name, args);
      const result = await action();
      this.store.transaction(() =>
        this.store.finishFileEffect(this.runId, effectId, fileHash(absolute)),
      );
      return result;
    } catch (error) {
      this.store.transaction(() => this.store.effectStatus(this.runId, effectId, "unknown"));
      throw error;
    }
  }
}
