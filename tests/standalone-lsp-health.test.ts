import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeIntelligenceRouter } from "../src/core/intelligence/router.js";

test("health checks execute the standalone probe without an editor process", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "baked-lsp-health-"));
  writeFileSync(join(cwd, "index.ts"), "export const bread = 1;");
  const router = new CodeIntelligenceRouter(cwd, { language: "typescript" });
  let probes = 0;
  router.registerBackend({
    name: "lsp", tier: 1, supportsLanguage: () => true,
    async findSymbols() { return [{ name: "bread", kind: "variable" as const, location: { file: "index.ts", line: 1, column: 1 } }]; },
    async probeStandalone() { probes++; return [{ name: "bread" }]; },
  } as Parameters<typeof router.registerBackend>[0] & { probeStandalone: () => Promise<unknown> });
  try {
    const result = await router.runHealthCheck();
    expect(result.backends.map((backend) => backend.backend)).toEqual(["lsp:standalone"]);
    expect(result.backends[0]?.probes.find((probe) => probe.operation === "findSymbols")?.status).toBe("pass");
    expect(probes).toBeGreaterThan(0);
  } finally { router.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});

test("standalone initialization failures update the visible health result", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "baked-lsp-failure-"));
  const router = new CodeIntelligenceRouter(cwd, { language: "typescript" });
  router.registerBackend({ name: "lsp", tier: 1, supportsLanguage: () => true,
    async initialize() { throw new Error("server launch failed"); },
    async probeStandalone() { return null; },
  } as Parameters<typeof router.registerBackend>[0] & { probeStandalone: () => Promise<unknown> });
  try {
    const result = await router.runHealthCheck();
    expect(result.backends[0]?.initError).toBe("server launch failed");
  } finally { router.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});
