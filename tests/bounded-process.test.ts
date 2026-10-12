import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedShell } from "../src/core/tools/bounded-process.js";

const dir = mkdtempSync(join(tmpdir(), "baked-bounded-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function script(name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return `"${process.execPath}" "${path}"`;
}

describe("runBoundedShell", () => {
  test("returns the output and exit code of a command that finishes", async () => {
    const command = script("ok.js", `console.log("done"); process.exit(3);`);
    const result = await runBoundedShell(command, { cwd: dir, timeoutMs: 20_000 });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("done");
  });

  test("does not wait for a grandchild that holds the output pipe past the deadline", async () => {
    // The child starts a grandchild that inherits the pipes and lives much longer than the
    // deadline: awaiting the pipes after killing only the wrapper blocks for the grandchild's life.
    const grandchild = `setTimeout(() => {}, 30000);`;
    const command = script(
      "tree.js",
      `const { spawn } = require("node:child_process");
       spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "inherit" });
       setTimeout(() => {}, 30000);`,
    );
    const started = Date.now();
    const result = await runBoundedShell(command, { cwd: dir, timeoutMs: 700 });
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(6_000);
  }, 20_000);
});
