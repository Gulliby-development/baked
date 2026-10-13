import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** CI configuration files whose presence means the project already checks on a CI service. */
const CI_FILES = [".gitlab-ci.yml", "azure-pipelines.yml", ".circleci/config.yml", ".travis.yml"];
const PLATFORMS =
  /\b(?:windows|mac\s?os|os\s?x|linux|ubuntu|cross[- ]platform|multi[- ]platform|every (?:operating system|os|platform)|all (?:operating systems|platforms)|continuous integration|github actions)\b/i;
/** "CI" only as the capitalized abbreviation, so words such as "ci" in identifiers do not count. */
const CI = /\bCI\b/;

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
  return `${asked ? "The request names CI or other operating systems" : "The project already runs CI"}: add a criterion that the product's tests pass on Windows, macOS and Linux, so delivered tests do not assume one operating system.`;
}
