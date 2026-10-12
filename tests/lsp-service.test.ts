import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import type { MasonPackage } from "../src/core/intelligence/backends/lsp/installer.js";
import {
  installLspServer,
  type LspServiceDeps,
  LspServiceError,
  lspStatus,
  restartLspServer,
  serverCommandName,
  setLspServerDisabled,
} from "../src/core/intelligence/lsp-service.js";
import { languageServerChecks } from "../src/core/workflows/doctor.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function pkg(name: string, bins: string[], purl: string): MasonPackage {
  return {
    name,
    description: "",
    homepage: "",
    licenses: [],
    languages: [],
    categories: ["LSP"],
    source: { id: purl },
    bin: Object.fromEntries(bins.map((b) => [b, b])),
  };
}

/** A machine with gopls on PATH, pyright installable and rust-analyzer missing its toolchain. */
function machine(started = false) {
  const installed = new Map<string, string>([["gopls", "/usr/bin/gopls"]]);
  const restarts: (string | undefined)[] = [];
  const installs: string[] = [];
  const registry = [
    pkg("gopls", ["gopls"], "pkg:golang/golang.org/x/tools/gopls@v0.20.0"),
    pkg("pyright", ["pyright", "pyright-langserver"], "pkg:npm/pyright@1.1.400"),
    pkg("rust-analyzer", ["rust-analyzer"], "pkg:github/rust-lang/rust-analyzer@2026-10-01"),
  ];
  const deps: Partial<LspServiceDeps> = {
    candidates: () => [
      { command: "gopls", args: ["serve"], languages: ["go"] },
      { command: "pyright-langserver", args: ["--stdio"], languages: ["python"] },
      { command: "pylsp", args: [], languages: ["python"] },
      { command: "rust-analyzer", args: [], languages: ["rust"] },
    ],
    resolve: (command) => {
      const path = installed.get(command);
      return path ? { path, source: path.includes("lsp-servers") ? "baked" : "PATH" } : null;
    },
    registry: () => registry,
    downloadRegistry: async () => registry,
    packageStatus: (p) =>
      p.name === "rust-analyzer"
        ? { requiresToolchain: "cargo", toolchainAvailable: false }
        : { requiresToolchain: null, toolchainAvailable: true },
    install: async (p) => {
      installs.push(p.name);
      for (const bin of Object.keys(p.bin ?? {})) installed.set(bin, `/home/u/.baked/lsp-servers/bin/${bin}`);
      return { success: true };
    },
    started: () => started,
    running: async () =>
      installed.has("gopls")
        ? [{ language: "go", command: "/usr/bin/gopls", pid: 42, openFiles: 2, diagnosticCount: 1, ready: true }]
        : [],
    errors: async () => [
      { command: "C:\\tools\\pyright-langserver.cmd", language: "python", message: "spawn failed", at: 1 },
    ],
    restart: async (filter) => {
      restarts.push(filter);
      return filter ? [`${filter}:x`] : ["all:x"];
    },
    refresh: () => {},
  };
  return { deps, installs, restarts, installed };
}

function project(): { workspace: string; global: string } {
  const root = mkdtempSync(join(tmpdir(), "baked-lsp-"));
  cleanups.push(() => removeTempDir(root));
  const workspace = join(root, "app");
  mkdirSync(join(workspace, "cmd"), { recursive: true });
  writeFileSync(join(workspace, "go.mod"), "module app\n");
  writeFileSync(join(workspace, "cmd", "main.go"), "package main\n");
  writeFileSync(join(workspace, "tool.py"), "print(1)\n");
  return { workspace, global: join(root, "config", "config.json") };
}

describe("language server service", () => {
  test("status lists detected languages first with install, run and error state", async () => {
    const { workspace, global } = project();
    const { deps } = machine(true);
    const status = await lspStatus({ workspace, files: { global }, deps });
    expect(status.languages).toEqual(expect.arrayContaining(["go", "python"]));
    expect(status.servers.map((s) => s.id).slice(0, 3)).toEqual(["gopls", "pyright-langserver", "pylsp"]);
    const gopls = status.servers.find((s) => s.id === "gopls");
    expect(gopls).toMatchObject({ installed: true, source: "PATH", running: true, ready: true, pids: [42] });
    const pyright = status.servers.find((s) => s.id === "pyright-langserver");
    expect(pyright).toMatchObject({ installed: false, package: "pyright", installable: true });
    expect(pyright?.lastError?.message).toBe("spawn failed");
    expect(status.servers.find((s) => s.id === "rust-analyzer")).toMatchObject({
      detected: false,
      installable: false,
      requiresToolchain: "cargo",
    });
    expect(status.uncovered).toEqual(["python"]);
  });

  test("disable writes the command, enable removes it and older package names", async () => {
    const { workspace, global } = project();
    const { deps, restarts } = machine(true);
    const files = { global };
    const off = await setLspServerDisabled({ workspace, files, deps }, "gopls", true);
    expect(JSON.parse(readFileSync(global, "utf-8")).disabledLspServers).toEqual(["gopls"]);
    expect(off.status.servers.find((s) => s.id === "gopls")).toMatchObject({ disabled: true, disabledIn: ["global"] });
    expect(off.status.uncovered).toContain("go");
    expect(restarts).toEqual(["go"]);

    // A project list replaces the global one, so disabling goes there once it exists.
    const projectFile = join(workspace, ".baked", "config.json");
    mkdirSync(join(workspace, ".baked"));
    writeFileSync(projectFile, JSON.stringify({ defaultModel: "x", disabledLspServers: ["pyright"] }));
    const inProject = await setLspServerDisabled({ workspace, files, deps }, "pyright-langserver", true);
    expect(JSON.parse(readFileSync(projectFile, "utf-8")).disabledLspServers).toEqual(["pyright"]);
    expect(inProject.status.servers.find((s) => s.id === "pyright-langserver")?.disabledIn).toEqual(["project"]);
    expect(inProject.status.servers.find((s) => s.id === "gopls")?.disabled).toBe(false);

    const on = await setLspServerDisabled({ workspace, files, deps }, "pyright", false);
    expect(JSON.parse(readFileSync(projectFile, "utf-8"))).toEqual({ defaultModel: "x", disabledLspServers: [] });
    expect(on.status.servers.find((s) => s.id === "pyright-langserver")?.disabled).toBe(false);
    await setLspServerDisabled({ workspace, files, deps }, "gopls", false);
    expect(JSON.parse(readFileSync(global, "utf-8")).disabledLspServers).toEqual([]);

    await expect(setLspServerDisabled({ workspace, files, deps }, "nope", true)).rejects.toBeInstanceOf(
      LspServiceError,
    );
  });

  test("install takes a server, a package or a language and refuses a missing toolchain", async () => {
    const { workspace, global } = project();
    const m = machine(false);
    const options = { workspace, files: { global }, deps: m.deps };
    const byLanguage = await installLspServer(options, "python");
    expect([byLanguage.server, byLanguage.package]).toEqual(["pyright-langserver", "pyright"]);
    expect(byLanguage.status.uncovered).toEqual([]);
    // Nothing runs before code intelligence starts, so nothing restarts.
    expect(byLanguage.restarted).toEqual([]);

    const again = await installLspServer(options, "go");
    expect(again.server).toBe("gopls");
    expect(m.installs).toEqual(["pyright"]);

    const code = await installLspServer(options, "rust-analyzer").catch((e: LspServiceError) => e.code);
    expect(code).toBe("NOT_INSTALLABLE");
    const unknown = await installLspServer(options, "cobol").catch((e: LspServiceError) => e.code);
    expect(unknown).toBe("NOT_FOUND");
  });

  test("restart filters by server or language and does nothing before start", async () => {
    const { workspace, global } = project();
    const idle = machine(false);
    expect((await restartLspServer({ workspace, files: { global }, deps: idle.deps })).restarted).toEqual([]);
    const live = machine(true);
    await restartLspServer({ workspace, files: { global }, deps: live.deps }, "pyright");
    await restartLspServer({ workspace, files: { global }, deps: live.deps }, "go");
    await restartLspServer({ workspace, files: { global }, deps: live.deps });
    expect(live.restarts).toEqual(["pyright-langserver", "go", undefined]);
  });

  test("server paths reduce to the command name on every OS", () => {
    expect(serverCommandName("C:\\Users\\u\\AppData\\Local\\baked\\lsp-servers\\bin\\gopls.exe")).toBe("gopls");
    expect(serverCommandName("/home/u/.baked/lsp-servers/node_modules/.bin/pyright-langserver")).toBe(
      "pyright-langserver",
    );
    expect(serverCommandName("biome.cmd")).toBe("biome");
  });

  test("the doctor warns per uncovered language and names the install command", async () => {
    const { workspace, global } = project();
    const status = await lspStatus({ workspace, files: { global }, deps: machine().deps });
    const checks = languageServerChecks(status);
    expect(checks).toEqual([
      expect.objectContaining({ id: "lsp.missing", status: "warn", subject: "python" }),
    ]);
    expect(checks[0]?.fix).toContain("baked lsp install pyright-langserver");
    const covered = languageServerChecks({ ...status, uncovered: [] });
    expect(covered).toEqual([expect.objectContaining({ id: "lsp.servers", status: "ok", detail: "gopls" })]);
  });
});

describe("/v1/lsp", () => {
  test("shows, installs, disables and restarts through the shared service", async () => {
    const fixture = workflowFixture();
    const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
    const m = machine(false);
    const server = await startApiServer({ service: fixture.service, configDir, lspDeps: m.deps, log: () => {} });
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
      await removeTempDir(configDir);
    });
    const call = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${server.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    const health = await call("/v1/health");
    expect(health.body.capabilities).toContain("lsp");
    const listed = await call("/v1/lsp");
    expect(listed.status).toBe(200);
    expect(listed.body.started).toBe(false);

    const installed = await call("/v1/lsp/pyright-langserver/install", "POST", {});
    expect(installed.status).toBe(200);
    expect(installed.body.installed).toEqual({ server: "pyright-langserver", package: "pyright" });
    expect(m.installs).toEqual(["pyright"]);

    const off = await call("/v1/lsp/gopls/disable", "POST", { scope: "global" });
    expect(off.status).toBe(200);
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8")).disabledLspServers).toEqual([
      "gopls",
    ]);
    expect((await call("/v1/lsp/gopls/enable", "POST")).status).toBe(200);

    expect((await call("/v1/lsp/rust-analyzer/install", "POST", {})).status).toBe(409);
    expect((await call("/v1/lsp/nope/restart", "POST", {})).status).toBe(404);
    expect((await call("/v1/lsp/gopls/disable", "POST", { scope: "nowhere" })).status).toBe(400);
    expect((await call("/v1/lsp", "POST", {})).status).toBe(405);
  });
});
