import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspBackend, serverRootFor } from "../src/core/intelligence/backends/lsp/index.js";
import { buildCheckEnv } from "../src/core/verification/check-runner.js";
import { runSandbox } from "../src/core/security/sandbox.js";
import {
  isWindowsBatch,
  ProcessScope,
  windowsBatchInvocation,
  windowsProgram,
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
        sandbox: null,
      });
      expect(result.exitCode).toBe(3);
      expect(result.output).toContain(`got:"one":"t w&o"`);
    } finally {
      await scope.stop();
    }
  });

  test("a bare batch name runs by the absolute path the PATH gives; a path or an executable is kept", () => {
    const found: Record<string, string> = {
      "sbt.bat": "C:\\sbt\\bin\\sbt.bat",
      gradle: "C:\\gradle\\bin\\gradle.bat",
      git: "C:\\Git\\cmd\\git.exe",
    };
    const which = (bin: string) => found[bin] ?? null;
    expect(windowsProgram("sbt.bat", "C:\\sbt\\bin", "C:\\w", which)).toBe("C:\\sbt\\bin\\sbt.bat");
    expect(windowsProgram("gradle", "C:\\gradle\\bin", "C:\\w", which)).toBe("C:\\gradle\\bin\\gradle.bat");
    expect(windowsProgram("git", "", "C:\\w", which)).toBe("git");
    expect(windowsProgram("missing.cmd", "", "C:\\w", which)).toBe("missing.cmd");
    expect(windowsProgram("C:\\x\\sbt.bat", "", "C:\\w", which)).toBe("C:\\x\\sbt.bat");
    expect(windowsProgram(".\\gradlew.bat", "", "C:\\w", which)).toBe(".\\gradlew.bat");
  });

  // R77: sbt.bat sets SBT_BIN_DIR=%~dp0, and cmd.exe gave a script started by its bare quoted name
  // the working directory there, so sbt looked for <worktree>\bin\sbt-launch.jar.
  for (const sandboxed of [false, true])
    test.skipIf(process.platform !== "win32")(
      `a batch script found on the PATH reads its own folder as %~dp0${sandboxed ? " in the sandbox" : ""}`,
      async () => {
        const tools = scratch();
        const work = scratch();
        mkdirSync(join(tools, "bin"));
        writeFileSync(join(tools, "bin", "where-am-i.bat"), "@echo off\r\necho dir:%~dp0\r\n");
        const env = { ...process.env, PATH: `${join(tools, "bin")};${process.env.PATH ?? process.env.Path ?? ""}` };
        delete env.Path;
        const scope = new ProcessScope();
        try {
          const result = await scope.execute("where-am-i.bat", [], {
            cwd: work,
            env,
            timeoutMs: 60000,
            signal: new AbortController().signal,
            sandbox: sandboxed ? runSandbox({ sandbox: "auto", network: "deny" }, work) : null,
          });
          expect(result.output.toLowerCase()).toContain(`dir:${join(tools, "bin")}\\`.toLowerCase());
        } finally {
          await scope.stop();
        }
      },
    );

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
          sandbox: null,
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

  test("a locked task worktree is moved aside so its path is free", async () => {
    const workspace = scratch();
    const path = join(workspace, ".baked", "worktrees", "r", "T001");
    mkdirSync(path, { recursive: true });
    const order: string[] = [];
    const result = await removeTaskWorktree(workspace, ".baked/worktrees/r/T001", {
      attempts: 2,
      delayMs: 1,
      stopHolders: async () => {
        order.push("stop");
      },
      rm: () => {
        order.push("rm");
        throw busy();
      },
    });
    expect(order[0]).toBe("stop");
    expect(result).toEqual({ removed: true, movedAside: true });
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(workspace, ".baked", "trash"))).toHaveLength(1);
    // The next removal purges the trash.
    await removeTaskWorktree(workspace, ".baked/worktrees/r/T002", { stopHolders: async () => {} });
    expect(existsSync(join(workspace, ".baked", "trash")) ? readdirSync(join(workspace, ".baked", "trash")) : []).toHaveLength(0);
  });

  test("removal gives up after its time bound", async () => {
    let calls = 0;
    const locked = await removeDirectory("x", {
      attempts: 50,
      delayMs: 20,
      maxMs: 60,
      rm: () => {
        calls++;
        throw busy();
      },
    });
    expect(locked).not.toBeNull();
    expect(calls).toBeLessThan(10);
  });
});

describe("language server roots", () => {
  test("a root inside a task worktree maps to the workspace", () => {
    expect(serverRootFor("/w/app/.baked/worktrees/r1/T001", "/fb")).toBe("/w/app");
    expect(serverRootFor(String.raw`C:\w\app\.baked\worktrees\r1\T001\pkg`, "/fb")).toBe(
      String.raw`C:\w\app`,
    );
    expect(serverRootFor("/w/app/packages/a", "/fb")).toBe("/w/app/packages/a");
  });

  test("stopServersUnder stops only servers rooted below the path", async () => {
    const backend = new LspBackend();
    const stopped: string[] = [];
    const fake = (root: string) => ({
      workspaceRoot: root,
      stop: async () => {
        stopped.push(root);
      },
    });
    const clients = (backend as unknown as { standaloneClients: Map<string, unknown> }).standaloneClients;
    const inside = join(tmpdir(), "ws", ".baked", "worktrees", "r", "T001");
    clients.set("a", fake(inside));
    clients.set("b", fake(join(tmpdir(), "ws")));
    expect(await backend.stopServersUnder(join(tmpdir(), "ws", ".baked", "worktrees", "r", "T001"))).toBe(1);
    expect(stopped).toEqual([inside]);
    expect(clients.has("b")).toBe(true);
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
