import { existsSync, readFileSync } from "node:fs";
import { hashBytes } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { WorkflowFault } from "./errors.js";
import { journaledBaseHashes } from "./review-bundle.js";
import { readKept } from "./rollback.js";
import type { WorkflowStore } from "./store.js";
import type { RuntimeState } from "./types.js";
import { initialPosition, parseRunDefinition, stageKind } from "./v2/runtime.js";

/** The parent's changes a stage fork starts from; written once, when the fork is made. */
export const FORK_SEED_ARTIFACT = "fork/seed.json";
/** Written when the fork's first drive has put the seed into its workspace. */
export const FORK_SEEDED_ARTIFACT = "fork/seeded.json";
/** Stage mechanisms a fork may start at: those after the implementation. */
const FORK_STAGE_KINDS = new Set(["checks", "review", "converge"]);

export interface ForkSeed {
  parentRunId: string;
  stageId: string;
  /** The parent's snapshot when the fork was made; equal content lets the fork reuse its evidence. */
  parentSnapshotId: string | null;
  parentSnapshotHash: string | null;
  /** Each file the parent changed: its content before the parent's first edit and now (base64). */
  files: { path: string; before: string | null; content: string | null }[];
}

/** The stages of a run's definition a fork can start at, in definition order. */
export function forkStages(definitionJson: string): string[] {
  const parsed = parseRunDefinition(definitionJson);
  if (parsed.schemaVersion === 1)
    return parsed.definition.stages
      .filter((stage) => FORK_STAGE_KINDS.has(stage.kind))
      .map((stage) => stage.id);
  return parsed.definition.stages
    .filter((stage) => FORK_STAGE_KINDS.has(stageKind(stage) ?? ""))
    .map((stage) => stage.id);
}

/** Where a fork that starts at `stageId` begins; refuses a stage before the implementation. */
export function forkStagePosition(
  definitionJson: string,
  stageId: string,
): { stageIndex: number; position: RuntimeState["position"] } {
  const allowed = forkStages(definitionJson);
  if (!allowed.includes(stageId))
    throw new WorkflowFault(
      "INVALID_REFERENCE",
      `A fork can start at a stage after the implementation: ${allowed.join(", ") || "none in this workflow"}; not ${stageId}`,
    );
  const parsed = parseRunDefinition(definitionJson);
  if (parsed.schemaVersion === 1)
    return {
      stageIndex: parsed.definition.stages.findIndex((stage) => stage.id === stageId),
      position: null,
    };
  const position = initialPosition(parsed.definition);
  position.stageId = stageId;
  position.visits = { [stageId]: 1 };
  return { stageIndex: 0, position };
}

/**
 * The parent's changes as the fork will start from them: every file the parent's journal edited,
 * with its content before the parent's first edit (from the kept pre-image) and its content in
 * the parent's workspace now. Files that ended where they started are left out.
 */
export function captureForkSeed(
  store: WorkflowStore,
  parentRunId: string,
  parent: RuntimeState,
  parentRoot: string,
  stageId: string,
): ForkSeed {
  if (!existsSync(parentRoot))
    throw new WorkflowFault(
      "RECOVERY_REQUIRED",
      `The workspace of run ${parentRunId} is gone (its worktree was discarded), so its changes cannot be carried into a stage fork`,
    );
  const files: ForkSeed["files"] = [];
  for (const [path, beforeHash] of journaledBaseHashes(store, parentRunId)) {
    const absolute = workspacePath(parentRoot, path);
    const now = existsSync(absolute) ? readFileSync(absolute) : null;
    if ((now === null ? null : hashBytes(now)) === beforeHash) continue;
    const before = beforeHash === null ? null : readKept(store, parentRunId, beforeHash);
    if (beforeHash !== null && before === null)
      throw new WorkflowFault(
        "ARTIFACT_MISSING",
        `Run ${parentRunId} kept no earlier content of ${path}, so a stage fork cannot show its change`,
      );
    files.push({
      path,
      before: before === null ? null : before.toString("base64"),
      content: now === null ? null : now.toString("base64"),
    });
  }
  return {
    parentRunId,
    stageId,
    parentSnapshotId: parent.snapshotId,
    parentSnapshotHash: parent.workspaceHash,
    files,
  };
}

export const seedBytes = (value: string | null): Buffer | null =>
  value === null ? null : Buffer.from(value, "base64");
