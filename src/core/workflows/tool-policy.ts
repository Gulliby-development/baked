import { isAbsolute, relative } from "node:path";
import { workspacePath } from "../specs/validate.js";
import { fileHash, intentRoot, rootField, sameContentIgnoringEol } from "./effects.js";
import { WorkflowFault } from "./errors.js";
import { mutationLeaseFor, type WorkspaceLeases } from "./leases.js";
import { isMcpToolName, toolListAllows } from "./mcp-grants.js";
import { capturePreImage, createdByRunLineage } from "./rollback.js";
import type { AgentProfile, RunPolicy } from "./schemas.js";
import {
  DEFAULT_STALL_SETTINGS,
  type StallSettings,
  ToolDeadlineError,
  toolDeadlineMs,
  toolEnded,
  toolStarted,
  withDeadline,
} from "./stall.js";
import type { WorkflowStore } from "./store.js";
import { preexistingTest, testIntegrityOf } from "./test-integrity.js";
import { isTestTask } from "./tests-first.js";
import type { Task } from "./types.js";

export const pureWorkflowTools = new Set(["read", "navigate", "bake_find", "bake_impact"]);
/**
 * Edits the file-hash check refused, by the root they were attempted in. A refusal is a host
 * fact (the file differs from what the run recorded), not the model's disagreement with its task,
 * so a blocked outcome that follows one is reported as infrastructure.
 */
const hashRefusals = new Map<string, string[]>();

/** The files whose edits were refused by the hash check in `root` since the last call. */
export function takeHashRefusals(root: string): string[] {
  const paths = hashRefusals.get(root) ?? [];
  hashRefusals.delete(root);
  return [...new Set(paths)];
}

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
    private settings: StallSettings = DEFAULT_STALL_SETTINGS,
    /** Called for each tool call that hit its deadline, so the attempt can give up on repeats. */
    private onDeadline?: (tool: string) => void,
  ) {}
  path(value: string): string {
    const path = (isAbsolute(value) ? relative(this.root, value) : value).replaceAll("\\", "/");
    workspacePath(this.root, path);
    if (
      /^\.(baked|git)(\/|$)/i.test(path) ||
      // Definitions, gates, profiles and skills decide what a run may do; no agent edits them.
      /^baked\/(workflows|gates|agents|skills)(\/|$)|^baked\/constitution\.md$/i.test(path) ||
      /(^|\/)(\.env(?:\..*)?|credentials(?:\..*)?)$/i.test(path)
    )
      throw new WorkflowFault("CAPABILITY_DENIED", `Protected workflow path: ${path}`);
    return path;
  }
  validate(name: string, args: Record<string, unknown>): string | null {
    if (this.store.run(this.runId).status !== "running")
      throw new WorkflowFault("CAPABILITY_DENIED", "Run is not executing");
    if (
      !toolListAllows(this.profile.allowedTools, name) ||
      !toolListAllows(this.policy.allowedTools, name)
    )
      throw new WorkflowFault(
        "CAPABILITY_DENIED",
        `Tool ${name} is not allowed by profile and run policy`,
      );
    // An MCP tool acts outside the workspace through its server; the grant in both the profile
    // and the approved policy is its approval. Its arguments are the server's, not workspace paths.
    if (isMcpToolName(name)) return null;
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
    if (!write.reason) {
      const state = this.store.state(this.runId);
      // The tests written first are the code's target once approved; only test tasks change them.
      if (state.testsFirst?.files.includes(path) && !isTestTask(this.task))
        throw new WorkflowFault(
          "CAPABILITY_DENIED",
          `${path} holds tests written first and approved for this run, so it is read-only. Make the code pass them. If the spec and these tests cannot both hold, submit outcome spec_conflict and name both.`,
        );
      const tasks = (state.rootGraph ?? state.graph)?.tasks ?? [this.task];
      if (
        write.action !== "create" &&
        testIntegrityOf(this.policy) === "block" &&
        preexistingTest(path, tasks)
      )
        throw new WorkflowFault(
          "CAPABILITY_DENIED",
          `${path} is a test that existed before this run, and the approved plan gives no reason to change it, so it is read-only. Make the code pass it. If the spec and this test cannot both hold, submit outcome spec_conflict and name both.`,
        );
    }
    const existing = fileHash(workspacePath(this.root, path));
    const ownEffect = this.store
      .effects(this.runId)
      .filter(
        (effect) =>
          effect.attempt_id === this.attemptId &&
          effect.kind === "file_patch" &&
          ["applied", "reconciled"].includes(effect.status) &&
          JSON.parse(effect.intent_json).path === path &&
          intentRoot(effect.intent_json) ===
            (rootField(this.store.workspace, this.root).root ?? ""),
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
      existing !== (ownEffect ? ownEffect.after_hash : (baseline[path] ?? null)) &&
      !sameContentIgnoringEol(
        workspacePath(this.root, path),
        ownEffect ? ownEffect.after_hash : (baseline[path] ?? null),
      )
    ) {
      hashRefusals.set(this.root, [...(hashRefusals.get(this.root) ?? []), path]);
      throw new WorkflowFault("INPUT_CHANGED", `File changed outside this attempt: ${path}`);
    }
    if (
      write.action === "create" &&
      existing !== null &&
      !ownEffect &&
      !createdByRunLineage(this.store, this.runId, path, existing)
    )
      throw new WorkflowFault("INPUT_CHANGED", `Create target already exists: ${path}`);
    if (write.action === "modify" && existing === null)
      throw new WorkflowFault("INPUT_CHANGED", `Modify target is missing: ${path}`);
    this.leases.assert(mutationLeaseFor(this.store.workspace, this.root));
    return path;
  }
  /**
   * Runs a tool call under its deadline and journals it (`tool.started`, `tool.finished`), so a
   * run that stops advancing names the call it is in. A call that does not return in time is
   * abandoned: an edit whose file was already written is recorded as applied from the file hash.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    action: () => Promise<unknown>,
  ): Promise<unknown> {
    const started = Date.now();
    const journal = (
      type: "tool.started" | "tool.finished",
      status?: "ok" | "error" | "deadline",
    ) => {
      try {
        this.store.transaction(() =>
          this.store.emit(
            this.runId,
            type === "tool.started"
              ? { type, payload: { attemptId: this.attemptId, tool: name } }
              : {
                  type,
                  payload: {
                    attemptId: this.attemptId,
                    tool: name,
                    status: status ?? "ok",
                    durationMs: Date.now() - started,
                  },
                },
          ),
        );
      } catch {
        // The journal is evidence for attribution; a call never fails because it could not be written.
      }
    };
    journal("tool.started");
    toolStarted(this.runId);
    let status: "ok" | "error" | "deadline" = "ok";
    try {
      return await this.guarded(name, args, action, (hit) => {
        if (hit) status = "deadline";
      });
    } catch (error) {
      status = error instanceof ToolDeadlineError ? "deadline" : "error";
      throw error;
    } finally {
      toolEnded(this.runId);
      journal("tool.finished", status);
      if (status === "deadline") this.onDeadline?.(name);
    }
  }
  private async guarded(
    name: string,
    args: Record<string, unknown>,
    rawAction: () => Promise<unknown>,
    deadlineHit: (hit: boolean) => void,
  ): Promise<unknown> {
    const deadlineMs = toolDeadlineMs(this.settings, name);
    const action = () => withDeadline(name, deadlineMs, rawAction);
    const path = this.validate(name, args);
    if (!path) return action();
    const absolute = workspacePath(this.root, path);
    // The pre-image lets `workflow undo` restore the file if this edit is never committed.
    const effectId = this.store.transaction(() =>
      this.store.prepareEffect(
        this.runId,
        this.attemptId,
        "file_patch",
        { path, tool: name, ...rootField(this.store.workspace, this.root) },
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
      if (error instanceof ToolDeadlineError) {
        // The write happens before the tool's follow-up work (formatting, language servers), so a
        // file that differs from its pre-image was written: the same decision an operator makes
        // from the file hash with `record-applied`, made here.
        const current = fileHash(absolute);
        const before = this.store.effects(this.runId).find((e) => e.id === effectId)?.before_hash;
        if (current !== (before ?? null)) {
          this.store.transaction(() => this.store.finishFileEffect(this.runId, effectId, current));
          deadlineHit(true);
          return {
            success: true,
            output: `${name} wrote ${path} but did not finish its follow-up work within ${Math.round(deadlineMs / 1000)} s (formatter or language server); the edit is applied, re-read the file before editing it again.`,
          };
        }
        this.store.transaction(() => this.store.effectStatus(this.runId, effectId, "failed"));
        throw error;
      }
      this.store.transaction(() => this.store.effectStatus(this.runId, effectId, "unknown"));
      throw error;
    }
  }
}
