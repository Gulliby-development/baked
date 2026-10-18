/**
 * Fails a pull request that closes a Bug issue but has no `## Sweep` section in its description.
 * The section reports the sibling sweep from `.agents/skills/file-issue/SKILL.md`: the places the
 * issue lists that were fixed, and what re-running the sweep on the branch found.
 * Usage (in CI): PR_BODY, GITHUB_REPOSITORY and GITHUB_TOKEN set; bun scripts/check-sweep-section.ts
 */

const CLOSING_REFERENCE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi;
const SWEEP_HEADING = /^(#{2,6})\s+Sweep\b.*$/im;
const ANY_HEADING = /^(#{1,6})\s/;

export interface ClosedIssue {
  number: number;
  isBug: boolean;
}

/** Issue numbers the description closes in `repository` (bare `#N` or `owner/repo#N`). */
export function closedIssueNumbers(body: string, repository: string): number[] {
  const numbers = new Set<number>();
  for (const match of body.matchAll(CLOSING_REFERENCE)) {
    const repo = match[1];
    if (repo && repo.toLowerCase() !== repository.toLowerCase()) continue;
    numbers.add(Number(match[2]));
  }
  return [...numbers];
}

/** The text under the `## Sweep` heading, without HTML comments, or null when there is no heading. */
export function sweepSection(body: string): string | null {
  const text = body.replace(/<!--[\s\S]*?-->/g, "");
  const heading = SWEEP_HEADING.exec(text);
  if (!heading) return null;
  const level = heading[1]?.length ?? 2;
  const lines: string[] = [];
  for (const line of text.slice(heading.index + heading[0].length).split(/\r?\n/)) {
    const next = ANY_HEADING.exec(line);
    if (next && (next[1]?.length ?? 1) <= level) break;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

export function sweepProblem(body: string, closed: ClosedIssue[]): string | null {
  const bugs = closed.filter((issue) => issue.isBug).map((issue) => `#${issue.number}`);
  if (bugs.length === 0) return null;
  const section = sweepSection(body);
  if (section === null) {
    return `This pull request closes Bug issue ${bugs.join(", ")} but its description has no "## Sweep" section.`;
  }
  if (section === "") {
    return `The "## Sweep" section is empty; this pull request closes Bug issue ${bugs.join(", ")}.`;
  }
  return null;
}

async function fetchIssue(repository: string, number: number, token: string): Promise<ClosedIssue | null> {
  const response = await fetch(`https://api.github.com/repos/${repository}/issues/${number}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    console.warn(`Could not read issue #${number} (HTTP ${response.status}); skipping it.`);
    return null;
  }
  const issue = (await response.json()) as {
    pull_request?: unknown;
    type?: { name?: string } | null;
    labels?: Array<{ name?: string } | string>;
  };
  if (issue.pull_request) return null;
  const labels = (issue.labels ?? []).map((label) => (typeof label === "string" ? label : (label.name ?? "")));
  return { number, isBug: issue.type?.name === "Bug" || labels.includes("bug") };
}

if (import.meta.main) {
  const body = process.env.PR_BODY ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  const closed: ClosedIssue[] = [];
  for (const number of closedIssueNumbers(body, repository)) {
    const issue = await fetchIssue(repository, number, token);
    if (issue) closed.push(issue);
  }
  const problem = sweepProblem(body, closed);
  if (problem) {
    console.error(
      `${problem} Add a "## Sweep" section that lists the places from the issue you fixed and what re-running the sweep on this branch found (fixed here, or a linked new issue). See .agents/skills/file-issue/SKILL.md, step 5.`,
    );
    process.exit(1);
  }
  console.log(closed.some((issue) => issue.isBug) ? "The Sweep section is present." : "No Bug issue is closed here.");
}
