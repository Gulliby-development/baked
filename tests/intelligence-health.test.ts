import { describe, expect, test } from "bun:test";
import { healthCheckLines, healthCheckView } from "../src/core/intelligence/health.js";

describe("code intelligence health check view", () => {
  const view = healthCheckView({
    language: "go",
    probeFile: "/p/main.go",
    backends: [
      { backend: "lsp:standalone", tier: 1, supports: true, initialized: false, initError: "gopls exited", probes: [] },
      { backend: "ts-morph", tier: 2, supports: false, initialized: false, probes: [] },
      {
        backend: "tree-sitter",
        tier: 3,
        supports: true,
        initialized: true,
        initMs: 40,
        probes: [
          { operation: "findSymbols", status: "pass", ms: 4 },
          { operation: "getDiagnostics", status: "unsupported" },
        ],
      },
      {
        backend: "regex",
        tier: 4,
        supports: true,
        initialized: true,
        probes: [{ operation: "findSymbols", status: "timeout", ms: 5000 }],
      },
    ],
  });

  test("names the backends that failed to start or whose probes failed", () => {
    expect(view.failing).toEqual(["lsp:standalone", "regex"]);
  });

  test("prints one block per backend with each probe", () => {
    const text = healthCheckLines(view).join("\n");
    expect(text).toContain("Language: go");
    expect(text).toContain("lsp:standalone (tier 1): failed to start: gopls exited");
    expect(text).toContain("ts-morph (tier 2): does not support this language");
    expect(text).toContain("tree-sitter (tier 3): ok (started in 40ms)");
    expect(text).toContain("  findSymbols  ok 4ms");
    expect(text).toContain("  getDiagnostics  -");
    expect(text).toContain("regex (tier 4): failing");
  });
});
