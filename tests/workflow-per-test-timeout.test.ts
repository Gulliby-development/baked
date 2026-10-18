import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { perTestTimeout, perTestTimeoutNote } from "../src/core/verification/check-runner.js";
import { affectedTestCheck, writtenTestsCheck } from "../src/core/workflows/affected-tests.js";
import { withPerTestTimeout } from "../src/core/workflows/test-timeout.js";
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

describe("shared per-test timeout (#1385, #1548)", () => {
  const project = (files: Record<string, string> = {}) => {
    const root = mkdtempSync(join(tmpdir(), "baked-timeout-config-"));
    dirs.push(root);
    for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
    return root;
  };

  test("written-test definitions stay unchanged and receive the default only at execution", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-per-test-"));
    dirs.push(root);
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "tests/build.property.test.ts"), "");
    const written = writtenTestsCheck(root, [check("bun", ["test"])], [{ path: "tests/build.property.test.ts", action: "create" }], "at least 100 generated inputs");
    expect(written).toMatchObject({ id: "tests-written", timeoutMs: 60_000, minCases: 100, args: ["test", "./tests/build.property.test.ts"] });
    expect(withPerTestTimeout(written!, root)).toEqual(["test", "./tests/build.property.test.ts", "--timeout", "30000"]);
  });

  test("all affected runners use 30 s independently of the process deadline", () => {
    const root = project();
    expect(withPerTestTimeout(check("npx", ["vitest", "run", "./a.test.ts"]), root)).toEqual(["vitest", "run", "./a.test.ts", "--testTimeout=30000"]);
    expect(withPerTestTimeout(check("jest", ["--ci", "./a.test.ts"], 90_000), root)).toEqual(["--ci", "./a.test.ts", "--testTimeout=30000"]);
    expect(withPerTestTimeout(check("bun", ["test", "./a.test.ts"], 8_000), root)).toEqual(["test", "./a.test.ts", "--timeout", "30000"]);
    for (const [exe, args] of [["pytest", ["-q"]], ["node", ["--test"]], ["cargo", ["test"]], ["go", ["test"]], ["dotnet", ["test"]], ["mvn", ["test"]]] as const)
      expect(withPerTestTimeout(check(exe, [...args]), root)).toEqual([...args]);
  });

  test("keeps explicit flags, including their values in derived checks", () => {
    const root = project();
    for (const [exe, args] of [["bun", ["test", "--timeout", "7000"]], ["jest", ["--testTimeout=9000"]], ["vitest", ["run", "--test-timeout", "10000"]]] as const) {
      const base = check(exe, [...args]);
      const derived = affectedTestCheck([base], ["a.test.ts"])!;
      expect(withPerTestTimeout(base, root)).toEqual([...args]);
      expect(withPerTestTimeout(derived, root)).toEqual([...args, "./a.test.ts"]);
    }
  });

  test("respects bunfig, jest package configuration and jest/vitest config files", () => {
    for (const [exe, args, files] of [
      ["bun", ["test"], { "bunfig.toml": "[test]\ntimeout = 7500\n" }],
      ["jest", [], { "package.json": '{"jest":{"testTimeout":8000}}' }],
      ["jest", [], { "jest.config.cjs": "module.exports = { testTimeout: 9000 };" }],
      ["vitest", ["run"], { "vitest.config.ts": "export default { test: { testTimeout: 11000 } };" }],
      ["vitest", ["run"], { "vite.config.mts": "export default { test: { 'testTimeout': 12000 } };" }],
      ["jest", ["--config", "custom.json"], { "custom.json": '{"testTimeout":7000}' }],
    ] as [string, string[], Record<string, string>][]) {
      const root = project(files);
      expect(withPerTestTimeout(check(exe, args), root)).toEqual(args);
    }
  });

  test("does not mistake unrelated or commented configuration for a timeout", () => {
    const root = project({ "bunfig.toml": "[install]\ntimeout = 4000", "vitest.config.ts": "// testTimeout: 2000\nexport default { test: { /* testTimeout: 9000 */ // testTimeout: 4000\n name: 'testTimeout: 5000' } };" });
    expect(withPerTestTimeout(check("bun", ["test"]), root)).toContain("30000");
    expect(withPerTestTimeout(check("vitest", ["run"]), root)).toContain("--testTimeout=30000");
  });

  test("forwards through package scripts, aliases, npm's separator and shell launchers", () => {
    const root = project({ "package.json": JSON.stringify({ scripts: { test: "bun test", unit: "vitest run", alias: "npm run unit --", lint: "eslint .", cycle: "bun run cycle", opaque: "bun test && echo done" } }) });
    expect(withPerTestTimeout(check("bun", ["run", "test"]), root)).toEqual(["run", "test", "--timeout", "30000"]);
    expect(withPerTestTimeout(check("npm", ["test", "--", "./a.test.ts"]), root)).toEqual(["test", "--", "./a.test.ts", "--timeout", "30000"]);
    expect(withPerTestTimeout(check("npm", ["run", "alias"]), root)).toEqual(["run", "alias", "--", "--testTimeout=30000"]);
    expect(withPerTestTimeout(check("cmd.exe", ["/d", "/s", "/c", "bun test"]), root)).toEqual(["/d", "/s", "/c", "bun test --timeout 30000"]);
    expect(withPerTestTimeout(check("sh", ["-c", "npx jest"]), root)).toEqual(["-c", "npx jest --testTimeout=30000"]);
    for (const name of ["lint", "cycle", "opaque", "missing"])
      expect(withPerTestTimeout(check("bun", ["run", name]), root)).toEqual(["run", name]);
  });

  test("respects timeout overrides and custom config inside nested scripts", () => {
    for (const script of ["bun test --timeout 7000", "npx jest --testTimeout=9000", "npx vitest run --config=custom.ts"]) {
      const root = project({ "package.json": JSON.stringify({ scripts: { test: "npm run unit --", unit: script } }), "custom.ts": "export default { test: { testTimeout: 17000 } };" });
      expect(withPerTestTimeout(check("npm", ["test", "--", "./a.test.ts"]), root)).toEqual(["test", "--", "./a.test.ts"]);
    }
  });

  test("inserts direct runner flags before -- and is idempotent", () => {
    const root = project();
    const base = check("bun", ["test", "--", "./a.test.ts"]);
    const args = withPerTestTimeout(base, root);
    expect(args).toEqual(["test", "--timeout", "30000", "--", "./a.test.ts"]);
    expect(withPerTestTimeout({ ...base, args }, root)).toEqual(args);
  });

  test("uses the execution directory, rereads edits and respects explicit config selection", () => {
    const root = project();
    const other = project({ "bunfig.toml": "[test]\ntimeout = 12345\n" });
    const base = check("bun", ["test"]);
    expect(withPerTestTimeout(base, root)).toContain("30000");
    expect(withPerTestTimeout(base, other)).toEqual(base.args);
    writeFileSync(join(root, "bunfig.toml"), "[test]\ntimeout = 6000\n");
    expect(withPerTestTimeout(base, root)).toEqual(base.args);
    const configRoot = project({ "package.json": '{"jest":{"testTimeout":1000}}', "custom.json": "{}", "vitest.config.ts": "export default {};", "vite.config.ts": "export default {test: {testTimeout: 1000}};" });
    expect(withPerTestTimeout(check("jest", ["--config", "custom.json"]), configRoot)).toContain("--testTimeout=30000");
    expect(withPerTestTimeout(check("vitest", ["run"]), configRoot)).toContain("--testTimeout=30000");
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
