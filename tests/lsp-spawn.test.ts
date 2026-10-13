import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lspLaunch, probeLspServer } from "../src/core/intelligence/backends/lsp/spawn.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const windows = { windows: true, comspec: "C:\\Windows\\System32\\cmd.exe" };

describe("language server launch", () => {
  test("runs a Windows batch shim through cmd.exe", () => {
    const shim = "C:\\Users\\u\\AppData\\Local\\baked\\lsp-servers\\bin\\jdtls.cmd";
    expect(lspLaunch(shim, ["-data", "C:\\ws"], windows)).toEqual({
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", `""${shim}" "-data" "C:\\ws""`],
      verbatim: true,
    });
  });

  test("resolves a bare name on the PATH and wraps it when it is a batch file", () => {
    const which = (bin: string) => `C:\\npm\\${bin}.CMD`;
    const launch = lspLaunch("typescript-language-server", ["--stdio"], { ...windows, which });
    expect(launch.executable).toBe(windows.comspec);
    expect(launch.args.at(-1)).toBe(`""C:\\npm\\typescript-language-server.CMD" "--stdio""`);
  });

  test("spawns executables and every POSIX command directly", () => {
    const exe = (bin: string) => `C:\\go\\bin\\${bin}.exe`;
    expect(lspLaunch("gopls", ["serve"], { ...windows, which: exe })).toEqual({
      executable: "gopls",
      args: ["serve"],
      verbatim: false,
    });
    expect(lspLaunch("/opt/jdtls/bin/jdtls.cmd", [], { windows: false })).toEqual({
      executable: "/opt/jdtls/bin/jdtls.cmd",
      args: [],
      verbatim: false,
    });
  });

  test("refuses an argument cmd.exe would expand", () => {
    expect(() => lspLaunch("C:\\s\\x.cmd", ["%PATH%"], windows)).toThrow(/percent sign/);
  });
});

describe.skipIf(process.platform === "win32")("language server start check", () => {
  test("reports a spawn error, an early exit, and nothing for a server that keeps running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-lsp-probe-"));
    try {
      const exits = join(dir, "exits.sh");
      writeFileSync(exits, "#!/bin/sh\necho 'java not found' >&2\nexit 3\n", { mode: 0o755 });
      const runs = join(dir, "runs.sh");
      writeFileSync(runs, "#!/bin/sh\ncat >/dev/null\n", { mode: 0o755 });
      expect(await probeLspServer(join(dir, "missing"), [], dir, 2000)).toMatch(/ENOENT/);
      expect(await probeLspServer(exits, [], dir, 2000)).toBe("exited with code 3: java not found");
      expect(await probeLspServer(runs, [], dir, 300)).toBeNull();
    } finally {
      await removeTempDir(dir);
    }
  });
});
