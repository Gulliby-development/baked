import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CMD_PATH_LIMIT, longPathWarning, ProcessScope } from "../src/core/workflows/process-scope.js";

// R109 callfence (Ruby, Windows 11), #3039: the drive script sourced its environment twice and
// PATH reached ~8,500 characters. `bundle` reached cmd.exe by its bare name, cmd.exe reads no PATH
// over 8191 characters, and every check printed "'bundle' is not recognized as an internal or
// external command" (1.97M tokens, blocked at the checks stage).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("scenario: a bare batch-shim check program with a PATH over 8191 characters (#3039)", () => {
  test.skipIf(process.platform !== "win32")("the shim runs by its absolute path and prints its output", async () => {
    const bin = mkdtempSync(join(tmpdir(), "baked-shim-"));
    const work = mkdtempSync(join(tmpdir(), "baked-shim-work-"));
    cleanups.push(() => rmSync(bin, { recursive: true, force: true }), () => rmSync(work, { recursive: true, force: true }));
    writeFileSync(join(bin, "bundlefake.bat"), "@echo off\r\necho Bundler version 2.6.9 %*\r\n");
    // Padding directories that exist, so the PATH is long but valid, with the shim's folder first.
    const pad = join(bin, "p".repeat(200));
    mkdirSync(pad);
    const PATH = [bin, ...Array.from({ length: 50 }, () => pad), process.env.PATH ?? process.env.Path ?? ""].join(";");
    expect(PATH.length).toBeGreaterThan(CMD_PATH_LIMIT);
    const scope = new ProcessScope();
    cleanups.push(() => scope.stop());
    const env = { ...process.env, PATH };
    delete env.Path;
    const result = await scope.execute("bundlefake", ["--version"], { cwd: work, env, timeoutMs: 60000, signal: new AbortController().signal, sandbox: null });
    // On main: exit 1, "'bundlefake' is not recognized as an internal or external command".
    expect(result.output).toContain("Bundler version 2.6.9 --version");
    expect(result.exitCode).toBe(0);
  });
});

describe("longPathWarning (#3039)", () => {
  test("warns on Windows over 8191 characters, names the length, and is silent elsewhere", () => {
    const long = { PATH: "x".repeat(CMD_PATH_LIMIT + 309) };
    expect(longPathWarning(long, "win32")).toContain("PATH is 8500 characters, over the 8191 cmd.exe reads");
    expect(longPathWarning({ Path: "x".repeat(9000) }, "win32")).toContain("9000");
    expect(longPathWarning({ PATH: "x".repeat(CMD_PATH_LIMIT) }, "win32")).toBeNull();
    expect(longPathWarning(long, "linux")).toBeNull();
  });
});
