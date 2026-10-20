// Turns the flaky test ledgers of recent `OS tests` runs into Bug issues (#1724): `bun
// scripts/flaky-issues.ts [--days N] [--threshold N] [--dry-run]`. It downloads every
// `flaky-ledger-*` artifact of the window with the GitHub CLI and counts, per test, the failures
// its isolated reruns marked likely flaky. A test at the threshold gets an issue with its history,
// or a comment with its new failures on the issue it already has (reopened when closed: the fix did
// not hold). The issue is where the cause is recorded; the test is fixed, never skipped.
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEntry } from "./flaky-ledger.ts";

export const DEFAULT_DAYS = 14;
/** Likely flaky failures of one test in the window that open its issue. */
export const DEFAULT_THRESHOLD = 2;

export interface Ledger {
  schemaVersion: 1;
  commit: string | null;
  os: string;
  job: string | null;
  runId: string | null;
  event: string | null;
  tests: LedgerEntry[];
  /** When the run started, from the run list; ledgers do not record it. */
  at?: string;
}

export interface Occurrence {
  runId: string;
  os: string;
  commit: string | null;
  event: string | null;
  at: string | null;
  passes: number;
  reruns: number;
}

export interface FlakyTest {
  key: string;
  file: string;
  line: number;
  path: string[];
  /** Failures whose isolated reruns passed at least once, newest run first. */
  flaky: Occurrence[];
  /** Failures that failed every rerun: counted for the history, not toward the threshold. */
  real: number;
}

/** A stable id for a test across runs: its file and its describe path, not its line. */
export function testKey(test: Pick<LedgerEntry, "file" | "path">): string {
  return createHash("sha256")
    .update(`${test.file}\n${test.path.join("\n")}`)
    .digest("hex")
    .slice(0, 12);
}

export const issueMarker = (key: string): string => `<!-- flaky-ledger: ${key} -->`;

/** Every test with likely flaky failures in the ledgers, the most flaky first. */
export function aggregate(ledgers: readonly Ledger[]): FlakyTest[] {
  const byKey = new Map<string, FlakyTest>();
  for (const ledger of ledgers)
    for (const entry of ledger.tests) {
      if (entry.verdict === "not rerun") continue;
      const key = testKey(entry);
      const test = byKey.get(key) ?? {
        key,
        file: entry.file,
        line: entry.line,
        path: entry.path,
        flaky: [],
        real: 0,
      };
      if (entry.verdict === "real") test.real++;
      else
        test.flaky.push({
          runId: ledger.runId ?? "unknown",
          os: ledger.os,
          commit: ledger.commit,
          event: ledger.event,
          at: ledger.at ?? null,
          passes: entry.passes,
          reruns: entry.reruns,
        });
      byKey.set(key, test);
    }
  for (const test of byKey.values())
    test.flaky.sort((a, b) => Number(b.runId) - Number(a.runId) || a.os.localeCompare(b.os));
  return [...byKey.values()]
    .filter((test) => test.flaky.length > 0)
    .sort((a, b) => b.flaky.length - a.flaky.length || a.key.localeCompare(b.key));
}

/** The run ids an issue's body and comments already list, so a failure is reported once. */
export function seenRunIds(texts: readonly string[]): Set<string> {
  const seen = new Set<string>();
  for (const text of texts)
    for (const match of text.matchAll(/actions\/runs\/(\d+)/g)) if (match[1]) seen.add(match[1]);
  return seen;
}

function occurrenceRows(repo: string, occurrences: readonly Occurrence[]): string[] {
  return [
    "| Run | OS | Event | Commit | Isolated reruns passed |",
    "| --- | --- | --- | --- | --- |",
    ...occurrences.map(
      (o) =>
        `| [${o.runId}](https://github.com/${repo}/actions/runs/${o.runId}) | ${o.os} | ${o.event ?? ""} | ${o.commit?.slice(0, 10) ?? ""} | ${String(o.passes)}/${String(o.reruns)} |`,
    ),
  ];
}

export function issueTitle(test: FlakyTest): string {
  return `Flaky test: ${test.path.join(" > ")}`.slice(0, 250);
}

export function issueBody(
  repo: string,
  test: FlakyTest,
  window: { days: number; runs: number },
): string {
  return [
    "Priority: P1",
    "",
    "## Problem",
    "",
    `\`${test.file}:${String(test.line)}\` \`${test.path.join(" > ")}\` failed in ${String(test.flaky.length)} \`OS tests\` runs of the last ${String(window.days)} days (${String(window.runs)} runs in all) and passed at least one isolated rerun on the same commit and OS each time${test.real ? `. It also failed every rerun ${String(test.real)} times` : ""}. Every such failure turns a queue run red and ejects the pull requests in it.`,
    "",
    ...occurrenceRows(repo, test.flaky),
    "",
    "## Fix",
    "",
    "Find the cause (a fixed delay, shared state between tests, a timeout near the test's limit on a slow runner, an order dependence) with the [file-issue skill](https://github.com/${repo}/blob/main/.agents/skills/file-issue/SKILL.md), record it here, and fix the test or the code. Never skip, disable, quarantine or retry the test into green (AGENTS.md).",
    "",
    "Filed by the flaky test ledger (`scripts/flaky-issues.ts`, #1724). New failures are added to this issue as comments.",
    "",
    issueMarker(test.key),
  ].join("\n");
}

/**
 * The failures to add to an issue: those it does not list yet, and for a closed issue only those
 * of runs that started after it was closed, since a failure before the fix says nothing about it.
 */
export function freshOccurrences(
  test: FlakyTest,
  texts: readonly string[],
  closedAt: string | null,
): Occurrence[] {
  const seen = seenRunIds(texts);
  return test.flaky.filter(
    (o) => !seen.has(o.runId) && (closedAt === null || (o.at !== null && o.at > closedAt)),
  );
}

export function commentBody(repo: string, fresh: readonly Occurrence[], reopened: boolean): string {
  return [
    `${String(fresh.length)} more likely flaky ${fresh.length === 1 ? "failure" : "failures"} of this test${reopened ? ", so the fix did not hold and the issue is reopened" : ""}:`,
    "",
    ...occurrenceRows(repo, fresh),
  ].join("\n");
}

function gh(args: string[], options: { allowFailure?: boolean } = {}): string {
  const proc = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0 && !options.allowFailure)
    throw new Error(`gh ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  return proc.exitCode === 0 ? proc.stdout.toString() : "";
}

function ledgerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return ledgerFiles(path);
    return name.endsWith(".json") ? [path] : [];
  });
}

function option(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  const value = index >= 0 ? Number(args[index + 1]) : fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} needs a positive integer`);
  return value;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const days = option(args, "--days", DEFAULT_DAYS);
  const threshold = option(args, "--threshold", DEFAULT_THRESHOLD);
  const dryRun = args.includes("--dry-run");
  const repo = process.env.GITHUB_REPOSITORY ?? "Gulliby-development/baked";
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const list = (filter: string[]) =>
    JSON.parse(
      gh([
        "run",
        "list",
        "--repo",
        repo,
        "--workflow",
        "os-tests.yml",
        "--created",
        `>=${since}`,
        "--limit",
        "1000",
        ...filter,
        "--json",
        "databaseId,createdAt",
      ]),
    ) as { databaseId: number; createdAt: string }[];
  // Pull request runs pass at once unless the change touches the workflow, so the runs that test
  // are the queue, nightly and manual ones; ledgers come from every failed run.
  const runs = ["merge_group", "schedule", "workflow_dispatch"].flatMap((event) =>
    list(["--event", event]),
  );
  const failed = list(["--status", "failure"]);
  const root = mkdtempSync(join(tmpdir(), "flaky-ledgers-"));
  const ledgers: Ledger[] = [];
  for (const run of failed) {
    const dir = join(root, String(run.databaseId));
    // A failed run without a ledger (a build error, an expired artifact) has nothing to add.
    gh(["run", "download", String(run.databaseId), "--repo", repo, "-p", "flaky-ledger-*", "-D", dir], {
      allowFailure: true,
    });
    try {
      for (const file of ledgerFiles(dir)) {
        const ledger = JSON.parse(readFileSync(file, "utf8")) as Ledger;
        if (ledger.schemaVersion === 1)
          ledgers.push({ ...ledger, runId: ledger.runId ?? String(run.databaseId), at: run.createdAt });
      }
    } catch {
      // No artifact was downloaded for this run.
    }
  }
  const due = aggregate(ledgers).filter((test) => test.flaky.length >= threshold);
  console.log(
    `${String(runs.length)} OS tests runs since ${since}, ${String(ledgers.length)} ledgers, ${String(due.length)} tests at ${String(threshold)} or more likely flaky failures.`,
  );
  if (!dryRun && due.length)
    gh(
      [
        "label",
        "create",
        "flaky-test",
        "--repo",
        repo,
        "--color",
        "fbca04",
        "--description",
        "A test the flaky test ledger marked likely flaky (#1724)",
      ],
      { allowFailure: true },
    );
  for (const test of due) {
    const found = JSON.parse(
      gh([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--search",
        `"flaky-ledger: ${test.key}" in:body`,
        "--json",
        "number,state,closedAt",
        "--limit",
        "5",
      ]),
    ) as { number: number; state: string; closedAt: string | null }[];
    const issue = found.find((i) => i.state === "OPEN") ?? found[0];
    const file = join(root, `${test.key}.md`);
    if (!issue) {
      writeFileSync(file, issueBody(repo, test, { days, runs: runs.length }));
      console.log(`new issue: ${issueTitle(test)}`);
      if (!dryRun)
        gh([
          "issue",
          "create",
          "--repo",
          repo,
          "--title",
          issueTitle(test),
          "--body-file",
          file,
          "--label",
          "area:ci",
          "--label",
          "flaky-test",
        ]);
      continue;
    }
    const view = JSON.parse(
      gh(["issue", "view", String(issue.number), "--repo", repo, "--json", "body,comments"]),
    ) as { body: string; comments: { body: string }[] };
    const reopen = issue.state !== "OPEN";
    const fresh = freshOccurrences(
      test,
      [view.body, ...view.comments.map((c) => c.body)],
      reopen ? issue.closedAt : null,
    );
    if (!fresh.length) continue;
    writeFileSync(file, commentBody(repo, fresh, reopen));
    console.log(`#${String(issue.number)}: ${String(fresh.length)} new failures${reopen ? ", reopened" : ""}`);
    if (dryRun) continue;
    if (reopen) gh(["issue", "reopen", String(issue.number), "--repo", repo]);
    gh(["issue", "comment", String(issue.number), "--repo", repo, "--body-file", file]);
  }
}
