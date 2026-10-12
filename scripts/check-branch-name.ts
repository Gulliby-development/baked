/**
 * Fails a pull request whose head branch breaks the naming rule in AGENTS.md:
 * `feature/<name>` or `bugfix/<name>`, with Dependabot's branches exempt.
 * Usage: bun scripts/check-branch-name.ts <branch>
 */

const BRANCH_PATTERN = /^(feature|bugfix)\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
const EXEMPT_PREFIXES = ["dependabot/"];
const GENERIC_NAMES = /^(feature|bugfix)\/(project-thread|patch|update|changes|fix|wip)(-[a-z0-9]{6})?$/;

export function branchNameProblem(branch: string): string | null {
  if (EXEMPT_PREFIXES.some((prefix) => branch.startsWith(prefix))) return null;
  if (!BRANCH_PATTERN.test(branch)) {
    return `Branch "${branch}" must be feature/<name> or bugfix/<name> (lowercase words joined by hyphens).`;
  }
  if (GENERIC_NAMES.test(branch)) {
    return `Branch "${branch}" needs a name that says what the task is.`;
  }
  return null;
}

if (import.meta.main) {
  const branch = process.argv[2] ?? "";
  const problem = branch ? branchNameProblem(branch) : "No branch name given.";
  if (problem) {
    console.error(`${problem} See "Task workflow" in AGENTS.md; rename the branch and open the PR again.`);
    process.exit(1);
  }
  console.log(`Branch "${branch}" follows the naming rule.`);
}
