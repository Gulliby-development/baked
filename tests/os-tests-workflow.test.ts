import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Windows merge-queue shards stalled for tens of seconds in file and git work while the tests'
// temp directory was on the runner's C: disk (#1910).
const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "os-tests.yml"), "utf8");

describe("OS tests workflow (#1910)", () => {
  test("Windows shards point TEMP and TMP at RUNNER_TEMP before the tests run", () => {
    const temp = workflow.indexOf("- name: Keep temp files on the work disk");
    const tests = workflow.indexOf("- name: Test\n");
    expect(temp).toBeGreaterThan(-1);
    expect(temp).toBeLessThan(tests);
    const step = workflow.slice(temp, tests);
    expect(step).toContain("runner.os == 'Windows'");
    expect(step).toContain('"TEMP=$env:RUNNER_TEMP" >> $env:GITHUB_ENV');
    expect(step).toContain('"TMP=$env:RUNNER_TEMP" >> $env:GITHUB_ENV');
  });
});
