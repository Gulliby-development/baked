import { canonical, hashJson } from "../specs/hash.js";
import {
  applyReleasedCreates,
  type ReleasedWrite,
  releasedCreates,
  releasedFrom,
  releasedModifies,
} from "./dependencies.js";
import { CorrectionSchema } from "./schemas.js";
import type { WorkflowStore } from "./store.js";
import type { RuntimeState } from "./types.js";
import { trackedPaths } from "./worktree.js";

/** The record `releaseBase` writes when a planned-ahead run moves onto its upstream (#1834). */
export const RELEASE_RECORD = "plan-ahead/release.json";

/**
 * The planned creates of a released planned-ahead run that are still `create` although the
 * release brought their files in (#2514): tracked on the released base (`to`) and not on the
 * provisional one (`from`); and the planned modifies still `modify` although the release removed
 * their files (#2517): tracked on `from` and not on `to`. A run released before the conversion
 * kept them; its resume and every later drive convert them (#2540). Empty for a run that is not
 * released, has no release record, or has nothing left to convert, so a second call converts
 * nothing.
 */
export async function staleReleasedCreates(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
): Promise<ReleasedWrite[]> {
  if (!state.planAhead?.released || !state.graph || !state.approvalRoot) return [];
  const record = store.latestArtifact(runId, RELEASE_RECORD);
  if (!record) return [];
  const { from, to } = JSON.parse(store.readArtifact(runId, record.id)) as {
    from?: string;
    to?: string;
  };
  if (!from || !to || from === to) return [];
  return releasedCreatesBetween(store.workspace, state, from, to);
}

/** `releasedCreates` and `releasedModifies` of `state`'s graph for a release from `from` to `to`. */
export async function releasedCreatesBetween(
  workspace: string,
  state: RuntimeState,
  from: string,
  to: string,
): Promise<ReleasedWrite[]> {
  if (!state.graph) return [];
  const before = await trackedPaths(workspace, from);
  const after = await trackedPaths(workspace, to);
  return [
    ...releasedCreates(state.graph, (path) => after.has(path) && !before.has(path)),
    ...releasedModifies(state.graph, (path) => before.has(path) && !after.has(path)),
  ];
}

/**
 * Converts `released` in `state` (not saved) as a `host-release` correction link that acceptance
 * replays: a create into `modify` (#2514), a modify into `create` (#2517). Writes whose action in
 * the graph is no longer the one they convert from are left out, so a repeat converts nothing.
 * Call it inside a store transaction. Returns the writes converted.
 */
export function recordReleasedCreates(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  released: readonly ReleasedWrite[],
): ReleasedWrite[] {
  const graph = state.graph;
  if (!graph || !state.approvalRoot) return [];
  const due = released.filter((r) =>
    graph.tasks.some(
      (t) =>
        t.id === r.taskId &&
        t.writes.some(
          (w) => w.path === r.path && w.action === releasedFrom(r) && w.content === undefined,
        ),
    ),
  );
  if (!due.length) return [];
  const next = applyReleasedCreates(graph, due);
  const link = CorrectionSchema.parse({
    schemaVersion: 1,
    parentDigest: state.approvalRoot,
    parentGraphHash: hashJson(graph),
    rule: "host-release",
    newGraphHash: hashJson(next),
    findingIds: [],
    taskIds: [...new Set(due.map((r) => r.taskId))],
    roundKind: "release",
    round: 1,
    released: due,
  });
  const links = releaseLinkCount(store, runId);
  const artifact = store.artifact(
    runId,
    "correction",
    links ? `corrections/release-${String(links + 1)}.json` : "corrections/release.json",
    canonical(link),
  );
  state.correctionHashes.push(artifact.content_hash);
  state.manifest.correctionHashes = [...state.correctionHashes];
  state.graph = next;
  state.manifest.effectiveGraphHash = hashJson(next);
  store.syncTasks(runId, next);
  return due;
}

/**
 * How many `host-release` links the run's correction chain holds: an input of the invalid-output
 * repeat key (#2540).
 */
export function releaseLinkCount(store: WorkflowStore, runId: string): number {
  const chain = new Set(store.state(runId).correctionHashes);
  const links = store
    .artifacts(runId)
    .filter(
      (a) =>
        a.kind === "correction" &&
        chain.has(a.content_hash) &&
        (a.logical_path === "corrections/release.json" ||
          /^corrections\/release-\d+\.json$/.test(a.logical_path)),
    );
  return new Set(links.map((a) => a.content_hash)).size;
}
