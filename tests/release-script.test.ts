import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A release ran plain `bun test`, whose 5 s default timeout gave 74 false failures on a laptop
// where `bun run test` (30 s) passes, so releases were cut with --skip-checks (bench round 58).
test("scripts run the whole suite through the project's test script", () => {
  const dir = join(import.meta.dir, "..", "scripts");
  const offenders = readdirSync(dir)
    .filter((name) => name.endsWith(".sh"))
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => /^\s*bun test\s*$/.test(line))
        .map((line) => `${name}: ${line.trim()}`),
    );
  expect(offenders).toEqual([]);
});
