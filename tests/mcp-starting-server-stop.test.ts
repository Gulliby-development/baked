import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPManager } from "../src/core/mcp/manager.js";
import { removeTempDir } from "./helpers/temp-dir.js";

// #2800: the MCP side of a server stopped while still starting (#2268 for language servers): a
// stdio server whose handshake was in flight when the manager was disposed was nobody's to stop.
// `dispose` closed only connected servers, and the attempt then stored its client after disposal
// or, on a handshake timeout, dropped the transport without closing it, so the child outlived the
// manager. The fake server never answers `initialize` and never exits on its own.
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 30_000);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function fakeServer(): { script: string; pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "baked-mcp-starting-"));
  const pidFile = join(dir, "server.pid");
  const script = join(dir, "server.ts");
  writeFileSync(
    script,
    `(await import("node:fs")).writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.stdin.resume();\nprocess.stdin.on("end", () => {});\nsetInterval(() => {}, 1000);\n`,
  );
  cleanups.push(() => removeTempDir(dir));
  return { script, pidFile };
}

async function startedPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 20_000;
  while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8")) {
    if (Date.now() > deadline) throw new Error("the fake server never started");
    await Bun.sleep(25);
  }
  return Number(readFileSync(pidFile, "utf8"));
}

describe("an MCP server still in its handshake", () => {
  test("is stopped when the manager is disposed", async () => {
    const { script, pidFile } = fakeServer();
    const manager = new MCPManager();
    const connecting = manager.connect({
      name: "starting",
      command: process.execPath,
      args: [script],
    });
    const pid = await startedPid(pidFile);
    cleanups.push(() => {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    await manager.dispose();
    expect(alive(pid)).toBe(false);
    await connecting;
    expect(manager.isConnected("starting")).toBe(false);
  }, 60_000);

  test("is stopped when its handshake times out", async () => {
    const { script, pidFile } = fakeServer();
    const manager = new MCPManager();
    cleanups.push(() => manager.dispose());
    const connecting = manager.connect({
      name: "slow",
      command: process.execPath,
      args: [script],
      timeout: 1000,
    });
    const pid = await startedPid(pidFile);
    cleanups.push(() => {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    await connecting;
    expect(manager.isConnected("slow")).toBe(false);
    expect(alive(pid)).toBe(false);
  }, 60_000);
});
