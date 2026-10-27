import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planShards, type ShardWeights, testFiles, weightsFor } from "../scripts/test-shard.js";
import { buildWeights, fileSeconds } from "../scripts/test-shard-weights.js";

// Round-robin by name put the replay corpus and the slowest workflow suites in one Windows shard:
// 27 minutes of a 30-minute job while another shard ran 4.
const root = join(import.meta.dir, "..");
const table: Record<string, ShardWeights> = JSON.parse(
  readFileSync(join(root, "scripts", "test-shard-weights.json"), "utf8"),
);
const files = testFiles(root);

describe("duration-balanced OS test shards", () => {
  for (const [platform, os] of [
    ["win32", "windows"],
    ["darwin", "macos"],
  ] as const) {
    const weights = weightsFor(platform, table);
    const weight = (file: string) => weights.files[file] ?? weights.default;

    for (const count of [1, 2, 3, 5]) {
      test(`${os}, ${count} shards: every test file runs in exactly one shard`, () => {
        const shards = planShards(files, count, weights);
        expect(shards).toHaveLength(count);
        expect(shards.flat().sort()).toEqual(files);
        expect(planShards(files, count, weights)).toEqual(shards);
      });
    }

    test(`${os}: the heaviest files go to different shards and no shard exceeds the floor by much`, () => {
      const count = 3;
      const shards = planShards(files, count, weights);
      const heaviest = [...files].sort((a, b) => weight(b) - weight(a)).slice(0, count);
      const homes = heaviest.map((file) => shards.findIndex((shard) => shard.includes(file)));
      expect(new Set(homes).size).toBe(count);
      const seconds = shards.map((shard) => shard.reduce((sum, file) => sum + weight(file), 0));
      const total = seconds.reduce((sum, value) => sum + value, 0);
      // No shard runs longer than the larger of its fair share and the heaviest file, plus one file.
      const floor = Math.max(total / count, weight(heaviest[0]));
      expect(Math.max(...seconds)).toBeLessThanOrEqual(floor + weight(heaviest[1]));
    });
  }

  test("a file missing from the table weighs the default, and the split is stable", () => {
    const weights: ShardWeights = { default: 1, files: { "tests/slow.test.ts": 10 } };
    const names = ["tests/a.test.ts", "tests/b.test.ts", "tests/slow.test.ts", "tests/c.test.ts"];
    expect(planShards(names, 2, weights)).toEqual([
      ["tests/slow.test.ts"],
      ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"],
    ]);
    expect(planShards(names, 5, weights).flat().sort()).toEqual([...names].sort());
  });

  test("Linux takes the macOS table", () => {
    expect(weightsFor("linux", table)).toBe(table.macos);
  });
});

describe("refreshing the weights from shard logs", () => {
  const log = [
    "2026-10-26T12:51:05.0000000Z bun test v1.4.3",
    "2026-10-26T12:51:05.4000000Z ##[group]tests\\fast.test.ts:",
    "2026-10-26T12:51:05.5000000Z (pass) fast [0.10ms]",
    "2026-10-26T12:51:05.9000000Z ##[group]tests\\slow.test.ts:",
    "2026-10-26T12:51:25.9000000Z (pass) slow [20000.00ms]",
    "2026-10-26T12:51:26.9000000Z Ran 2 tests across 2 files. [21.50s]",
  ].join("\r\n");

  test("each file's time runs from its group line to the next file or the end of the run", () => {
    expect(Object.fromEntries(fileSeconds(log))).toEqual({
      "tests/fast.test.ts": 0.5,
      "tests/slow.test.ts": 21,
    });
  });

  test("the table keeps files of 1 s or more at their median and drops deleted files", () => {
    const later = log.replace("12:51:26.9", "12:51:30.9");
    expect(buildWeights([log, later, log], ["tests/fast.test.ts", "tests/slow.test.ts"])).toEqual({
      default: 10.8,
      files: { "tests/slow.test.ts": 21 },
    });
    expect(buildWeights([log], ["tests/slow.test.ts"]).files).toEqual({ "tests/slow.test.ts": 21 });
  });
});
