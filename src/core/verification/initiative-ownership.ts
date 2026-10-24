import { matchGlob } from "../platform/index.js";
import { namedFiles } from "../workflows/initiatives/plan.js";
import { bansPropertyTests } from "../workflows/quality/properties.js";
import type { Review, Spec } from "../workflows/schemas.js";
import type { RuntimeState } from "../workflows/types.js";
import { canHold, normalizePath, requestedDeliverable } from "./deliverable-paths.js";
import { addReviewNotes } from "./review-notes.js";

type Bounds = RuntimeState["initiativeBounds"];

const normalized = normalizePath;

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

/** Resolve all named paths before inferring a pathless deliverable's owner. */
export function ownerOfFinding(finding: Review["findings"][number], bounds: Bounds) {
  if (!bounds) return undefined;
  const current = bounds.features.find((feature) => feature.id === bounds.featureId);
  if (!current) return undefined;
  const paths = [
    ...new Set([
      ...(finding.file ? [normalized(finding.file)] : []),
      ...namedFiles(
        normalized(
          `${finding.claim}\n${finding.suggestedFix}\n${JSON.stringify(finding.repro ?? {})}`,
        ),
      ),
    ]),
  ];
  // A mixed finding can still describe a defect in this run. Never hide it behind a sibling.
  if (paths.some((path) => current.paths.some((pattern) => matchGlob(path, normalized(pattern)))))
    return undefined;
  const owners = paths.map((path) => siblingOwner(path, bounds));
  if (owners.some(Boolean)) {
    const first = owners.find((owner) => owner !== undefined);
    return owners.every((owner) => owner?.id === first?.id) ? first : undefined;
  }
  const kind = requestedDeliverable(finding);
  if (!kind || canHold(current.paths, kind)) return undefined;
  const candidates = bounds.features.filter(
    (feature) => feature.id !== bounds.featureId && canHold(feature.paths, kind),
  );
  const designated =
    kind === "test" ? candidates.find((feature) => feature.id === current.testedBy) : undefined;
  return designated ?? (candidates.length === 1 ? candidates[0] : undefined);
}

/** An automated criterion must be provable by this feature's approved deliverables. */
export function specBoundaryProblems(spec: Spec, bounds: Bounds): string[] {
  if (!bounds) return [];
  const current = bounds.features.find((feature) => feature.id === bounds.featureId);
  if (!current) return [];
  return spec.criteria.flatMap((criterion) => {
    if (criterion.method !== "automated") return [];
    const text = `${criterion.given}\n${criterion.when}\n${criterion.then}`;
    const finding = { kind: "missing", claim: text, suggestedFix: "" };
    const paths = namedFiles(normalized(text));
    const outside = paths.length > 0 && paths.every((path) => siblingOwner(path, bounds));
    const kind = requestedDeliverable(finding);
    // A behavior criterion can be checked by reading code or running a command. Reject only
    // criteria demanding a test/docs deliverable, or evidence explicitly held only by siblings.
    const delivery =
      /\b(tests? (?:exist|cover|are (?:written|delivered))|coverage|documentation|docs)\b/i.test(
        text,
      );
    // A `property` flag in a feature that owns no test path is cleared by the host instead
    // (`clearBoundaryProperties`, #1891): the criterion's behavior is still this feature's.
    return outside || (kind && delivery && !canHold(current.paths, kind))
      ? [
          `Criterion ${criterion.id} requires evidence outside ${current.id}'s boundary. Keep only this feature's verifiable behavior; assign the test or documentation criterion to its owning initiative feature.`,
        ]
      : [];
  });
}

/** Whether the run's initiative feature has no path a test file can sit in (`testedBy` holds them). */
export function ownsNoTests(bounds: Bounds): boolean {
  const current = bounds?.features.find((feature) => feature.id === bounds.featureId);
  return !!current && !canHold(current.paths, "test");
}

/**
 * The criteria whose `property` flag the host clears because the feature owns no test path, so
 * no property test can be written in it (its tests belong to `testedBy`). The criteria stay
 * automated: their behavior is the feature's. wheeltags (bench round 59) had the specs of names
 * and targets rejected for it after they were written, three and two calls for one spec (#1891).
 */
export function clearBoundaryProperties(
  spec: Spec,
  bounds: Bounds,
): { spec: Spec; cleared: string[] } {
  if (!ownsNoTests(bounds)) return { spec, cleared: [] };
  const cleared = spec.criteria.filter((c) => c.property).map((c) => c.id);
  if (!cleared.length) return { spec, cleared };
  return {
    spec: { ...spec, criteria: spec.criteria.map(({ property: _, ...c }) => c) },
    cleared,
  };
}

/**
 * The criteria whose `property` flag the host clears because the request bans generated inputs
 * (`bansPropertyTests`): such a run has the property-test mode `off`, so the flag can only keep a
 * literal table from the rows (`literalRows`) and mark its cases generated. dirdrift-update (bench
 * round 66, "no random values, no generated inputs") had its 25-row table marked `"strings"`, and
 * no criterion was eligible for rows (#2045). A recorded host edit, never a rejection.
 */
export function clearBannedProperties(
  spec: Spec,
  request: string,
): { spec: Spec; cleared: string[] } {
  const cleared = spec.criteria.filter((c) => c.property).map((c) => c.id);
  if (!cleared.length || !bansPropertyTests(request)) return { spec, cleared: [] };
  return {
    spec: { ...spec, criteria: spec.criteria.map(({ property: _, ...c }) => c) },
    cleared,
  };
}

/** A criterion is deferred only when every finding explaining its failure has an owner. */
export function deferredOwners(review: Review, bounds: Bounds): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const coverage of review.coverage) {
    if (coverage.verdict === "pass") continue;
    const findings = review.findings.filter((finding) =>
      finding.criterionIds.includes(coverage.criterionId),
    );
    const owners = findings.map((finding) => ownerOfFinding(finding, bounds)?.id);
    if (owners.length && owners.every((owner) => owner !== undefined))
      result.set(coverage.criterionId, [...new Set(owners as string[])]);
  }
  return result;
}

/** Record the owner without granting this run writes into another feature's boundary. */
export function noteSiblingFindings(
  state: Pick<RuntimeState, "initiativeBounds" | "reviewNotes" | "snapshotId">,
  source: string,
  findings: Review["findings"],
): Set<string> {
  const ids = new Set<string>();
  for (const finding of findings) {
    const owner = ownerOfFinding(finding, state.initiativeBounds);
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
