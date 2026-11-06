import { describe, expect, test } from "bun:test";
import { reference, targetedTests } from "../scripts/pr-targeted-tests.ts";

const weights = { default: 10, files: { "tests/heavy.test.ts": 700, "tests/b.test.ts": 5 } };
const texts: Record<string, string> = {
  "tests/a.test.ts": 'import { x } from "../src/core/mcp/manager.js";',
  "tests/b.test.ts": 'import { y } from "../src/core/platform/index.js";',
  "tests/c.test.ts": 'import { z } from "../src/core/platform";',
  "tests/heavy.test.ts": 'import { w } from "../src/core/mcp/manager.js";',
  "tests/d.test.ts": 'Bun.spawn([process.execPath, resolve("tests/fixtures", "workflow-worker.ts")]);',
  "tests/e.test.ts": 'import { m } from "../src/core/mcp/manager-extra.js";',
};
const files = Object.keys(texts).sort();
const read = (file: string) => texts[file] ?? "";

describe("tests a pull request runs on Windows and macOS before the queue", () => {
  test("a changed source or fixture file is named by its path without extension, an index by its directory", () => {
    expect(reference("src/core/mcp/manager.ts")).toBe("core/mcp/manager");
    expect(reference("src/core/platform/index.ts")).toBe("core/platform");
    expect(reference("tests/fixtures/workflow-worker.ts")).toBe("workflow-worker.ts");
    expect(reference("docs/guide.md")).toBeNull();
  });

  test("changed tests run, then the tests naming a changed file, lightest first within the budget", () => {
    // heavy.test.ts names the manager too but does not fit the budget; e.test.ts names another file.
    expect(targetedTests(["src/core/mcp/manager.ts", "tests/c.test.ts"], files, read, weights, 600)).toEqual([
      "tests/a.test.ts",
      "tests/c.test.ts",
    ]);
    expect(targetedTests(["src/core/platform/index.ts"], files, read, weights)).toEqual(["tests/b.test.ts", "tests/c.test.ts"]);
  });

  test("a test that runs a changed fixture is picked, and a docs-only change picks nothing", () => {
    expect(targetedTests(["tests/fixtures/workflow-worker.ts"], files, read, weights)).toEqual(["tests/d.test.ts"]);
    expect(targetedTests(["docs/guide.md"], files, read, weights)).toEqual([]);
  });
});

describe("the shards split a pull request's picked tests", () => {
  test("TEST_FILES is planned over the shard count it is given, not run in one shard", () => {
    // In one Windows job, #2907's three changed replay-corpus files (about 25 minutes) and the tests naming its
    // sources passed the job's 30 minutes. A shard of the given count runs its share; one with none exits at once.
    const run = Bun.spawnSync([process.execPath, "scripts/test-shard.ts", "2", "2"], {
      env: { ...process.env, TEST_FILES: "tests/pr-targeted-tests.test.ts" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("Shard 2/2: 0 of 1 test files");
  });
});
