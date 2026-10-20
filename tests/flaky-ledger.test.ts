import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotations, failedTests, namePattern, verdict } from "../scripts/flaky-ledger.ts";

// #1724: a merge-queue failure is rerun alone and recorded as real or likely flaky.

const report = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" failures="2">
  <testsuite name="x.test.ts" file="tests/x.test.ts">
    <testsuite name="outer group" file="tests/x.test.ts" line="2">
      <testsuite name="inner" file="tests/x.test.ts" line="3">
        <testcase name="flaky one (a &gt; b)" classname="inner &gt; outer group" time="0.001" file="tests/x.test.ts" line="4">
          <failure type="AssertionError" message="Expected: true">AssertionError</failure>
        </testcase>
      </testsuite>
      <testcase name="passes" classname="outer group" time="0.001" file="tests/x.test.ts" line="5" assertions="1">
      </testcase>
      <testcase name="always fails" classname="outer group" time="0.0001" file="tests\\x.test.ts" line="6">
        <failure type="AssertionError" message="Expected: 2">AssertionError</failure>
      </testcase>
    </testsuite>
    <testcase name="top level ok" classname="" time="0.00001" file="tests/x.test.ts" line="8" assertions="0" />
  </testsuite>
</testsuites>`;

describe("flaky test ledger", () => {
  test("reads the failed tests with their describe blocks outermost first", () => {
    expect(failedTests(report)).toEqual([
      { file: "tests/x.test.ts", line: 4, path: ["outer group", "inner", "flaky one (a > b)"] },
      { file: "tests/x.test.ts", line: 6, path: ["outer group", "always fails"] },
    ]);
  });

  test("the name pattern selects exactly that test in bun test -t", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-ledger-"));
    const file = join(dir, "probe.test.ts");
    writeFileSync(
      file,
      [
        'import { describe, expect, test } from "bun:test";',
        'describe("outer group", () => {',
        '  describe("inner", () => { test("flaky one (a > b)", () => {}); });',
        '  test("flaky one (a > b) too", () => { expect(1).toBe(2); });',
        "});",
      ].join("\n"),
    );
    const pattern = namePattern({ file, line: 3, path: ["outer group", "inner", "flaky one (a > b)"] });
    const proc = Bun.spawn(["bun", "test", file, "-t", pattern], { stdout: "pipe", stderr: "pipe", cwd: dir });
    const output = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(output).toContain("1 pass");
    expect(output).toContain("0 fail");
  });

  test("a failure that passes any rerun is likely flaky, one that never passes is real", () => {
    expect(verdict(1, 3)).toBe("likely flaky");
    expect(verdict(0, 3)).toBe("real");
    expect(verdict(0, 0)).toBe("not rerun");
    const [flaky, real] = failedTests(report);
    if (!flaky || !real) throw new Error("fixture has two failures");
    expect(
      annotations([
        { ...flaky, reruns: 3, passes: 2, verdict: "likely flaky" },
        { ...real, reruns: 3, passes: 0, verdict: "real" },
      ]),
    ).toEqual([
      "::warning file=tests/x.test.ts,line=4::outer group > inner > flaky one (a > b) failed, likely flaky: 2/3 isolated reruns passed",
      "::error file=tests/x.test.ts,line=6::outer group > always fails failed, real: 0/3 isolated reruns passed",
    ]);
  });

  test("the CLI writes the ledger; the shard keeps its own exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-ledger-"));
    const xml = join(dir, "junit.xml");
    writeFileSync(xml, '<testsuites><testsuite name="none"></testsuite></testsuites>');
    const out = join(dir, "ledger.json");
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../scripts/flaky-ledger.ts"), xml, "30000", out], { stdout: "pipe" });
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ schemaVersion: 1, tests: [] });
  });
});
