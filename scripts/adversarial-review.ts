/**
 * Adversarial sweep review of a pull request that fixes a Bug issue (#1722). A model of another
 * family than the fixer's gets the diff, the issue and the `## Sweep` section, with the sweep
 * checklist of the file-issue skill, and names the sibling places, languages or paths the sweep
 * missed. The review is advisory: CI posts it as one comment and never fails on it.
 *
 * Usage:
 *   bun scripts/adversarial-review.ts --pr N [--post] [--out DIR]
 *   bun scripts/adversarial-review.ts --last N --out DIR
 * Environment: GITHUB_REPOSITORY, GITHUB_TOKEN; ANTHROPIC_API_KEY with
 * ADVERSARIAL_REVIEW_ANTHROPIC_MODEL, or OPENAI_API_KEY with ADVERSARIAL_REVIEW_OPENAI_MODEL.
 * Without a key and model for the reviewing family the script writes the prompt and stops.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closedIssueNumbers, sweepSection } from "./check-sweep-section";

const SKILL = join(import.meta.dir, "../.agents/skills/file-issue/SKILL.md");
const INSTRUCTIONS = join(import.meta.dir, "../.agents/skills/file-issue/adversarial-review.md");
/** Marks the comment the review posts, so a new push updates it instead of adding another. */
export const COMMENT_MARKER = "<!-- adversarial-sweep-review -->";
/** Diffs longer than this are cut; the reviewer is told so. */
const MAX_DIFF = 120_000;

export type Family = "anthropic" | "openai";

/**
 * The sweep checklist of the file-issue skill: every `##` section whose heading names a sweep.
 * Reading it from the skill means a dimension added there reaches the reviewer unchanged.
 */
export function sweepChecklist(skill: string): string {
  return skill
    .split(/^(?=## )/m)
    .filter((section) => /^## .*\bsweep\b/i.test(section))
    .map((section) => section.trim())
    .join("\n\n");
}

export interface ReviewInput {
  issues: { number: number; title: string; body: string }[];
  prNumber: number;
  prTitle: string;
  prBody: string;
  diff: string;
}

/** The whole prompt: instructions, the skill's checklist, then the issue, the sweep and the diff. */
export function reviewPrompt(input: ReviewInput, skill: string, instructions: string): string {
  const diff =
    input.diff.length > MAX_DIFF
      ? `${input.diff.slice(0, MAX_DIFF)}\n\n[The diff is cut at ${MAX_DIFF} characters of ${input.diff.length}.]`
      : input.diff;
  return [
    instructions.trim(),
    "# Sweep checklist (from .agents/skills/file-issue/SKILL.md)",
    sweepChecklist(skill),
    ...input.issues.map((i) => `# Issue #${i.number}: ${i.title}\n\n${i.body.trim()}`),
    `# Pull request #${input.prNumber}: ${input.prTitle}`,
    "## Its Sweep section",
    sweepSection(input.prBody) || "(The description has no Sweep section.)",
    "## Its diff",
    `\`\`\`diff\n${diff}\n\`\`\``,
  ].join("\n\n");
}

/**
 * The family that reviews: the other one than the fixer's, read from the commits' co-author
 * trailers and messages. When the fixer is unknown, the first family with a key reviews.
 */
export function reviewerFamily(commitMessages: string[], available: Family[]): Family | null {
  const text = commitMessages.join("\n");
  const fixer: Family | null = /co-authored-by:\s*claude|claude-session:/i.test(text)
    ? "anthropic"
    : /co-authored-by:\s*(?:codex|chatgpt|openai)|\bcodex\b/i.test(text)
      ? "openai"
      : null;
  const other = available.filter((f) => f !== fixer);
  return other[0] ?? null;
}

function availableFamilies(env: Record<string, string | undefined>): Family[] {
  const families: Family[] = [];
  if (env.OPENAI_API_KEY && env.ADVERSARIAL_REVIEW_OPENAI_MODEL) families.push("openai");
  if (env.ANTHROPIC_API_KEY && env.ADVERSARIAL_REVIEW_ANTHROPIC_MODEL) families.push("anthropic");
  return families;
}

async function complete(family: Family, prompt: string, env: Record<string, string | undefined>) {
  if (family === "anthropic") {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.ADVERSARIAL_REVIEW_ANTHROPIC_MODEL,
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`Anthropic API: HTTP ${response.status}`);
    const data = (await response.json()) as { content?: { type: string; text?: string }[] };
    return (data.content ?? []).map((c) => c.text ?? "").join("");
  }
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY ?? ""}` },
    body: JSON.stringify({
      model: env.ADVERSARIAL_REVIEW_OPENAI_MODEL,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI API: HTTP ${response.status}`);
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

/** The comment body: the review under a heading that says it is advisory. */
export function commentBody(review: string, family: Family): string {
  return [
    COMMENT_MARKER,
    "### Adversarial sweep review (advisory)",
    `A ${family === "anthropic" ? "Claude" : "OpenAI"} model, of another family than the fixer's, read the diff, the issue and the Sweep section with the [file-issue checklist](../blob/main/.agents/skills/file-issue/SKILL.md) and looked for missed places. It does not block the merge; a real finding goes into this pull request or a new issue.`,
    review.trim(),
  ].join("\n\n");
}

async function github<T>(path: string, token: string, init: RequestInit = {}, accept = "application/vnd.github+json") {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
  return (accept.endsWith("diff") ? await response.text() : await response.json()) as T;
}

interface Pull {
  number: number;
  title: string;
  body: string | null;
  merged_at?: string | null;
}

/** The Bug issues a pull request closes, with their text; empty when it closes none. */
async function bugIssues(repository: string, body: string, token: string) {
  const issues: ReviewInput["issues"] = [];
  for (const number of closedIssueNumbers(body, repository)) {
    const issue = await github<{
      title: string;
      body: string | null;
      pull_request?: unknown;
      type?: { name?: string } | null;
      labels?: Array<{ name?: string } | string>;
    }>(`/repos/${repository}/issues/${number}`, token).catch(() => null);
    if (!issue || issue.pull_request) continue;
    const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? "")));
    if (issue.type?.name === "Bug" || labels.includes("bug"))
      issues.push({ number, title: issue.title, body: issue.body ?? "" });
  }
  return issues;
}

async function reviewInput(repository: string, pull: Pull, token: string) {
  const body = pull.body ?? "";
  const issues = await bugIssues(repository, body, token);
  if (!issues.length) return null;
  const diff = await github<string>(`/repos/${repository}/pulls/${pull.number}`, token, {}, "application/vnd.github.diff");
  const commits = await github<{ commit: { message: string } }[]>(
    `/repos/${repository}/pulls/${pull.number}/commits?per_page=100`,
    token,
  );
  const input: ReviewInput = { issues, prNumber: pull.number, prTitle: pull.title, prBody: body, diff };
  return { input, messages: commits.map((c) => c.commit.message) };
}

async function postComment(repository: string, prNumber: number, body: string, token: string) {
  const comments = await github<{ id: number; body?: string }[]>(
    `/repos/${repository}/issues/${prNumber}/comments?per_page=100`,
    token,
  );
  const existing = comments.find((c) => c.body?.startsWith(COMMENT_MARKER));
  const init = { method: existing ? "PATCH" : "POST", body: JSON.stringify({ body }) };
  await github(
    existing
      ? `/repos/${repository}/issues/comments/${existing.id}`
      : `/repos/${repository}/issues/${prNumber}/comments`,
    token,
    init,
  );
}

async function reviewPull(repository: string, pull: Pull, options: { post: boolean; out?: string }) {
  const env = process.env;
  const token = env.GITHUB_TOKEN ?? "";
  const found = await reviewInput(repository, pull, token);
  if (!found) {
    console.log(`#${pull.number}: closes no Bug issue; no review.`);
    return;
  }
  const prompt = reviewPrompt(found.input, readFileSync(SKILL, "utf8"), readFileSync(INSTRUCTIONS, "utf8"));
  if (options.out) {
    mkdirSync(options.out, { recursive: true });
    writeFileSync(join(options.out, `pr-${pull.number}.prompt.md`), prompt);
  }
  const family = reviewerFamily(found.messages, availableFamilies(env));
  if (!family) {
    console.log(`#${pull.number}: no API key and model for a reviewer of another family; prompt only.`);
    return;
  }
  const review = await complete(family, prompt, env);
  if (options.out) writeFileSync(join(options.out, `pr-${pull.number}.review.md`), review);
  if (options.post) await postComment(repository, pull.number, commentBody(review, family), token);
  console.log(`#${pull.number}: reviewed by the ${family} family${options.post ? " and posted" : ""}.`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const repository = process.env.GITHUB_REPOSITORY ?? "Gulliby-development/baked";
  const token = process.env.GITHUB_TOKEN ?? "";
  const out = value("--out");
  const pr = value("--pr");
  const last = value("--last");
  try {
    if (pr) {
      const pull = await github<Pull>(`/repos/${repository}/pulls/${Number(pr)}`, token);
      await reviewPull(repository, pull, { post: args.includes("--post"), ...(out ? { out } : {}) });
    } else if (last && out) {
      // The offline evaluation: the last N merged pull requests that closed a Bug issue.
      let left = Number(last);
      for (let page = 1; left > 0 && page <= 10; page++) {
        const pulls = await github<Pull[]>(
          `/repos/${repository}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=50&page=${page}`,
          token,
        );
        if (!pulls.length) break;
        for (const pull of pulls) {
          if (left <= 0 || !pull.merged_at) continue;
          if (!(await bugIssues(repository, pull.body ?? "", token)).length) continue;
          await reviewPull(repository, pull, { post: false, out });
          left--;
        }
      }
    } else {
      console.error("Usage: bun scripts/adversarial-review.ts --pr N [--post] [--out DIR] | --last N --out DIR");
      process.exit(2);
    }
  } catch (error) {
    // Advisory: a failed review is reported and never fails the job.
    console.warn(`Adversarial review skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}
