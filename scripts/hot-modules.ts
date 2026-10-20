/**
 * Hot harness modules (#1718, #1723): the modules in `.github/hot-modules.json` where a fix has
 * repeatedly caused the next bench stop. One list serves three commands:
 *
 *   bun scripts/hot-modules.ts touched --base <ref>
 *     The hot modules the diff from <ref> touches, as a Markdown summary. In CI it also writes
 *     `modules=<ids>` to GITHUB_OUTPUT, so the workflow labels the pull request and runs the
 *     modules' tests and the forecast replay.
 *   bun scripts/hot-modules.ts escape --issues <issues.json> --rounds <rounds.json> [--from N] [--to N] [--by-file] [--json]
 *     Escape rate per module: the share of bug-fix merges followed, within the two bench rounds
 *     that measure them, by a new bench-loop issue naming a file of the same module.
 *     `--by-file` treats every source file a fix touched as its own module, to find new hot ones.
 *   bun scripts/hot-modules.ts mutate --module <id> [--max N] [--budget-min M] [--out report.json] [--issue issue.md] [--recent-days D]
 *     Runs the built-in mutation engine over the module's files with the module's tests and
 *     reports surviving mutants; the report says whether the module had a bug fix in the last D days.
 *     With `--issue`, survivors in a module with such a fix are written as an issue body to that file.
 *
 * Issues come from `gh api --paginate --slurp 'repos/OWNER/REPO/issues?labels=bench-loop&state=all&per_page=100'`;
 * rounds from the bench stats `rounds.json` (`report-YYYYMMDDTHHMMSS-*.md` names give each round's end).
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  generateMutants,
  type MutationResult,
  runMutants,
} from "../src/core/workflows/quality/mutation.js";
import type { ChangedFile } from "../src/core/workflows/quality/rules.js";

export interface HotModule {
  id: string;
  title: string;
  paths: string[];
}

export const HOT_MODULES_FILE = ".github/hot-modules.json";

export function loadHotModules(root = "."): HotModule[] {
  const parsed = JSON.parse(readFileSync(join(root, HOT_MODULES_FILE), "utf8")) as { modules: HotModule[] };
  return parsed.modules;
}

/** The modules owning one of `files` (repository-relative, `/`-separated). */
export function touchedModules(modules: HotModule[], files: string[]): HotModule[] {
  const changed = new Set(files.map((file) => file.replaceAll("\\", "/")));
  return modules.filter((module) => module.paths.some((path) => changed.has(path)));
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Test files that import one of the module's paths, so the list never goes stale. */
export function moduleTests(module: HotModule, tests: { path: string; content: string }[]): string[] {
  const specifiers = module.paths.map(
    (path) => new RegExp(`["'][./]*${escapeRegex(path.replace(/\.tsx?$/, ""))}(?:\\.[jt]sx?)?["']`),
  );
  return tests
    .filter((test) => specifiers.some((specifier) => specifier.test(test.content)))
    .map((test) => test.path)
    .sort();
}

export interface FixMerge {
  /** `#N` of the pull request, or the merge commit's short hash. */
  ref: string;
  mergedAt: string;
  files: string[];
}

export interface LoopIssue {
  number: number;
  createdAt: string;
  text: string;
}

export interface RoundEnd {
  round: number;
  end: string;
}

export interface ModuleEscapes {
  id: string;
  /** Fixes whose two measuring rounds have both ended. */
  fixes: number;
  escaped: number;
  /** Fixes still waiting for their second measuring round. */
  pending: number;
  /** escaped / fixes, null when no fix is measured yet. */
  rate: number | null;
  escapes: { fix: string; issue: number }[];
}

/** Whether an issue names one of the module's files: the full path or the file name. */
function namesModule(module: HotModule, text: string): boolean {
  return module.paths.some((path) => {
    const name = basename(path);
    return text.includes(path) || new RegExp(`(?<![\\w-])${escapeRegex(name)}\\b`).test(text);
  });
}

/**
 * Escape rate per module. A fix merged while round r ran is first measured in round r+1 (the
 * runner stays on one commit for a round), so its window is from the merge to the end of round
 * r+2. An escape is a bench-loop issue opened in that window that names a file of the module.
 * `from`/`to` select fixes by the round they merged in.
 */
export function escapeRates(
  modules: HotModule[],
  fixes: FixMerge[],
  issues: LoopIssue[],
  rounds: RoundEnd[],
  options: { from?: number; to?: number } = {},
): ModuleEscapes[] {
  const ordered = [...rounds].sort((a, b) => a.round - b.round);
  const ends = ordered.map((round) => Date.parse(round.end));
  return modules.map((module) => {
    const out: ModuleEscapes = { id: module.id, fixes: 0, escaped: 0, pending: 0, rate: null, escapes: [] };
    for (const fix of fixes) {
      if (!touchedModules([module], fix.files).length) continue;
      const merged = Date.parse(fix.mergedAt);
      const index = ends.findIndex((end) => end >= merged);
      const round = index >= 0 ? ordered[index]?.round : undefined;
      // A fix merged after the last known round is in a round that has not ended yet.
      const inRound = round ?? (ordered.at(-1)?.round ?? 0) + 1;
      if (options.from !== undefined && inRound < options.from) continue;
      if (options.to !== undefined && inRound > options.to) continue;
      const windowEnd = index >= 0 ? ends[index + 2] : undefined;
      if (windowEnd === undefined) {
        out.pending++;
        continue;
      }
      out.fixes++;
      const escape = issues.find((issue) => {
        const created = Date.parse(issue.createdAt);
        return created > merged && created <= windowEnd && namesModule(module, issue.text);
      });
      if (escape) {
        out.escaped++;
        out.escapes.push({ fix: fix.ref, issue: escape.number });
      }
    }
    out.rate = out.fixes ? out.escaped / out.fixes : null;
    return out;
  });
}

/** One module per source file a fix touched, for `escape --by-file`. */
export function fileModules(fixes: FixMerge[]): HotModule[] {
  const files = new Set(fixes.flatMap((fix) => fix.files).filter((file) => /^src\/.*\.tsx?$/.test(file)));
  return [...files].sort().map((file) => ({ id: file, title: file, paths: [file] }));
}

/**
 * The `## Where` section of a bug issue (the file-issue skill's list of defect sites), or the whole
 * body when it has none: a file the issue only mentions in passing is not where the bug is.
 */
export function whereSection(body: string): string {
  const heading = /^#{2,3}\s+Where\b.*$/im.exec(body);
  if (!heading) return body;
  const rest = body.slice(heading.index + heading[0].length);
  const next = /^#{1,3}\s/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Reads `gh api --paginate [--slurp]` output for the issues endpoint; pull requests and ideas are dropped. */
export function parseIssues(json: string): LoopIssue[] {
  type Raw = {
    number: number;
    title?: string;
    body?: string | null;
    created_at?: string;
    createdAt?: string;
    pull_request?: unknown;
    labels?: Array<string | { name?: string }>;
    type?: { name?: string } | null;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // `gh api --paginate` without --slurp prints one array per page back to back.
    parsed = JSON.parse(`[${json.trim().replace(/\]\s*\[/g, "],[")}]`);
  }
  const flat = (Array.isArray(parsed) ? parsed : [parsed]).flat(2) as Raw[];
  return flat
    .filter((issue) => !issue.pull_request)
    .filter((issue) => {
      const labels = (issue.labels ?? []).map((label) => (typeof label === "string" ? label : (label.name ?? "")));
      return !labels.includes("idea") && issue.type?.name !== "Feature";
    })
    .map((issue) => ({
      number: issue.number,
      createdAt: issue.created_at ?? issue.createdAt ?? "",
      text: `${issue.title ?? ""}\n${whereSection(issue.body ?? "")}`,
    }));
}

/** Round ends from `[{round, end}]` or the bench stats `rounds.json` (`report-YYYYMMDDTHHMMSS-*.md`). */
export function parseRounds(json: string): RoundEnd[] {
  const parsed = JSON.parse(json) as unknown;
  const list = (Array.isArray(parsed) ? parsed : (parsed as { rounds?: unknown[] }).rounds ?? []) as Array<{
    round: number;
    end?: string;
    report?: string;
  }>;
  const out: RoundEnd[] = [];
  for (const entry of list) {
    if (entry.end) {
      out.push({ round: entry.round, end: entry.end });
      continue;
    }
    const stamp = /report-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(entry.report ?? "");
    if (stamp) {
      const [, y, mo, d, h, mi, s] = stamp;
      out.push({ round: entry.round, end: `${y}-${mo}-${d}T${h}:${mi}:${s}Z` });
    }
  }
  return out;
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/** Bug-fix merges into the first-parent history of `ref`, with the files each changed. */
export function fixMerges(root: string, ref = "HEAD", since?: string): FixMerge[] {
  const log = git(root, [
    "log",
    "--first-parent",
    "--merges",
    "--format=%H%x09%cI%x09%s",
    ...(since ? [`--since=${since}`] : []),
    ref,
  ]);
  const out: FixMerge[] = [];
  for (const line of log.split("\n")) {
    const [hash, date, subject] = line.split("\t");
    if (!hash || !date || !subject || !/\bbugfix\//.test(subject)) continue;
    const files = git(root, ["diff", "--name-only", `${hash}^1`, hash]).split("\n").filter(Boolean);
    const pr = /#(\d+)/.exec(subject);
    out.push({ ref: pr ? `#${pr[1]}` : hash.slice(0, 8), mergedAt: date, files });
  }
  return out;
}

function testFiles(root: string): { path: string; content: string }[] {
  return readdirSync(join(root, "tests"))
    .filter((name) => /\.test\.tsx?$/.test(name))
    .map((name) => ({ path: `tests/${name}`, content: readFileSync(join(root, "tests", name), "utf8") }));
}

export interface ModuleMutation {
  module: string;
  tests: string[];
  /** Bug-fix merges that touched the module in the recent window. */
  recentFixes: string[];
  result: MutationResult;
}

/** Plants mutants in the module's files one at a time and runs the module's tests against each. */
export async function mutateModule(
  root: string,
  module: HotModule,
  options: { max: number; budgetMs: number; recentDays: number },
): Promise<ModuleMutation> {
  const tests = moduleTests(module, testFiles(root));
  const files: ChangedFile[] = module.paths.map((path) => ({
    path,
    content: readFileSync(join(root, path), "utf8"),
    before: null,
  }));
  const originals = new Map(module.paths.map((path) => [path, readFileSync(join(root, path))]));
  const mutants = generateMutants(files, options.max);
  const result = await runMutants("advisory", tests.length ? mutants : [], files, tests, {
    plant: async (path, content) => writeFileSync(join(root, path), content),
    restore: async (path) => {
      const original = originals.get(path);
      if (original) writeFileSync(join(root, path), original);
    },
    test: async (timeLeftMs) => {
      const run = spawnSync("bun", ["test", "--bail", "--timeout", "30000", ...tests], {
        cwd: root,
        encoding: "utf8",
        timeout: timeLeftMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (run.error && (run.error as NodeJS.ErrnoException).code === "ETIMEDOUT") return { status: "timeout" };
      return run.status === 0 ? { status: "passed" } : { status: "failed", check: "module tests" };
    },
    now: () => Date.now(),
  }, { budgetMs: options.budgetMs });
  const since = new Date(Date.now() - options.recentDays * 86_400_000).toISOString();
  const recentFixes = fixMerges(root, "HEAD", since)
    .filter((fix) => touchedModules([module], fix.files).length)
    .map((fix) => fix.ref);
  return { module: module.id, tests, recentFixes, result };
}

/** The Markdown report of a mutation run: score, survivors with their mutation, and recent fixes. */
export function mutationMarkdown(run: ModuleMutation): string {
  const { result } = run;
  const survivors = result.mutants.filter((mutant) => mutant.status === "survived");
  const counts = (status: string) => result.mutants.filter((mutant) => mutant.status === status).length;
  const lines = [
    `### Hot module \`${run.module}\``,
    "",
    `Score: ${result.score === null ? "n/a" : `${result.score}%`} (killed ${counts("killed")}, timed out ${counts("timeout")}, survived ${survivors.length}, not run ${counts("not-run")}) with ${run.tests.length} test files.`,
    ...(result.note ? ["", `Note: ${result.note}.`] : []),
    ...(run.recentFixes.length ? ["", `Recent bug fixes in this module: ${run.recentFixes.join(", ")}.`] : []),
  ];
  if (survivors.length) {
    lines.push("", "| Mutant | Place | Operator | Change |", "| --- | --- | --- | --- |");
    for (const mutant of survivors) {
      const change = `\`${mutant.original.trim()}\` → \`${mutant.mutated.trim()}\``.replaceAll("|", "\\|");
      lines.push(`| ${mutant.id} | \`${mutant.file}:${mutant.line}\` | ${mutant.operator} | ${change} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The issue body for survivors in a module a bug fix touched recently, or null: a recent fix whose
 * scenario test guards only its own path is what the weekly run is for (#1723).
 */
export function mutationIssue(run: ModuleMutation): string | null {
  if (!run.recentFixes.length || !run.result.mutants.some((m) => m.status === "survived")) return null;
  return [
    "Priority: P2",
    "",
    `The weekly mutation run of hot module \`${run.module}\` left mutants alive in code that ${run.recentFixes.join(", ")} changed recently. Each survivor is a change of behavior no test of the module notices: add a test that kills it, or say why it is equivalent.`,
    "",
    mutationMarkdown(run),
  ].join("\n");
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function percent(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 100)}%`;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const root = process.cwd();
  const modules = loadHotModules(root);
  if (command === "touched") {
    const base = flag(args, "--base") ?? "origin/main";
    const files = git(root, ["diff", "--name-only", `${base}...HEAD`]).split("\n").filter(Boolean);
    const touched = touchedModules(modules, files);
    const ids = touched.map((module) => module.id);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `modules=${ids.join(" ")}\n`);
    const tests = [...new Set(touched.flatMap((module) => moduleTests(module, testFiles(root))))].sort();
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tests=${tests.join(" ")}\n`);
    const summary = touched.length
      ? [
          "### Hot modules touched",
          "",
          ...touched.map((module) => `- \`${module.id}\` (${module.title})`),
          "",
          "The error budget applies: one behavior change per hot module per bench round, and after a round with two or more stops caused by fresh fixes only reverts and regression fixes (AGENTS.md, docs/bench-loop.md#hot-modules).",
        ].join("\n")
      : "No hot module is touched.";
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  } else if (command === "escape") {
    const issuesPath = flag(args, "--issues");
    const roundsPath = flag(args, "--rounds");
    if (!issuesPath || !roundsPath) {
      console.error("Usage: bun scripts/hot-modules.ts escape --issues <issues.json> --rounds <rounds.json> [--from N] [--to N] [--by-file] [--json]");
      process.exit(2);
    }
    const fixes = fixMerges(root, flag(args, "--ref") ?? "HEAD");
    const from = flag(args, "--from");
    const to = flag(args, "--to");
    const rates = escapeRates(
      args.includes("--by-file") ? fileModules(fixes) : modules,
      fixes,
      parseIssues(readFileSync(issuesPath, "utf8")),
      parseRounds(readFileSync(roundsPath, "utf8")),
      { ...(from ? { from: Number(from) } : {}), ...(to ? { to: Number(to) } : {}) },
    ).filter((entry) => !args.includes("--by-file") || entry.fixes + entry.pending > 0);
    if (args.includes("--json")) console.log(JSON.stringify(rates, null, 2));
    else {
      console.log("| Module | Fixes measured | Escaped | Escape rate | Pending | Escapes (fix → issue) |");
      console.log("| --- | --- | --- | --- | --- | --- |");
      for (const entry of rates)
        console.log(
          `| ${entry.id} | ${entry.fixes} | ${entry.escaped} | ${percent(entry.rate)} | ${entry.pending} | ${entry.escapes.map((e) => `${e.fix} → #${e.issue}`).join(", ")} |`,
        );
    }
  } else if (command === "mutate") {
    const id = flag(args, "--module");
    const module = modules.find((candidate) => candidate.id === id);
    if (!module) {
      console.error(`Unknown module ${JSON.stringify(id)}; one of: ${modules.map((m) => m.id).join(", ")}`);
      process.exit(2);
    }
    const run = await mutateModule(root, module, {
      max: Number(flag(args, "--max") ?? 24),
      budgetMs: Number(flag(args, "--budget-min") ?? 40) * 60_000,
      recentDays: Number(flag(args, "--recent-days") ?? 14),
    });
    const out = flag(args, "--out");
    if (out) writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`);
    const markdown = mutationMarkdown(run);
    console.log(markdown);
    const issue = flag(args, "--issue");
    const body = mutationIssue(run);
    if (issue && body) writeFileSync(issue, body);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  } else {
    console.error("Usage: bun scripts/hot-modules.ts touched|escape|mutate ...");
    process.exit(2);
  }
}
