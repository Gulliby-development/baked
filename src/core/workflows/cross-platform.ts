import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
  return `${asked ? "The request names CI or other operating systems" : "The project already runs CI"}: add a criterion that the product's tests pass on Windows, macOS and Linux, so delivered tests do not assume one operating system.`;
}
