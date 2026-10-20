// Runs one shard of `bun run test`: `bun scripts/test-shard.ts <index> <count>` (index from 1).
// Files are spread round-robin over the sorted list, so each shard gets a similar mix of slow and
// fast suites; the shards together run exactly the files `bun test` finds.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";

const [index, count] = process.argv.slice(2).map(Number);
const valid = Number.isInteger(index) && Number.isInteger(count) && index >= 1 && index <= count;
if (!valid) {
  console.error("usage: bun scripts/test-shard.ts <index> <count>");
  process.exit(2);
}

const files = [...new Glob("tests/**/*.test.{ts,tsx}").scanSync({ dot: false })]
  .map((file) => file.replaceAll("\\", "/"))
  .sort();
const shard = files.filter((_, i) => i % count === index - 1).map((file) => `./${file}`);
console.log(`Shard ${index}/${count}: ${shard.length} of ${files.length} test files`);
if (shard.length === 0) process.exit(0);

// Windows starts processes and creates files several times slower than Linux: a workflow scenario
// that takes 1 s on Linux takes 5-25 s on a Windows runner, and a busy runner stretches that past
// 30 s at random (#1177). The tests are the same; only the time they may take differs.
const timeout = process.platform === "win32" ? "90000" : "30000";
const report = join(mkdtempSync(join(tmpdir(), "baked-shard-")), "junit.xml");
const proc = Bun.spawn(
  ["bun", "test", "--timeout", timeout, "--reporter=junit", `--reporter-outfile=${report}`, ...shard],
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
