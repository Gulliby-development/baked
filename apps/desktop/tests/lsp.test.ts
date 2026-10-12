import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { lsp } = await import("../src/renderer/client/lsp.ts");
const { parseRoute, projectHref } = await import("../src/renderer/router.ts");
const { backendState, lspSourceLine, lspState, visibleServers } = await import(
  "../src/renderer/screens/setup/lsp-logic.ts"
);
delete scope.window;

describe("language server client", () => {
  test("shows, installs, turns off and restarts servers", async () => {
    const first = await lsp.status("baked");
    expect(first.started).toBe(false);
    expect(first.uncovered).toContain("python");
    expect(first.servers.find((s) => s.id === "biome")?.disabled).toBe(true);

    const started = await lsp.restart("baked");
    expect(started.startedNow).toBe(true);
    expect(started.servers.find((s) => s.id === "typescript-language-server")?.ready).toBe(true);

    const installed = await lsp.install("baked", "pyright-langserver");
    expect(installed.installed?.package).toBe("pyright");
    expect(installed.uncovered).not.toContain("python");
    expect(installed.restarted).toContain("python:pyright-langserver");
    await expect(lsp.install("baked", "csharp-ls")).rejects.toBeInstanceOf(ApiError);

    const off = await lsp.setDisabled("baked", "typescript-language-server", true);
    const ts = off.servers.find((s) => s.id === "typescript-language-server");
    expect([ts?.disabled, ts?.running]).toEqual([true, false]);
    const on = await lsp.setDisabled("baked", "biome", false);
    expect(on.servers.find((s) => s.id === "biome")?.running).toBe(true);

    const retried = await lsp.restart("baked", "gopls");
    expect(retried.servers.find((s) => s.id === "gopls")?.ready).toBe(true);
  });

  test("checks code intelligence on every backend", async () => {
    const check = await lsp.diagnose("baked");
    expect(check.language).toBe("typescript");
    expect(check.failing).toEqual([]);
    expect(check.backends.map((b) => b.backend)).toEqual([
      "lsp:standalone",
      "ts-morph",
      "tree-sitter",
      "regex",
    ]);
    expect((await lsp.status("baked")).started).toBe(true);
  });

  test("has its own project section", () => {
    expect(parseRoute(projectHref("baked", "lsp"))).toEqual({
      name: "project",
      key: "baked",
      section: "lsp",
      id: null,
    });
  });
});

describe("language server rows", () => {
  const base = {
    id: "gopls",
    languages: ["go"],
    detected: true,
    installed: true,
    source: "PATH" as const,
    path: "gopls",
    disabled: false,
    disabledIn: [],
    running: false,
    ready: false,
    pids: [],
    openFiles: 0,
    diagnosticCount: 0,
    lastError: null,
    package: "gopls",
    requiresToolchain: "go",
    installable: true,
  };

  test("one state per server, off before missing before running", () => {
    expect(lspState({ ...base, disabled: true, installed: false })).toBe("disabled");
    expect(lspState({ ...base, installed: false })).toBe("missing");
    expect(lspState({ ...base, running: true })).toBe("starting");
    expect(lspState({ ...base, running: true, ready: true })).toBe("running");
    expect(lspState({ ...base, lastError: { message: "x", at: 1 } })).toBe("failed");
    expect(lspState(base)).toBe("installed");
  });

  test("the second line says how to get a missing server", () => {
    expect(lspSourceLine(base)).toBe("on PATH (gopls)");
    expect(lspSourceLine({ ...base, installed: false })).toBe("Mason package gopls");
    expect(lspSourceLine({ ...base, installed: false, installable: false })).toBe(
      "Mason package gopls needs go on PATH",
    );
  });

  test("lists the project's languages unless asked for all", () => {
    const view = {
      servers: [base, { ...base, id: "zls", languages: ["zig"], detected: false }],
      languages: ["go"],
      uncovered: [],
      started: false,
      registry: true,
      paths: { global: "g", project: "p" },
    };
    expect(visibleServers(view, false).map((s) => s.id)).toEqual(["gopls"]);
    expect(visibleServers(view, true)).toHaveLength(2);
  });

  test("a check backend is failing, working, empty or not for the language", () => {
    const backend = (name: string, supports: boolean, statuses: string[]) => ({
      backend: name,
      tier: 1,
      supports,
      initialized: true,
      probes: statuses.map((status) => ({ operation: "findSymbols", status })),
    });
    const lspDown = backend("lsp:standalone", true, ["empty"]);
    const tsMorph = backend("ts-morph", true, ["pass", "timeout"]);
    const treeSitter = backend("tree-sitter", true, ["pass", "unsupported"]);
    const none = backend("rust-only", false, []);
    const check = {
      language: "typescript",
      probeFile: "a.ts",
      backends: [lspDown, tsMorph, treeSitter, none],
      failing: ["ts-morph"],
    } as Parameters<typeof backendState>[0];
    expect(check.backends.map((b) => backendState(check, b))).toEqual([
      "empty",
      "failing",
      "ok",
      "unsupported",
    ]);
  });
});
