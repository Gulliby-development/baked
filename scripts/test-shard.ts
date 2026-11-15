// Runs one shard of `bun run test`: `bun scripts/test-shard.ts <index> <count>` (index from 1).
// Files go to shards by measured duration: heaviest first, each to the shard with the least time so
// far, from the per-OS table in `test-shard-weights.json`. Round-robin by name put the 17-minute
// replay corpus and the slowest workflow suites in one Windows shard, which ran 27 minutes of a
// 30-minute job while another ran 4. The shards together run exactly the files `bun test` finds.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";

export type ShardWeights = { default: number; files: Record<string, number> };

/** The table for a platform: Windows has its own; macOS and Linux use the macOS one. */
export function weightsFor(
  platform: NodeJS.Platform,
  table: Record<string, ShardWeights>,
): ShardWeights {
  const weights = table[platform === "win32" ? "windows" : "macos"];
  if (!weights) throw new Error(`test-shard-weights.json has no table for ${platform}`);
  return weights;
}

/** Every test file, `/`-separated and sorted, as `bun test` finds them. */
export function testFiles(cwd = process.cwd()): string[] {
  return [...new Glob("tests/**/*.test.{ts,tsx}").scanSync({ cwd, dot: false })]
    .map((file) => file.replaceAll("\\", "/"))
    .sort();
}

/**
 * Splits `files` into `count` shards of similar measured time: heaviest file first, each to the
 * lightest shard (the lowest index on a tie). A file the table lacks weighs its default. The same
 * files and table give the same shards on every runner; each file lands in exactly one shard.
 */
export function planShards(
  files: readonly string[],
  count: number,
  weights: ShardWeights,
): string[][] {
  const weight = (file: string) => weights.files[file] ?? weights.default;
  const order = [...new Set(files)].sort(
    (a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], seconds: 0 }));
  for (const file of order) {
    let lightest = shards[0];
    for (const shard of shards) if (shard.seconds < lightest.seconds) lightest = shard;
    lightest.files.push(file);
    lightest.seconds += weight(file);
  }
  return shards.map((shard) => shard.files.sort());
}

/**
 * The shards (from 1) that `planShards` gives at least one of `files`. A pull request's picked tests
 * often fill one or two shards; the rest would only start a Windows or macOS runner to exit (#2915).
 */
/**
 * Measured seconds from which a test file runs in a `bun test` process of its own (#3034). On
 * macOS, a subprocess test that ran after the replay corpus's pools file (6 to 10 minutes of
 * synchronous replay) in the same process waited 30 s for a child whose exit never arrived, while
 * the same test passed in a process of its own; it hit four merge queue runs in shard 1/4.
 */
export const ALONE_SECONDS = 240;

/**
 * The `bun test` processes one shard runs: every file lighter than `aloneSeconds` together, first,
 * then each heavier file alone.
 */
export function processGroups(
  shard: readonly string[],
  weights: ShardWeights,
  aloneSeconds = ALONE_SECONDS,
): string[][] {
  const weight = (file: string) => weights.files[file.replace(/^\.\//, "")] ?? weights.default;
  const alone = shard.filter((file) => weight(file) >= aloneSeconds);
  const rest = shard.filter((file) => weight(file) < aloneSeconds);
  return [rest, ...alone.map((file) => [file])].filter((group) => group.length > 0);
}

/** One JUnit report of several, for the scripts that read its `<testcase>` tags. */
export function mergeReports(reports: readonly string[]): string {
  const suites = reports.map((xml) =>
    xml
      .replace(/<\?xml[^>]*\?>/, "")
      .replace(/<testsuites\b[^>]*>/, "")
      .replace(/<\/testsuites>\s*$/, "")
      .trim(),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join("\n")}\n</testsuites>\n`;
}

export function busyShards(files: readonly string[], count: number, weights: ShardWeights): number[] {
  return planShards(files, count, weights).flatMap((shard, index) => (shard.length ? [index + 1] : []));
}

if (import.meta.main) await main();

async function main() {
  // `--busy <windows|macos> <count>` prints, between spaces, the shards that get one of TEST_FILES,
  // so the workflow starts a runner only for those: ` 1 3 `.
  if (process.argv[2] === "--busy") {
    const [table, shards] = process.argv.slice(3);
    const files = process.env.TEST_FILES?.trim().split(/\s+/).filter(Boolean) ?? [];
    const all = JSON.parse(readFileSync(join(import.meta.dir, "test-shard-weights.json"), "utf8"));
    const weights = all[table ?? ""] as ShardWeights | undefined;
    const count = Number(shards);
    if (!weights || !Number.isInteger(count) || count < 1) {
      console.error("usage: bun scripts/test-shard.ts --busy <windows|macos> <count>");
      process.exit(2);
    }
    console.log(` ${busyShards(files, count, weights).join(" ")} `);
    return;
  }
  // TEST_FILES lists the test files to run, separated by spaces, instead of all of them: a pull
  // request runs the ones scripts/pr-targeted-tests.ts picks, spread over the same shards by
  // measured time. In one shard, a pull request that changed the three replay-corpus files (about
  // 25 minutes on Windows) plus the tests naming its sources passed the job's 30 minutes (#2907).
  const list = process.env.TEST_FILES?.trim();
  const [index, count] = process.argv.slice(2).map(Number);
  const valid = Number.isInteger(index) && Number.isInteger(count) && index >= 1 && index <= count;
  if (!valid) {
    console.error("usage: bun scripts/test-shard.ts <index> <count>");
    process.exit(2);
  }

  const files = list ? list.split(/\s+/) : testFiles();
  const table = JSON.parse(readFileSync(join(import.meta.dir, "test-shard-weights.json"), "utf8"));
  const weights = weightsFor(process.platform, table);
  const shard = planShards(files, count, weights)[index - 1].map((file) => `./${file}`);
  const seconds = shard.reduce(
    (sum, file) => sum + (weights.files[file.slice(2)] ?? weights.default),
    0,
  );
  console.log(
    `Shard ${index}/${count}: ${shard.length} of ${files.length} test files, about ${(seconds / 60).toFixed(1)} min measured`,
  );
  if (shard.length === 0) process.exit(0);

  // Windows starts processes and creates files several times slower than Linux: a workflow scenario
  // that takes 1 s on Linux takes 5-25 s on a Windows runner, and a busy runner stretches that past
  // 30 s at random (#1177). The tests are the same; only the time they may take differs.
  const timeout = process.platform === "win32" ? "90000" : "30000";
  const dir = mkdtempSync(join(tmpdir(), "baked-shard-"));
  const report = join(dir, "junit.xml");
  // A file of several minutes runs in a process of its own, so what it leaves behind in a process
  // never reaches the subprocess tests of the files after it (#3034).
  const groups = processGroups(shard, weights);
  let code = 0;
  const reports: string[] = [];
  for (const [i, group] of groups.entries()) {
    const groupReport = join(dir, `junit-${String(i)}.xml`);
    if (groups.length > 1)
      console.log(`Process ${String(i + 1)}/${String(groups.length)}: ${String(group.length)} test files`);
    const proc = Bun.spawn(
      [
        "bun",
        "test",
        "--timeout",
        timeout,
        "--reporter=junit",
        `--reporter-outfile=${groupReport}`,
        ...group,
      ],
      { stdio: ["inherit", "inherit", "inherit"] },
    );
    code ||= await proc.exited;
    if (existsSync(groupReport)) reports.push(readFileSync(groupReport, "utf8"));
  }
  if (reports.length) writeFileSync(report, mergeReports(reports));
  // Tests that came close to their limit, before they time out on a busy runner (#1656).
  // SLOW_TESTS_FAIL=1 (the nightly run) fails the shard for a test above 80 percent of it.
  const slowCode = existsSync(report)
    ? await Bun.spawn(
        [
          "bun",
          join(import.meta.dir, "slow-tests.ts"),
          report,
          timeout,
          ...(process.env.SLOW_TESTS_FAIL === "1" ? ["--fail"] : []),
        ],
        { stdio: ["inherit", "inherit", "inherit"] },
      ).exited
    : 0;
  // A failed run reruns each failed test alone and records whether it is likely flaky (#1724). The
  // shard still fails: the ledger only says which failures to fix as flakes.
  const ledger = process.env.FLAKY_LEDGER;
  if (code !== 0 && ledger && existsSync(report))
    await Bun.spawn(["bun", join(import.meta.dir, "flaky-ledger.ts"), report, timeout, ledger], {
      stdio: ["inherit", "inherit", "inherit"],
    }).exited;
  process.exit(code || slowCode);
}
