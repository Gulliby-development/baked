// Runs one shard of `bun run test`: `bun scripts/test-shard.ts <index> <count>` (index from 1).
// Files go to shards by measured duration: heaviest first, each to the shard with the least time so
// far, from the per-OS table in `test-shard-weights.json`. Round-robin by name put the 17-minute
// replay corpus and the slowest workflow suites in one Windows shard, which ran 27 minutes of a
// 30-minute job while another ran 4. The shards together run exactly the files `bun test` finds.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

if (import.meta.main) await main();

async function main() {
  const [index, count] = process.argv.slice(2).map(Number);
  const valid = Number.isInteger(index) && Number.isInteger(count) && index >= 1 && index <= count;
  if (!valid) {
    console.error("usage: bun scripts/test-shard.ts <index> <count>");
    process.exit(2);
  }

  const files = testFiles();
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
  const report = join(mkdtempSync(join(tmpdir(), "baked-shard-")), "junit.xml");
  const proc = Bun.spawn(
    [
      "bun",
      "test",
      "--timeout",
      timeout,
      "--reporter=junit",
      `--reporter-outfile=${report}`,
      ...shard,
    ],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  const code = await proc.exited;
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
