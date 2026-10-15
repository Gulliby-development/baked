// Runs one shard of `bun run test`: `bun scripts/test-shard.ts <index> <count>` (index from 1).
// Files are spread round-robin over the sorted list, so each shard gets a similar mix of slow and
// fast suites; the shards together run exactly the files `bun test` finds.
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
const proc = Bun.spawn(["bun", "test", "--timeout", timeout, ...shard], {
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
