import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownLimit } from "../scripts/slow-tests.js";

// Windows merge-queue shards stalled for tens of seconds in file and git work while the tests'
// temp directory was on the runner's C: disk (#1910).
const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "os-tests.yml"), "utf8");

describe("OS tests workflow (#1910)", () => {
  test("Windows shards point TEMP and TMP at a directory in RUNNER_TEMP before the tests run", () => {
    const temp = workflow.indexOf("- name: Keep temp files on the work disk");
    const tests = workflow.indexOf("- name: Test\n");
    expect(temp).toBeGreaterThan(-1);
    expect(temp).toBeLessThan(tests);
    const step = workflow.slice(temp, tests);
    expect(step).toContain("runner.os == 'Windows'");
    expect(step).toContain('$temp = Join-Path $env:RUNNER_TEMP "tmp"');
    expect(step).toContain('"TEMP=$temp" >> $env:GITHUB_ENV');
    expect(step).toContain('"TMP=$temp" >> $env:GITHUB_ENV');
    // The runner user's own ACE: its files there are owned by Administrators, which the OS
    // sandbox makes deny-only, and a sandboxed git could not append to them.
    expect(step).toContain('icacls $temp /grant "${env:USERNAME}:(OI)(CI)F"');
  });
});

// A test that passes the suite's 30 s as its own limit overrides the 90 s Windows shards give every
// test, so one runner stall fails the shard (#1910).
describe("per-test limits (#1910)", () => {
  test("no test passes the suite default of 30 s as its own limit", () => {
    const root = join(import.meta.dir, "..");
    const offenders: string[] = [];
    for (const file of new Bun.Glob("tests/**/*.test.{ts,tsx}").scanSync({ cwd: root })) {
      const source = readFileSync(join(root, file), "utf8");
      source.split("\n").forEach((text, index) => {
        if (/\b(?:test|it)(?:\.\w+)*\s*\(/.test(text) && ownLimit(source, index + 1) === 30_000)
          offenders.push(`${file}:${String(index + 1)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("OS tests workflow on a pull request (#2907)", () => {
  test("every shard runs its share of the picked tests, not only the first", () => {
    const run = workflow.split("\n").find((line) => line.trim().startsWith("RUN:"));
    expect(run).toBeDefined();
    expect(run).not.toContain("matrix.shard ==");
    expect(workflow).toContain("run: bun scripts/test-shard.ts ${{ matrix.shard }} ${{ matrix.shards }}");
  });
});

// A pull request's picked tests often fill one or two shards; the others started a Windows or macOS
// runner only to exit, while macOS arm64 runners were short (#2915).
describe("OS tests workflow: only busy shards take a runner on a pull request (#2915)", () => {
  test("the scope job plans each platform with the matrix's own shard count", () => {
    for (const [table, os] of [
      ["windows", "windows-latest"],
      ["macos", "macos-latest"],
    ] as const) {
      const count = new Set(
        [...workflow.matchAll(new RegExp(`\\{ os: ${os}, shard: \\d+, shards: (\\d+) \\}`, "g"))].map((m) => m[1]),
      );
      expect(count.size).toBe(1);
      expect(workflow).toContain(`bun scripts/test-shard.ts --busy ${table} ${[...count][0]})`);
    }
  });

  test("a shard runs, and asks for its platform's runner, under the same condition", () => {
    const runsOn = workflow.match(/runs-on: \$\{\{ \((.*)\) && matrix\.os \|\| 'ubuntu-latest' \}\}/)?.[1];
    const run = workflow.match(/RUN: \$\{\{ (.*) \}\}/)?.[1];
    expect(runsOn).toBeDefined();
    expect(run).toBe(runsOn);
    expect(run).toContain("format(' {0} ', matrix.shard)");
  });
});
