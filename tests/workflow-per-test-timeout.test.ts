import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { perTestTimeout, perTestTimeoutNote } from "../src/core/verification/check-runner.js";
import { withPerTestTimeout, writtenTestsCheck } from "../src/core/workflows/affected-tests.js";
import type { Check } from "../src/core/workflows/schemas.js";

// md-site 095b7b11 (bench round 38, #1385): the tests-written check ran
// `bun test ./tests/build.property.test.ts` with a 60 s timeout, and bun stopped the property test
// that built 100 temporary sites at its default 5 s per test. T004 to T006 cost 2.71M tokens.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const check = (executable: string, args: string[], timeoutMs = 120_000): Check =>
  ({ id: "tests", executable, args, cwd: ".", envNames: [], timeoutMs, required: true, scope: "run", writes: [] }) as unknown as Check;

describe("per-test timeout of written-test checks (#1385)", () => {
  test("the tests-written check of a bun project raises bun's per-test limit to half its timeout", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-per-test-"));
    dirs.push(root);
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "tests/build.property.test.ts"), "");
    const written = writtenTestsCheck(root, [check("bun", ["test"])], [{ path: "tests/build.property.test.ts", action: "create" }], "at least 100 generated inputs");
    expect(written).toMatchObject({ id: "tests-written", timeoutMs: 60_000, minCases: 100, args: ["test", "--timeout", "30000", "./tests/build.property.test.ts"] });
  });

  test("jest and vitest get --testTimeout; other runners, a set flag and a short check stay as they are", () => {
    expect(withPerTestTimeout(check("npx", ["vitest", "run", "./a.test.ts"]), 60_000)).toEqual(["vitest", "run", "--testTimeout=30000", "./a.test.ts"]);
    expect(withPerTestTimeout(check("jest", ["--ci", "./a.test.ts"]), 90_000)).toEqual(["--ci", "--testTimeout=45000", "./a.test.ts"]);
    expect(withPerTestTimeout(check("bun", ["test", "--timeout=1000", "./a.test.ts"]), 60_000)).toEqual(["test", "--timeout=1000", "./a.test.ts"]);
    expect(withPerTestTimeout(check("pytest", ["-q", "./tests/test_a.py"]), 60_000)).toEqual(["-q", "./tests/test_a.py"]);
    expect(withPerTestTimeout(check("bun", ["test", "./a.test.ts"]), 8_000)).toEqual(["test", "./a.test.ts"]);
  });

  test("a failure at the runner's per-test limit names that limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-per-test-run-"));
    dirs.push(root);
    writeFileSync(join(root, "slow.test.ts"), 'import { test } from "bun:test";\ntest("slow", async () => { await Bun.sleep(500); }, 50);\n');
    const run = Bun.spawnSync([process.execPath, "test", "./slow.test.ts"], { cwd: root, env: { ...process.env, NO_COLOR: "1" } });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    expect(run.exitCode).not.toBe(0);
    expect(perTestTimeout(output)).toBe(50);
    expect(perTestTimeout("Exceeded timeout of 5000 ms for a test.")).toBe(5000);
    expect(perTestTimeout("Error: Test timed out in 5000ms.")).toBe(5000);
    expect(perTestTimeout("1 fail")).toBeNull();
    expect(perTestTimeoutNote(50)).toContain("per-test limit of 50 ms");
  });
});
