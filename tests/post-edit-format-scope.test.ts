import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithCwd } from "../src/core/cwd.js";
import { getIntelligenceRouter } from "../src/core/intelligence/index.js";
import { astEditTool } from "../src/core/tools/ast-edit.js";
import { autoFormatAfterEdit, canAutoFormat, resetFormatCache } from "../src/core/tools/auto-format.js";
import { editFileTool } from "../src/core/tools/edit-file.js";
import { clearEditStacks, undoEditTool } from "../src/core/tools/edit-stack.js";
import { multiEditTool } from "../src/core/tools/multi-edit.js";
import { moveSymbolTool } from "../src/core/tools/move-symbol.js";
import { autoFixFiles } from "../src/core/tools/post-edit-fix.js";
import { renameFileTool } from "../src/core/tools/rename-file.js";
import { renameSymbolTool } from "../src/core/tools/rename-symbol.js";
import { installRuffFormatter, pythonFormatProject } from "./helpers/post-edit-formatter.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  clearEditStacks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function pythonFixture() {
  const root = mkdtempSync(join(tmpdir(), "baked-format-scope-"));
  cleanups.push(() => removeTempDir(root));
  const formatter = installRuffFormatter();
  cleanups.push(formatter.dispose);
  pythonFormatProject(root);
  return { root, formatter };
}

describe("post-edit format scope (#1582)", () => {
  for (const kind of ["edit_file", "multi_edit"] as const) {
    test(`${kind} preserves unrelated Python lines and allows a corrective to restore them`, async () => {
      const { root, formatter } = pythonFixture();
      const file = join(root, "args.py");
      const before = "legacy=1\nlabel = 'keep'\nlimit = 3\n";
      writeFileSync(file, before);
      const edit = (oldString: string, newString: string) => runWithCwd(root, () => kind === "edit_file"
        ? editFileTool.execute({ path: file, oldString, newString })
        : multiEditTool.execute({ path: file, edits: [{ oldString, newString }] }));
      expect((await edit("limit = 3", "limit = 4")).success).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(before.replace("limit = 3", "limit = 4"));
      expect((await edit("limit = 4", "limit = 3")).success).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(existsSync(formatter.log)).toBe(false);
    });
  }

  test("clean Python files are formatted, probe failures preserve the edit, and undo stays valid", async () => {
    const { root, formatter } = pythonFixture();
    const file = join(root, "clean.py");
    const before = 'legacy = 1\nlabel = "keep"\n';
    writeFileSync(file, before);
    const edit = () => runWithCwd(root, () => editFileTool.execute({ path: file, oldString: '"keep"', newString: "'keep'" }));
    expect((await edit()).output).toContain("(formatted)");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect((await undoEditTool.execute({ path: file })).success).toBe(true);
    writeFileSync(formatter.fail, "1");
    expect((await edit()).success).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before.replace('"keep"', "'keep'"));
  });

  test("refactor formatting uses each original pre-image and skips an unknown baseline", async () => {
    const { root } = pythonFixture();
    const router = getIntelligenceRouter(root);
    const original = router.executeWithFallback;
    router.executeWithFallback = async () => null;
    cleanups.push(() => { router.executeWithFallback = original; });
    const dirty = join(root, "dirty.py");
    const clean = join(root, "clean.py");
    const unknown = join(root, "unknown.py");
    const fresh = join(root, "new.py");
    for (const file of [dirty, clean, unknown, fresh]) writeFileSync(file, "label = 'keep'\n");
    const before = new Map<string, string | null>([[dirty, "legacy=1\n"], [clean, 'label = "keep"\n'], [fresh, null]]);
    const results = await runWithCwd(root, () => autoFixFiles([dirty, clean, unknown, fresh], "format-test", before));
    expect(readFileSync(dirty, "utf8")).toBe("label = 'keep'\n");
    expect(readFileSync(unknown, "utf8")).toBe("label = 'keep'\n");
    expect(readFileSync(clean, "utf8")).toBe('label = "keep"\n');
    expect(readFileSync(fresh, "utf8")).toBe('label = "keep"\n');
    expect(results.get(clean)).toContain("format");
    expect(results.has(dirty)).toBe(false);
    expect((await undoEditTool.execute({ path: clean, tabId: "format-test" })).success).toBe(true);
  });

  test("rename_file retains the moved file's dirty baseline", async () => {
    const { root, formatter } = pythonFixture();
    const router = getIntelligenceRouter(root);
    const original = router.executeWithFallback;
    router.executeWithFallback = async () => null;
    cleanups.push(() => { router.executeWithFallback = original; });
    const from = join(root, "old.py");
    const to = join(root, "new.py");
    const before = "legacy=1\nlabel = 'keep'\n";
    writeFileSync(from, before);
    expect((await runWithCwd(root, () => renameFileTool.execute({ from, to }))).success).toBe(true);
    expect(readFileSync(to, "utf8")).toBe(before);
    expect(existsSync(formatter.log)).toBe(false);
  });

  test("real Biome probes preserve dirty AST files, format clean edits and format new files", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-biome-scope-"));
    cleanups.push(() => removeTempDir(root));
    resetFormatCache();
    cleanups.push(resetFormatCache);
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "bun.lock"), "");
    writeFileSync(join(root, "biome.json"), "{}");
    symlinkSync(join(import.meta.dir, "../node_modules"), join(root, "node_modules"), "junction");
    const file = join(root, "dirty.ts");
    const before = 'export const legacy={a:1}\nexport function greet() { return "hi"; }\n';
    writeFileSync(file, before);
    const result = await runWithCwd(root, () => astEditTool.execute({ path: file, action: "set_return_type", target: "function", name: "greet", value: "string" }));
    expect(result.success).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before.replace("greet()", "greet(): string"));
    const clean = join(root, "clean.ts");
    const cleanBefore = "export const value = 1;\n";
    writeFileSync(clean, "export const value={a:2}\n");
    expect(await autoFormatAfterEdit(clean, root, cleanBefore)).toBe(true);
    expect(readFileSync(clean, "utf8")).toBe("export const value = { a: 2 };\n");
    expect(await canAutoFormat(clean, undefined, root)).toBe(false);
    const fresh = join(root, "new.ts");
    expect((await runWithCwd(root, () => astEditTool.execute({ path: fresh, action: "create_file", newCode: "export const value={a:2}\n" }))).success).toBe(true);
    expect(readFileSync(fresh, "utf8")).toBe("export const value = { a: 2 };\n");
  }, 90_000);

  test("rename_symbol carries separate baselines for the definition and its references", async () => {
    const { root, formatter } = pythonFixture();
    const dirty = join(root, "definition.py");
    const clean = join(root, "reference.py");
    const dirtyBefore = "legacy=1\nold_name = 'keep'\n";
    const cleanBefore = 'old_name = "keep"\n';
    writeFileSync(dirty, dirtyBefore);
    writeFileSync(clean, cleanBefore);
    const router = getIntelligenceRouter(root);
    const fallback = spyOn(router, "executeWithFallback").mockResolvedValue(null);
    const rename = spyOn(router, "executeWithFallbackTracked").mockResolvedValue({
      backend: "fixture",
      value: { edits: [
        { file: dirty, oldContent: dirtyBefore, newContent: dirtyBefore.replace("old_name", "new_name") },
        { file: clean, oldContent: cleanBefore, newContent: cleanBefore.replace("old_name", "new_name") },
      ] },
    });
    cleanups.push(() => { fallback.mockRestore(); rename.mockRestore(); });
    const result = await runWithCwd(root, () => renameSymbolTool.execute({ file: dirty, symbol: "old_name", newName: "new_name" }));
    expect(result.success).toBe(true);
    expect(readFileSync(dirty, "utf8")).toBe(dirtyBefore.replace("old_name", "new_name"));
    expect(readFileSync(clean, "utf8")).toBe(cleanBefore.replace("old_name", "new_name"));
    expect(readFileSync(formatter.log, "utf8").trim().split("\n")).toEqual([clean]);
  });

  for (const newTarget of [false, true]) {
    test(`move_symbol preserves the source baseline and handles a ${newTarget ? "new" : "dirty existing"} target`, async () => {
      const { root } = pythonFixture();
      const from = join(root, "source.py");
      const to = join(root, "target.py");
      writeFileSync(from, "legacy=1\n\ndef moved():\n    return 'keep'\n");
      if (!newTarget) writeFileSync(to, "legacy=1\n\n");
      const router = getIntelligenceRouter(root);
      const fallback = spyOn(router, "executeWithFallback").mockImplementation(async (_language, operation) =>
        operation === "readSymbol" ? { location: { file: from, line: 3, endLine: 4 } } : null);
      cleanups.push(() => { fallback.mockRestore(); });
      const result = await runWithCwd(root, () => moveSymbolTool.execute({ from, to, symbol: "moved" }));
      expect(result.success).toBe(true);
      expect(readFileSync(from, "utf8")).toContain("legacy=1");
      expect(readFileSync(from, "utf8")).not.toContain("def moved");
      expect(readFileSync(to, "utf8")).toContain(newTarget ? 'return "keep"' : "return 'keep'");
      if (!newTarget) expect(readFileSync(to, "utf8")).toContain("legacy=1");
    });
  }
});
