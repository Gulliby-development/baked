import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandaloneLspClient } from "../src/core/intelligence/backends/lsp/standalone-client.js";
import {
  compareWithBaseline,
  type DiagnosticsSource,
  diffDiagnostics,
  formatPostEditResult,
  takeBaseline,
} from "../src/core/intelligence/post-edit.js";
import type { Diagnostic } from "../src/core/intelligence/types.js";
import { diagnosticsTimeoutMs, withEditDiagnosticsMode } from "../src/core/tools/edit-diagnostics.js";
import {
  appendPostEditDiagnostics,
  type DiagnosticsContext,
  originalRegion,
} from "../src/core/tools/post-edit-helpers.js";

const error = (file: string, line: number, message: string): Diagnostic => ({
  file,
  line,
  column: 1,
  severity: "error",
  message,
});

describe("diffDiagnostics", () => {
  it("ignores errors that only moved and counts resolved ones", () => {
    const before = [error("a", 3, "x is unused"), error("a", 9, "type mismatch")];
    const after = [error("a", 5, "x is unused"), error("a", 6, "cannot find y")];
    const { added, resolved } = diffDiagnostics(before, after);
    expect(added.map((d) => d.message)).toEqual(["cannot find y"]);
    expect(resolved).toBe(1);
  });

  it("counts a second occurrence of a known message as new", () => {
    const { added } = diffDiagnostics(
      [error("a", 1, "same")],
      [error("a", 1, "same"), error("a", 4, "same")],
    );
    expect(added).toHaveLength(1);
  });
});

describe("compareWithBaseline", () => {
  it("returns errors an edit causes in an importing file", async () => {
    let edited = false;
    const source: DiagnosticsSource = {
      diagnostics: async (file) =>
        file === "app.ts" && edited ? [error(file, 2, "Expected 2 arguments, but got 1.")] : [],
    };
    const baseline = await takeBaseline(source, "lib.ts", ["app.ts"], 500);
    edited = true;
    const result = await compareWithBaseline(source, baseline, 500);
    expect(result.newErrors).toHaveLength(0);
    expect(result.crossFileErrors.map((e) => `${e.file}:${String(e.line)}`)).toEqual(["app.ts:2"]);
    const text = formatPostEditResult(result) ?? "";
    expect(text).toContain("CROSS-FILE ERRORS");
    expect(text).toContain("app.ts:2: Expected 2 arguments");
  });

  it("reports a check that times out instead of staying silent", async () => {
    const source: DiagnosticsSource = {
      diagnostics: (file) =>
        file === "slow.ts" ? new Promise(() => {}) : Promise.resolve<Diagnostic[]>([]),
    };
    const baseline = await takeBaseline(source, "lib.ts", ["slow.ts"], 50);
    expect(baseline.missedDependents).toBe(1);
    const result = await compareWithBaseline(source, baseline, 50);
    expect(formatPostEditResult(result)).toContain("1 importing file(s) not checked");

    const hung = await takeBaseline({ diagnostics: () => new Promise(() => {}) }, "lib.ts", [], 50);
    const skipped = await compareWithBaseline(source, hung, 50);
    expect(formatPostEditResult(skipped)).toContain("Diagnostics not checked");
  });
});

describe("diagnosticsTimeoutMs", () => {
  it("clamps the configured wait", () => {
    expect(diagnosticsTimeoutMs(undefined)).toBe(2500);
    expect(diagnosticsTimeoutMs(10)).toBe(250);
    expect(diagnosticsTimeoutMs(1e9)).toBe(30_000);
  });
});

describe("originalRegion", () => {
  it("shows the replaced lines with line numbers", () => {
    const before = ["a", "b", "c", "d", "e", "f"].join("\n");
    const after = ["a", "b", "C", "d", "e", "f"].join("\n");
    const region = originalRegion(before, after);
    expect(region).toContain("   3 │ c");
    expect(region).toContain("   1 │ a");
    expect(region).not.toContain("   6 │ f");
  });
});

describe("edit diagnostics through a language server", () => {
  const dir = mkdtempSync(join(tmpdir(), "baked-edit-diags-"));
  const lib = join(dir, "lib.ts");
  const app = join(dir, "app.ts");
  const fixture = join(import.meta.dir, "fixtures", "fake-diagnostics-lsp.ts");
  const client = new StandaloneLspClient(
    { command: process.execPath, args: [fixture], language: "typescript" },
    dir,
  );
  const source: DiagnosticsSource = {
    diagnostics: async (file) =>
      (await client.getDiagnostics(file)).map((d) => ({
        file,
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        severity: d.severity === 1 ? "error" : "warning",
        message: d.message,
        code: d.code,
      })),
  };
  const original = "export function foo() {}\n";
  const broken = "export function bar() {}\n";

  beforeAll(async () => {
    writeFileSync(lib, original);
    writeFileSync(app, 'import { foo } from "./lib";\nuse(foo)\n');
    await client.start();
  });

  afterAll(async () => {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const editLib = async (): Promise<DiagnosticsContext> => {
    writeFileSync(lib, original);
    const baseline = await takeBaseline(source, lib, [app], 2000);
    expect(baseline.dependents.get(app)).toEqual([]);
    writeFileSync(lib, broken);
    return { source, baseline, timeoutMs: 2500 };
  };

  it("returns the error a renamed export causes in its importer", async () => {
    const ctx = await editLib();
    const { output, rejected } = await withEditDiagnosticsMode("feedback", () =>
      appendPostEditDiagnostics(ctx, lib, "Edited lib.ts", { before: original, after: broken }),
    );
    expect(rejected).toBe(false);
    expect(output).toContain("CROSS-FILE ERRORS");
    expect(output).toContain(`${app}:2 [2305]: Module has no exported member 'foo'.`);
    expect(readFileSync(lib, "utf-8")).toBe(broken);
  });

  it("restores the file in reject mode", async () => {
    const ctx = await editLib();
    const { output, rejected } = await withEditDiagnosticsMode("reject", () =>
      appendPostEditDiagnostics(ctx, lib, "Edited lib.ts", { before: original, after: broken }),
    );
    expect(rejected).toBe(true);
    expect(output).toContain("EDIT REJECTED");
    expect(output).toContain("   1 │ export function foo() {}");
    expect(readFileSync(lib, "utf-8")).toBe(original);
  });
});
