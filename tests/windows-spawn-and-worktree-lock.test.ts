import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCheckEnv } from "../src/core/verification/check-runner.js";
import {
  isWindowsBatch,
  ProcessScope,
  windowsBatchInvocation,
} from "../src/core/workflows/process-scope.js";
import type { Check } from "../src/core/workflows/types.js";
import { removeDirectory, removeTaskWorktree } from "../src/core/workflows/worktree.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const scratch = (): string => {
  const path = mkdtempSync(join(tmpdir(), "baked-cmd-"));
  temporary.push(path);
  return path;
};
const busy = (): Error => Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });

describe("batch scripts on Windows", () => {
  test("detects .cmd and .bat executables", () => {
    expect(isWindowsBatch("mvn.cmd")).toBe(true);
    expect(isWindowsBatch("C:\tools\gradle.BAT")).toBe(true);
    expect(isWindowsBatch("mvn")).toBe(false);
  });

  test("quotes every word for cmd.exe and keeps metacharacters literal", () => {
    const call = windowsBatchInvocation("mvn.cmd", ["-B", "a b", "x&y|z"], "cmd.exe");
    expect(call.executable).toBe("cmd.exe");
    expect(call.args).toEqual(["/d", "/s", "/c", '""mvn.cmd" "-B" "a b" "x&y|z""']);
  });

  test("refuses characters cmd.exe would expand or end a line on", () => {
    for (const bad of ['a"b', "%PATH%", "a\nb", "a\rb", "dir\\"])
      expect(() => windowsBatchInvocation("mvn.cmd", [bad])).toThrow(/Refusing/);
  });

  test.skipIf(process.platform !== "win32")("runs a .cmd file through ProcessScope", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "echo args.cmd"), "@echo off\r\necho got:%1:%2\r\nexit /b 3\r\n");
    const scope = new ProcessScope();
    try {
      const result = await scope.execute(join(dir, "echo args.cmd"), ["one", "t w&o"], {
        cwd: dir,
        env: process.env,
        timeoutMs: 20000,
        signal: new AbortController().signal,
      });
      expect(result.exitCode).toBe(3);
      expect(result.output).toContain(`got:"one":"t w&o"`);
    } finally {
      await scope.stop();
    }
  });

  test.skipIf(process.platform !== "win32")("does not run an injected command", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "ok.cmd"), "@echo off\r\necho fine\r\n");
    const scope = new ProcessScope();
    try {
      await expect(
        scope.execute(join(dir, "ok.cmd"), ["x%COMSPEC%"], {
          cwd: dir,
          env: process.env,
          timeoutMs: 20000,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/Refusing/);
    } finally {
      await scope.stop();
    }
  });
});

describe("worktree removal under a lock", () => {
  test("retries EBUSY twice and then removes", async () => {
    let calls = 0;
    const error = await removeDirectory("x", {
      delayMs: 1,
      rm: () => {
        if (++calls <= 2) throw busy();
      },
    });
    expect(error).toBeNull();
    expect(calls).toBe(3);
  });

  test("returns the lock error after the attempts and throws on other errors", async () => {
    const locked = await removeDirectory("x", { attempts: 3, delayMs: 1, rm: () => { throw busy(); } });
    expect(locked?.message).toContain("EBUSY");
    await expect(
      removeDirectory("x", {
        delayMs: 1,
        rm: () => {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
      }),
    ).rejects.toThrow("EIO");
  });

  test("a task worktree that stays locked is a warning, not a failure", async () => {
    const workspace = scratch();
    mkdirSync(join(workspace, ".baked", "worktrees", "r", "T001"), { recursive: true });
    const result = await removeTaskWorktree(workspace, ".baked/worktrees/r/T001", {
      attempts: 2,
      delayMs: 1,
      rm: () => {
        throw busy();
      },
    });
    expect(result.removed).toBe(false);
    expect(result.warning).toContain("T001");
  });
});

describe("check environment", () => {
  test("keeps .NET build servers from outliving a check", () => {
    const check = { envNames: [] } as unknown as Check;
    const env = buildCheckEnv(check);
    expect(env.MSBUILDDISABLENODEREUSE).toBe("1");
    expect(env.DOTNET_CLI_USE_MSBUILD_SERVER).toBe("0");
    expect(env.UseSharedCompilation).toBe("false");
  });
});
