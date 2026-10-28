import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckRunner } from "../src/core/verification/check-runner.js";
import {
  commandTimeoutsUnder,
  fileArgs,
  recordCommandTimeout,
  resetCommandTimeouts,
} from "../src/core/verification/command-timeouts.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { Check } from "../src/core/workflows/types.js";

// #2358: the baseline measurement, the repro and probe tools and documented examples said only
// that a command ran too long. Each now names the command and the files it ran on, and records
// the timeout through one helper, as the edit tools record a formatter's (#2242).

const roots: string[] = [];
afterEach(() => {
  resetCommandTimeouts();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("command timeouts (#2358)", () => {
  test("the baseline measurement of a check that hangs names its command and file", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-command-timeouts-"));
    roots.push(root);
    writeFileSync(join(root, "hang.ts"), "await new Promise(() => setInterval(() => {}, 1000));\n");
    const check: Check = {
      id: "slow",
      executable: "bun",
      args: ["hang.ts"],
      cwd: ".",
      timeoutMs: 1500,
      required: true,
      scope: "feature",
      envNames: [],
      writes: [],
    };
    const runner = new CheckRunner(undefined as unknown as WorkflowStore, new ProcessScope());
    const result = await runner.measure(check, new AbortController().signal, root, null);
    expect(result.status).toBe("inconclusive");
    expect(result.timeout?.source).toBe("measure");
    expect(result.timeout?.files).toEqual(["hang.ts"]);
    expect(result.output).toContain("Note: slow: `bun hang.ts` on hang.ts did not finish within 1500 ms");
    expect(commandTimeoutsUnder(root).map((t) => t.command)).toEqual(["bun hang.ts"]);
  });

  test("a repeated timeout counts up, and a record is found only under its own root", () => {
    const a = mkdtempSync(join(tmpdir(), "baked-command-timeouts-"));
    const b = mkdtempSync(join(tmpdir(), "baked-command-timeouts-"));
    roots.push(a, b);
    const input = {
      source: "repro" as const,
      command: ["bun", "src/cli.ts", "--level", "9"],
      files: ["src/cli.ts", "src/cli.ts"],
      root: a,
      timeoutMs: 30_000,
    };
    expect(recordCommandTimeout(input).count).toBe(1);
    const again = recordCommandTimeout(input);
    expect(again.count).toBe(2);
    expect(again.files).toEqual(["src/cli.ts"]);
    expect(again.note).toBe(
      "`bun src/cli.ts --level 9` on src/cli.ts did not finish within 30000 ms (timeout 2 for this command)",
    );
    expect(commandTimeoutsUnder(a)).toHaveLength(1);
    expect(commandTimeoutsUnder(b)).toEqual([]);
  });

  test("only arguments that look like files are named", () => {
    expect(fileArgs(["test", "--run", "tests/sum.test.ts", "-x", "pkg\\mod.py", "9"])).toEqual([
      "tests/sum.test.ts",
      "pkg\\mod.py",
    ]);
  });
});
