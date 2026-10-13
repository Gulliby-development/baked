import { requiresSecurityReview } from "../verification/findings.js";
import { touchesLanguageFiles } from "./language.js";
import { unifiedDiff } from "./parallel.js";
import { readKept } from "./rollback.js";
import type { Review } from "./schemas.js";
import type { WorkflowStore } from "./store.js";

/** Characters of the correction patch a rerun reviewer gets; it reads the files for the rest. */
export const MAX_CORRECTION_PATCH_CHARS = 24_000;

/** Paths whose content differs between two source manifests (added, removed or changed). */
export function changedSince(
  before: Readonly<Record<string, string>>,
  now: Readonly<Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(now)])]
    .filter((path) => before[path] !== now[path])
    .sort();
}

/**
 * Whether a changed path concerns a review dimension: the language reviewer looks at the files
 * of the project's languages, the security reviewer at security-sensitive paths, and every other
 * dimension at any change.
 */
export function inReviewScope(dimension: string, path: string): boolean {
  if (dimension === "language") return touchesLanguageFiles([path]);
  if (dimension === "security") return requiresSecurityReview([path], false);
  return true;
}

/**
 * A review from the round before a correction stands for the next round when it passed with no
 * finding and no criterion left open, and nothing in its dimension's scope changed since.
 */
export function carriesOver(dimension: string, prior: Review, changed: readonly string[]): boolean {
  return (
    prior.verdict === "pass" &&
    prior.findings.length === 0 &&
    prior.coverage.every((c) => c.verdict !== "inconclusive") &&
    !changed.some((path) => inReviewScope(dimension, path))
  );
}

/**
 * What a reviewer that runs again after a correction is told: its findings of the previous
 * round, the files changed since, and the diff of those changes against what it reviewed.
 */
export async function previousRound(
  store: WorkflowStore,
  runId: string,
  prior: { review: Review; files: Readonly<Record<string, string>> },
  changed: readonly string[],
  read: (path: string) => Buffer | null,
): Promise<Record<string, unknown>> {
  const parts: string[] = [];
  for (const path of changed) {
    const hash = prior.files[path];
    const earlier = hash === undefined ? null : readKept(store, runId, hash);
    if (hash !== undefined && earlier === null) {
      parts.push(`--- ${path}: content at the previous review not kept, read the file`);
      continue;
    }
    const part = await unifiedDiff(path, earlier, read(path));
    if (part) parts.push(part);
  }
  const patch = parts.join("\n");
  return {
    note: "This is a later review round after corrections. Check first whether your previous findings are fixed, reading the correction patch; re-examine other criteria only where the changed files touch them. Set repeatOf to the id of a previous finding when a finding is the same defect, and null otherwise.",
    findings: prior.review.findings,
    changedFiles: changed,
    correctionPatch:
      patch.length > MAX_CORRECTION_PATCH_CHARS
        ? `${patch.slice(0, MAX_CORRECTION_PATCH_CHARS)}\n... patch cut at ${MAX_CORRECTION_PATCH_CHARS} characters; read the files for the rest`
        : patch,
  };
}
