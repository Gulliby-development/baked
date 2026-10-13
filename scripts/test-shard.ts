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

const proc = Bun.spawn(["bun", "test", "--timeout", "30000", ...shard], {
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
