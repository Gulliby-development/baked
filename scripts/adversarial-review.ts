/**
 * Adversarial sweep review of a pull request that fixes a Bug issue (#1722). A model of another
 * family than the fixer's gets the diff, the issue and the `## Sweep` section, with the sweep
 * checklist of the file-issue skill, and names the sibling places, languages or paths the sweep
 * missed. The review is advisory and runs on the machine of whoever calls it, through the Claude
 * Code or Codex CLI and the subscription it is logged in with; there is no CI job and no API key.
 *
 * Usage:
 *   bun run review:adversarial --pr N [--post] [--out DIR] [--reviewer claude|codex]
 *   bun run review:adversarial --since YYYY-MM-DD [--post] [--out DIR]
 *   bun run review:adversarial --last N --out DIR
 * Environment: GITHUB_TOKEN (or a logged-in `gh`), GITHUB_REPOSITORY (default the BAKED repo).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeCommand } from "../src/core/llm/providers/claude-code/cli";
import { codexCommand } from "../src/core/llm/providers/codex/client";
import { codexRunEnv } from "../src/core/llm/providers/codex/home";
import { resolveCli } from "../src/core/platform/cli-path";
import { closedIssueNumbers, sweepSection } from "./check-sweep-section";

const SKILL = join(import.meta.dir, "../.agents/skills/file-issue/SKILL.md");
const INSTRUCTIONS = join(import.meta.dir, "../.agents/skills/file-issue/adversarial-review.md");
/** Marks the comment the review posts, so a new push updates it instead of adding another. */
export const COMMENT_MARKER = "<!-- adversarial-sweep-review -->";
/** Diffs longer than this are cut; the reviewer is told so. */
const MAX_DIFF = 120_000;
/** One review may take a while on a large diff; a hung CLI must not hold the loop. */
const REVIEW_TIMEOUT_MS = 15 * 60_000;

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

/** The families whose CLI is installed here: Claude Code for anthropic, Codex for openai. */
function installedFamilies(): Family[] {
  const families: Family[] = [];
  if (process.env.BAKED_CODEX_PATH?.trim() || resolveCli("codex").found) families.push("openai");
  if (process.env.BAKED_CLAUDE_CODE_PATH?.trim() || resolveCli("claude").found) families.push("anthropic");
  return families;
}

/** The CLI call that runs one review: no tools, read-only, in an empty folder so no project or user instructions reach it. */
export function reviewCommand(family: Family, dir: string): string[] {
  return family === "anthropic"
    ? [claudeCodeCommand(), "-p", "--tools", "", "--output-format", "text"]
    : [
        codexCommand(),
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "--output-last-message",
        join(dir, "review.md"),
        "-",
      ];
}

function complete(family: Family, prompt: string): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-adversarial-review-"));
  try {
    const [command = "", ...args] = reviewCommand(family, dir);
    const result = spawnSync(command, args, {
      cwd: dir,
      input: prompt,
      encoding: "utf8",
      timeout: REVIEW_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: family === "openai" ? codexRunEnv() : process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const tail = `${result.stderr ?? ""}`.trim().split("\n").slice(-5).join("\n");
      throw new Error(`${family === "anthropic" ? "claude" : "codex"} exited with ${result.status}: ${tail}`);
    }
    return family === "anthropic" ? result.stdout : readFileSync(join(dir, "review.md"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The comment body: the review under a heading that says it is advisory, marked with the commit it read. */
export function commentBody(review: string, family: Family, sha: string): string {
  return [
    `${COMMENT_MARKER}\n<!-- sha: ${sha} -->`,
    "### Adversarial sweep review (advisory)",
    `${family === "anthropic" ? "Claude Code" : "Codex"}, of another model family than the fixer's, read the diff at ${sha.slice(0, 7)}, the issue and the Sweep section with the [file-issue checklist](../blob/main/.agents/skills/file-issue/SKILL.md) and looked for missed places. It does not block the merge; a real finding goes into this pull request or a new issue.`,
    review.trim(),
  ].join("\n\n");
}

/** The commit an earlier review comment read, or null when the comment has none. */
export function reviewedSha(body: string): string | null {
  return /<!-- sha: ([0-9a-f]{7,40}) -->/.exec(body)?.[1] ?? null;
}

function githubToken(): string {
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (env) return env;
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8", windowsHide: true });
  return gh.status === 0 ? gh.stdout.trim() : "";
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
  state: string;
  updated_at: string;
  merged_at?: string | null;
  head: { sha: string };
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

async function reviewComment(repository: string, prNumber: number, token: string) {
  const comments = await github<{ id: number; body?: string }[]>(
    `/repos/${repository}/issues/${prNumber}/comments?per_page=100`,
    token,
  );
  return comments.find((c) => c.body?.startsWith(COMMENT_MARKER)) ?? null;
}

interface Options {
  post: boolean;
  out?: string;
  reviewer?: Family;
  /** Skip a pull request whose review comment already read its head commit. */
  skipReviewed?: boolean;
}

async function reviewPull(repository: string, pull: Pull, token: string, options: Options) {
  const body = pull.body ?? "";
  const issues = await bugIssues(repository, body, token);
  if (!issues.length) {
    console.log(`#${pull.number}: closes no Bug issue; no review.`);
    return;
  }
  const existing = options.post || options.skipReviewed ? await reviewComment(repository, pull.number, token) : null;
  if (options.skipReviewed && existing?.body && reviewedSha(existing.body) === pull.head.sha) {
    console.log(`#${pull.number}: already reviewed at ${pull.head.sha.slice(0, 7)}.`);
    return;
  }
  const diff = await github<string>(`/repos/${repository}/pulls/${pull.number}`, token, {}, "application/vnd.github.diff");
  const commits = await github<{ commit: { message: string } }[]>(
    `/repos/${repository}/pulls/${pull.number}/commits?per_page=100`,
    token,
  );
  const input: ReviewInput = { issues, prNumber: pull.number, prTitle: pull.title, prBody: body, diff };
  const prompt = reviewPrompt(input, readFileSync(SKILL, "utf8"), readFileSync(INSTRUCTIONS, "utf8"));
  if (options.out) {
    mkdirSync(options.out, { recursive: true });
    writeFileSync(join(options.out, `pr-${pull.number}.prompt.md`), prompt);
  }
  const family =
    options.reviewer ??
    reviewerFamily(
      commits.map((c) => c.commit.message),
      installedFamilies(),
    );
  if (!family) {
    console.log(
      `#${pull.number}: no Claude Code or Codex CLI of another family than the fixer's is installed; ${options.out ? "prompt only" : "no review"}.`,
    );
    return;
  }
  const review = complete(family, prompt);
  if (options.out) writeFileSync(join(options.out, `pr-${pull.number}.review.md`), review);
  if (options.post) {
    const comment = JSON.stringify({ body: commentBody(review, family, pull.head.sha) });
    await github(
      existing
        ? `/repos/${repository}/issues/comments/${existing.id}`
        : `/repos/${repository}/issues/${pull.number}/comments`,
      token,
      { method: existing ? "PATCH" : "POST", body: comment },
    );
  }
  console.log(`#${pull.number}: reviewed by ${family === "anthropic" ? "Claude Code" : "Codex"}${options.post ? " and posted" : ""}.`);
}

/** Pull requests to `main`, most recently updated first. */
async function* recentPulls(repository: string, token: string, state: "closed" | "all") {
  for (let page = 1; page <= 10; page++) {
    const pulls = await github<Pull[]>(
      `/repos/${repository}/pulls?state=${state}&base=main&sort=updated&direction=desc&per_page=50&page=${page}`,
      token,
    );
    if (!pulls.length) return;
    yield* pulls;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const repository = process.env.GITHUB_REPOSITORY ?? "Gulliby-development/baked";
  const token = githubToken();
  const out = value("--out");
  const pr = value("--pr");
  const since = value("--since");
  const last = value("--last");
  const reviewerArg = value("--reviewer");
  const reviewer: Family | undefined =
    reviewerArg === "claude" ? "anthropic" : reviewerArg === "codex" ? "openai" : undefined;
  const options: Options = { post: args.includes("--post"), ...(out ? { out } : {}), ...(reviewer ? { reviewer } : {}) };
  try {
    if (pr) {
      const pull = await github<Pull>(`/repos/${repository}/pulls/${Number(pr)}`, token);
      await reviewPull(repository, pull, token, options);
    } else if (since) {
      // The bench loop's pass: open and merged fix pull requests updated since the date, each
      // reviewed once per head commit.
      const from = Date.parse(since);
      for await (const pull of recentPulls(repository, token, "all")) {
        if (Date.parse(pull.updated_at) < from) break;
        if (pull.state === "closed" && !pull.merged_at) continue;
        await reviewPull(repository, pull, token, { ...options, skipReviewed: true }).catch((error) =>
          console.warn(`#${pull.number}: review skipped: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
    } else if (last && out) {
      // The offline evaluation: the last N merged pull requests that closed a Bug issue.
      let left = Number(last);
      for await (const pull of recentPulls(repository, token, "closed")) {
        if (left <= 0) break;
        if (!pull.merged_at || !(await bugIssues(repository, pull.body ?? "", token)).length) continue;
        await reviewPull(repository, pull, token, { ...options, post: false });
        left--;
      }
    } else {
      console.error(
        "Usage: bun run review:adversarial --pr N [--post] [--out DIR] [--reviewer claude|codex] | --since YYYY-MM-DD [--post] | --last N --out DIR",
      );
      process.exit(2);
    }
  } catch (error) {
    // Advisory: a failed review is reported and never fails the caller.
    console.warn(`Adversarial review skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}
