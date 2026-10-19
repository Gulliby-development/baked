import { matchGlob } from "../platform/index.js";
import type { Review } from "../workflows/schemas.js";
import type { RuntimeState } from "../workflows/types.js";
import { addReviewNotes } from "./review-notes.js";

type Bounds = RuntimeState["initiativeBounds"];

const normalized = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//, "");

/** A shared boundary belongs to this run too; only exclusively sibling-owned paths are notes. */
export function siblingOwner(file: string | null, bounds: Bounds) {
  if (!file || !bounds) return undefined;
  const path = normalized(file);
  const owns = (feature: NonNullable<Bounds>["features"][number]) =>
    feature.paths.some((pattern) => matchGlob(path, normalized(pattern)));
  const current = bounds.features.find((feature) => feature.id === bounds.featureId);
  // Missing current metadata is not proof that a path lies outside its boundary.
  if (!current || owns(current)) return undefined;
  return bounds.features.find((feature) => feature.id !== bounds.featureId && owns(feature));
}

/** Record the owner without granting this run writes into another feature's boundary. */
export function noteSiblingFindings(
  state: Pick<RuntimeState, "initiativeBounds" | "reviewNotes" | "snapshotId">,
  source: string,
  findings: Review["findings"],
): Set<string> {
  const ids = new Set<string>();
  for (const finding of findings) {
    const owner = siblingOwner(finding.file, state.initiativeBounds);
    if (!owner) continue;
    ids.add(finding.id);
    addReviewNotes(state.reviewNotes, source, state.snapshotId, [
      {
        finding: {
          ...finding,
          claim: `${finding.claim} Owned by initiative feature ${owner.id}: ${owner.scope}. Its own review checks this path.`,
        },
        reason: "owned_by_sibling",
      },
    ]);
  }
  return ids;
}
