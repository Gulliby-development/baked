import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { LspBackend } from "../src/core/intelligence/backends/lsp/index.js";
import { clearProbeCache } from "../src/core/intelligence/backends/lsp/server-registry.js";
import { IntelligenceClient } from "../src/core/workers/intelligence-client.js";
import { removeTempDir } from "./helpers/temp-dir.js";

// #2268: the router's warmup started rust-analyzer in a workflow fixture's workspace, and the
// workspace's context was disposed while the server was still in its handshake. Only started
// servers were stopped, so the starting one outlived the backend and kept the directory busy on
// Windows (EBUSY after 15 s). The fake server never answers `initialize`, as a server that is
// still loading, and never exits on its own.
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

/** A workspace with a Rust file and a fake `rust-analyzer` first on PATH; returns its pid file. */
function fakeServer(): { root: string; file: string; pidFile: string } {
  const root = mkdtempSync(join(tmpdir(), "baked-lsp-starting-"));
  const bin = mkdtempSync(join(tmpdir(), "baked-lsp-bin-"));
  const pidFile = join(root, "server.pid");
  const script = join(bin, "server.ts");
  writeFileSync(script, `(await import("node:fs")).writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`);
  if (process.platform === "win32")
    writeFileSync(join(bin, "rust-analyzer.cmd"), `@echo off\r\n"${process.execPath}" "${script}"\r\n`);
  else {
    writeFileSync(join(bin, "rust-analyzer"), `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, { mode: 0o755 });
  }
  const file = join(root, "src", "main.rs");
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "x"\nversion = "0.1.0"\n');
  mkdirSync(join(root, "src"));
  writeFileSync(file, "fn main() {}\n");
  const path = process.env.PATH;
  process.env.PATH = bin + delimiter + path;
  clearProbeCache();
  cleanups.push(async () => {
    process.env.PATH = path;
    clearProbeCache();
    await removeTempDir(bin);
    await removeTempDir(root);
  });
  return { root, file, pidFile };
}

async function startedPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 20_000;
  while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8")) {
    if (Date.now() > deadline) throw new Error("the fake server never started");
    await Bun.sleep(25);
  }
  return Number(readFileSync(pidFile, "utf8"));
}

async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(50);
  return !alive(pid);
}

describe("a language server still in its handshake (#2268)", () => {
  test("is stopped when the backend is disposed", async () => {
    const { root, file, pidFile } = fakeServer();
    const backend = new LspBackend();
    await backend.initialize(root);
    const warming = backend.ensureStandaloneReady(file).catch(() => {});
    const pid = await startedPid(pidFile);
    backend.dispose();
    expect(await gone(pid)).toBe(true);
    await warming;
  }, 60_000);

  test("is stopped with the servers under a directory about to be deleted", async () => {
    const { root, file, pidFile } = fakeServer();
    const backend = new LspBackend();
    cleanups.push(() => backend.dispose());
    await backend.initialize(root);
    const warming = backend.ensureStandaloneReady(file).catch(() => {});
    const pid = await startedPid(pidFile);
    expect(await backend.stopServersUnder(root)).toBe(1);
    expect(await gone(pid)).toBe(true);
    await warming;
  }, 60_000);
});

// #2656: every intelligence worker (a workflow fixture's NativeAgentExecutor, a ContextManager)
// warmed up the servers of the workspace's languages that the machine has on PATH. On the
// windows-latest image that started LLVM's clangd for a C++ fixture, a process the test never
// asked for, and the R83 C++ scenario hung to its 90 s limit there only. The suite turns warmup
// off (`BAKED_NO_LSP_WARMUP` in tests/setup/isolate-home.ts); it reaches the worker only because
// the worker is given the environment: under `bun test` its default one missed the preload's and
// the test's changes, so the worker neither saw the switch nor found a fake server on PATH.
describe("a test's intelligence worker (#2656)", () => {
  test("warms up no language server", async () => {
    const { root, pidFile } = fakeServer();
    const client = new IntelligenceClient(root);
    cleanups.push(() => client.close());
    await client.routerWarmup();
    expect(await client.routerGetChildPids()).toEqual([]);
    expect(existsSync(pidFile)).toBe(false);
  });

  test("is given the test's environment: with warmup on, it starts the server on the test's PATH", async () => {
    const { root, pidFile } = fakeServer();
    const saved = process.env.BAKED_NO_LSP_WARMUP;
    delete process.env.BAKED_NO_LSP_WARMUP;
    cleanups.push(() => {
      process.env.BAKED_NO_LSP_WARMUP = saved;
    });
    const client = new IntelligenceClient(root);
    cleanups.push(() => client.close());
    const warming = client.routerWarmup().catch(() => {});
    const pid = await startedPid(pidFile);
    expect(await client.routerStopLspServersUnder(root)).toBe(1);
    expect(await gone(pid)).toBe(true);
    await warming;
  });
});
