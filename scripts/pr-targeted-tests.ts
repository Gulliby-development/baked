// Picks the test files a pull request should run on Windows and macOS before it enters the merge
// queue: `bun scripts/pr-targeted-tests.ts <base-sha> <out-file>`. The full platform suites run only
// in the queue, where one pull request's Windows-only failure ejects every pull request grouped
// behind it; on 2026-11-03 most ejections were new or changed tests of the pull request itself (a
// test of #2805 alone failed 31 queue jobs). The pick: every changed test file, then the test files
// that name a changed source or fixture file, lightest first, within a time budget.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type ShardWeights, testFiles, weightsFor } from "./test-shard.ts";

/** About 12 minutes of measured Windows time on top of the changed tests themselves. */
export const BUDGET_SECONDS = 12 * 60;

/** The text a test file uses to name a changed file: its path from the repository root, without extension. */
export function reference(changed: string): string | null {
  const file = changed.replaceAll("\\", "/");
  // Tests start a fixture by its file name (`fixture("workflow-worker.ts")`).
  if (file.startsWith("tests/fixtures/")) return basename(file);
  if (!file.startsWith("src/") || !/\.[cm]?[jt]sx?$/.test(file)) return null;
  const stem = file.slice("src/".length).replace(/\.[cm]?[jt]sx?$/, "");
  // `.../index` is imported by its directory as often as by its name; the directory is the reference.
  return basename(stem) === "index" ? stem.slice(0, -"/index".length) : stem;
}

export function targetedTests(
  changed: readonly string[],
  files: readonly string[],
  read: (file: string) => string,
  weights: ShardWeights,
  budget = BUDGET_SECONDS,
): string[] {
  const all = new Set(files);
  const picked = changed.map((f) => f.replaceAll("\\", "/")).filter((f) => all.has(f));
  const refs = changed.map(reference).filter((r): r is string => r !== null);
  if (!refs.length) return [...new Set(picked)].sort();
  const weight = (file: string) => weights.files[file] ?? weights.default;
  const naming = files
    .filter((file) => !picked.includes(file))
    .filter((file) => {
      const text = read(file);
      return refs.some((ref) =>
        ref.includes("/")
          ? text.includes(`/${ref}.`) || text.includes(`/${ref}"`) || text.includes(`/${ref}/index.`)
          : text.includes(`"${ref}"`) || text.includes(`/${ref}"`),
      );
    })
    .sort((a, b) => weight(a) - weight(b) || (a < b ? -1 : 1));
  let spent = 0;
  for (const file of naming) {
    if (spent + weight(file) > budget) break;
    spent += weight(file);
    picked.push(file);
  }
  return [...new Set(picked)].sort();
}

if (import.meta.main) {
  const [base, out] = process.argv.slice(2);
  if (!base || !out) {
    console.error("usage: bun scripts/pr-targeted-tests.ts <base-sha> <out-file>");
    process.exit(2);
  }
  const diff = Bun.spawnSync(["git", "diff", "--name-only", "--diff-filter=d", `${base}...HEAD`]);
  if (diff.exitCode !== 0) {
    console.error(diff.stderr.toString());
    process.exit(1);
  }
  const changed = diff.stdout.toString().split("\n").filter(Boolean);
  const table = JSON.parse(readFileSync(join(import.meta.dir, "test-shard-weights.json"), "utf8"));
  const picked = targetedTests(changed, testFiles(), (f) => readFileSync(f, "utf8"), weightsFor("win32", table));
  writeFileSync(out, picked.join("\n"));
  console.log(`${picked.length} test files for ${changed.length} changed files:\n${picked.join("\n")}`);
}
