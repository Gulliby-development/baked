import { isStaticCheck, isWholeUnitCheck } from "./check-policy.js";
import { isTestCheck } from "./quality/mutation.js";
import type { Check } from "./types.js";

/**
 * The committed-tree check (#2225, follow-up of #2214). The checks stage runs every required check
 * on the run's working tree, but a feature ships its commit: R70 namesound's commands feature was
 * accepted with rubocop passing on CRLF files whose committed LF form had 3 offenses, and the next
 * feature, started from a clean checkout, blocked on them. Any difference between the two trees
 * (an ending the commit normalizes, an untracked or ignored helper file a check reads) stays
 * invisible until then.
 *
 * After a worktree run's accepted commit the scheduler (`committedTreeCheck`) records:
 * - `eol/guard.json`: each text file of the commit whose working ending differs from what a
 *   checkout of the commit gives (`eolMismatches` on `git ls-files --eol`), the paths the eol
 *   guard would normalize before running the checks again;
 * - `committed-tree/check.json`: the file-local static required checks (`committedTreeChecks`)
 *   that passed on the working tree, run once more in a clean worktree of the commit. A check
 *   that fails there is the `committed_tree` would-stop (`committedTreeFailures`).
 * Both ship in shadow: acceptance goes on, and enforcing blocks the feature in a PR of its own.
 */
export const EOL_GUARD_KIND = "eol-guard";
export const EOL_GUARD_PATH = "eol/guard.json";
export const COMMITTED_TREE_KIND = "committed-tree";
export const COMMITTED_TREE_PATH = "committed-tree/check.json";

/** One line of `git ls-files --eol`: the index and working endings and the eol attributes. */
export interface EolEntry {
  path: string;
  /** `lf`, `crlf`, `mixed`, `none` or `-text` (binary), as git prints after `i/`. */
  index: string;
  /** The same for the working file, empty when it is missing. */
  working: string;
  /** What git prints after `attr/`, such as `text=auto eol=lf`; empty without one. */
  attr: string;
}

/** Parses `git ls-files --eol -z`. */
export function parseLsFilesEol(output: string): EolEntry[] {
  const entries: EolEntry[] = [];
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const head = record.slice(0, tab);
    const index = /(?:^|\s)i\/(\S*)/.exec(head)?.[1] ?? "";
    const working = /(?:^|\s)w\/(\S*)/.exec(head)?.[1] ?? "";
    const attr = /(?:^|\s)attr\/(.*)$/.exec(head)?.[1]?.trim() ?? "";
    entries.push({ path: record.slice(tab + 1), index, working, attr });
  }
  return entries;
}

/**
 * The ending a checkout of the commit gives a text file: the `eol` attribute, else CRLF where
 * `core.autocrlf` is true, else what the index holds. Null for a file git does not treat as text
 * with one ending (binary, `-text`, mixed or empty in the index).
 */
export function checkoutEnding(
  entry: Pick<EolEntry, "index" | "attr">,
  autocrlf: boolean,
): "lf" | "crlf" | null {
  if (entry.index !== "lf" && entry.index !== "crlf") return null;
  const attrs = entry.attr.split(/\s+/);
  if (attrs.includes("-text")) return null;
  if (attrs.includes("eol=lf")) return "lf";
  if (attrs.includes("eol=crlf")) return "crlf";
  if (autocrlf && entry.index === "lf") return "crlf";
  return entry.index;
}

export interface EolMismatch {
  path: string;
  /** The ending a checkout of the commit gives. */
  committed: "lf" | "crlf";
  /** The ending of the working file the checks read. */
  working: string;
}

/**
 * The files whose working ending is not what a checkout of the commit gives (#2225 (c)): a LF
 * file a fixer left CRLF under `eol=lf`, or a new file written with the other ending. Only `paths`
 * when given (the files the run's commit changed), so a checkout's own endings are not listed.
 */
export function eolMismatches(
  entries: readonly EolEntry[],
  options: { autocrlf: boolean; paths?: ReadonlySet<string> },
): EolMismatch[] {
  const mismatches: EolMismatch[] = [];
  for (const entry of entries) {
    if (options.paths && !options.paths.has(entry.path)) continue;
    const committed = checkoutEnding(entry, options.autocrlf);
    if (!committed || !["lf", "crlf", "mixed"].includes(entry.working)) continue;
    if (entry.working !== committed)
      mismatches.push({ path: entry.path, committed, working: entry.working });
  }
  return mismatches.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The checks run again on the commit (#2225 (d)): required feature-scope checks that lint or
 * format one file at a time (a fixer, a linter, a formatter), the cheap ones whose result an
 * ending or a stray file changes. Test suites and whole-unit analyzers stay at the checks stage.
 */
export function committedTreeChecks(checks: readonly Check[]): Check[] {
  return checks.filter(
    (check) =>
      check.required &&
      check.scope === "feature" &&
      isStaticCheck(check) &&
      !isTestCheck(check) &&
      !isWholeUnitCheck(check),
  );
}

export interface CommittedTreeResult {
  checkId: string;
  /** `unavailable`: the command did not start or the copy could not be made. */
  status: "passed" | "failed" | "timeout" | "unavailable";
  /** The end of its output, for a failed check. */
  output?: string;
}

export interface CommittedTreeRecord {
  commit: string;
  snapshotId: string;
  /** Why no check ran on the commit (no copy could be made). */
  note?: string;
  results: CommittedTreeResult[];
}

/**
 * The checks that passed on the working tree and fail on the commit: each is a `committed_tree`
 * would-stop. A timeout or a command that did not start says nothing about the tree.
 */
export function committedTreeFailures(record: Pick<CommittedTreeRecord, "results">): string[] {
  return record.results.filter((r) => r.status === "failed").map((r) => r.checkId);
}
