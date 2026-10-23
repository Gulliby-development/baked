import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** What the host-required cross-platform criterion states (host-required-criteria.ts reads it). */
export const CROSS_PLATFORM_OUTCOME = "the product's tests pass on Windows, macOS and Linux";

/** CI configuration files whose presence means the project already checks on a CI service. */
const CI_FILES = [".gitlab-ci.yml", "azure-pipelines.yml", ".circleci/config.yml", ".travis.yml"];
const PLATFORMS =
  /\b(?:windows|mac\s?os|os\s?x|linux|ubuntu|cross[- ]platform|multi[- ]platform|every (?:operating system|os|platform)|all (?:operating systems|platforms)|continuous integration|github actions)\b/i;
/** "CI" only as the capitalized abbreviation, so words such as "ci" in identifiers do not count. */
const CI = /\bCI\b/;

/**
 * A request that turns CI down ("No CI workflow is wanted", "without GitHub Actions"). Such a
 * request may still name other operating systems, and then a CI matrix is not the way to prove
 * them (#1015, stmtsplit e29347c1).
 */
const NO_CI =
  /\bno (?:CI|continuous integration|github actions|(?:ci )?workflow files?)\b|\b(?:CI|continuous integration|github actions|workflow files?)\b[^.]*\b(?:is|are) not (?:wanted|needed|required)\b|\b(?:don't|do not|without|never)\b[^.]*\b(?:add|write|create|set up|use)?\s*(?:a )?(?:CI|continuous integration|github actions)\b/i;
/** Whether the request says it wants no CI. */
export const forbidsCi = (request: string): boolean => NO_CI.test(request);

/** Whether the project has a CI configuration the host can see. */
export function hasCi(root: string): boolean {
  try {
    const workflows = join(root, ".github", "workflows");
    if (existsSync(workflows) && readdirSync(workflows).some((f) => /\.ya?ml$/i.test(f)))
      return true;
  } catch {
    /* unreadable: no CI the host can see */
  }
  return CI_FILES.some((file) => existsSync(join(root, file)));
}

/**
 * What the spec author is told about other operating systems. A run checks on one host, so a
 * criterion that the tests pass on Windows, macOS and Linux is only asked for when the request
 * names CI or other platforms, or the project already runs CI. Asking for it unconditionally
 * (#383) made the spec author invent a three-OS CI requirement in every control app of bench
 * round 14 (#926), which analysis then raised as added scope.
 */
export function crossPlatformNote(request: string, root: string): string | null {
  const asked = PLATFORMS.test(request) || CI.test(request);
  const ci = hasCi(root);
  if (!asked && !ci) return null;
  // One host proves only what it can run: platform-neutral code and tests that pass here (#1015).
  if (forbidsCi(request))
    return "The request names other operating systems but wants no CI: write criteria this host can check (the code uses platform-neutral path, line-ending and process APIs; the tests pass here), never an automated criterion that claims behavior on Windows, macOS or Linux, and add no CI workflow or platform matrix.";
  // The host writes the criterion itself (#1943): asked of the author, it was left out or turned
  // into an automated criterion that only CI results prove, which no check of a run produces.
  return `${asked ? "The request names CI or other operating systems" : "The project already runs CI"}: the host adds a post-release criterion that ${CROSS_PLATFORM_OUTCOME}, which the project's CI proves on the delivered revision, so do not write one. Write no automated criterion that needs CI job results or a run on another operating system; keep delivered tests free of assumptions about one operating system (platform-neutral path, line-ending and process APIs).`;
}

/**
 * Whether the host requires the cross-platform criterion: the request names CI or other operating
 * systems, or the project runs CI, and the request does not turn CI down. The one predicate the
 * specify note, the analysis note and the scheduler's host-required filter all read: the analysis
 * table once said only "the request names other operating systems", so hdrlens (bench round 56,
 * "No CI workflow is wanted") looped specify, plan and analyze in 3 of 8 features over the
 * criterion the specify note told the author never to write (#1831).
 */
export const crossPlatformCriterionRequired = (request: string, root: string): boolean =>
  crossPlatformNote(request, root) !== null && !forbidsCi(request);

/** Whether the request names other operating systems or CI but turns CI down. */
export const platformsWithoutCi = (request: string, root: string): boolean =>
  crossPlatformNote(request, root) !== null && forbidsCi(request);

/**
 * What the spec reviewer is told about other operating systems: the same decision as the
 * author's note, worded for the reviewer, so analysis never asks for what the host does not
 * require nor objects to what it does (#1765, #1831).
 */
export function crossPlatformAnalysisNote(request: string, root: string): string | null {
  if (crossPlatformCriterionRequired(request, root))
    return `The host requires a criterion that ${CROSS_PLATFORM_OUTCOME} (${PLATFORMS.test(request) || CI.test(request) ? "the request names CI or other operating systems" : "the project already runs CI"}) and writes it itself after specify, as a post-release criterion the project's CI proves on the delivered revision: it, the requirement it serves, a spec without it and its method are never a finding.`;
  if (platformsWithoutCi(request, root))
    return "The request names other operating systems but wants no CI, so the host requires no criterion about Windows, macOS or Linux: platform-neutral code and tests that pass on this host settle the request's platform sentence. A missing criterion about other operating systems, a CI workflow or a platform matrix is never a finding.";
  return null;
}
