import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SymbolInfo } from "../src/core/intelligence/types.js";
import {
  LARGE_READ_BYTES,
  NAMED_SPANS_BYTES,
  namedSymbolSpans,
  outlineLargeReads,
  PRELOAD_TOTAL_BYTES,
  preloadTaskFiles,
  WRITTEN_READ_BYTES,
} from "../src/core/workflows/read-outline.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-read-outline-"));
  dirs.push(dir);
  const methods = Array.from(
    { length: 120 },
    (_, i) => `  method${i}(value: number): number {\n    const doubled = value * 2;\n    return doubled + ${i};\n  }\n`,
  ).join("\n");
  writeFileSync(
    join(dir, "large.ts"),
    `export interface Row {\n  id: string;\n}\n\nexport class Store {\n${methods}}\n${"// padding\n".repeat(1500)}`,
  );
  writeFileSync(join(dir, "small.ts"), "export const small = 1;\n");
  return dir;
}

test("a whole read of a large file becomes an outline with line spans; other reads stay", async () => {
  const dir = workspace();
  const large = join(dir, "large.ts");
  const ranged = { path: large, ranges: [{ start: 1, end: 3 }] };
  const result = await outlineLargeReads([{ path: large }, join(dir, "small.ts"), ranged]);

  expect(result.files).toEqual([join(dir, "small.ts"), ranged]);
  expect(result.outlines).toHaveLength(1);
  const [outline = ""] = result.outlines;
  expect(outline).toContain("shown as an outline");
  expect(outline).toMatch(/1-3 interface Row/);
  expect(outline).toMatch(/\d+-\d+ class Store/);
  expect(outline).toMatch(/\d+-\d+ method method42/);
  // Locals inside methods are not part of the outline.
  expect(outline).not.toContain("doubled");
  expect(Buffer.byteLength(outline)).toBeLessThan(LARGE_READ_BYTES / 2);
});

test("a large file without an outline is read as asked", async () => {
  const dir = workspace();
  const text = join(dir, "notes.txt");
  writeFileSync(text, "plain text\n".repeat(3000));
  const result = await outlineLargeReads([{ path: text }]);
  expect(result).toEqual({ files: [{ path: text }], outlines: [] });
});

test("a file the task writes is read whole up to the written-file limit, outlined above it", async () => {
  const dir = workspace();
  const large = join(dir, "large.ts");
  const content = readFileSync(large, "utf8");
  const within = join(dir, "within.ts");
  writeFileSync(within, content.slice(0, WRITTEN_READ_BYTES - 100));
  expect(statSync(within).size).toBeGreaterThan(LARGE_READ_BYTES);
  expect(await outlineLargeReads([{ path: within }], [within])).toEqual({
    files: [{ path: within }],
    outlines: [],
  });
  writeFileSync(large, `${content}${"// padding\n".repeat(WRITTEN_READ_BYTES / 10)}`);
  expect((await outlineLargeReads([{ path: large }], [large])).outlines).toHaveLength(1);
});

test("an implementer's preload holds small modified files whole, outlines large ones and skips new files", async () => {
  const dir = workspace();
  const text = await preloadTaskFiles(dir, [
    { path: "small.ts", action: "modify" },
    { path: "large.ts", action: "modify" },
    { path: "new.ts", action: "create" },
    { path: "gone.ts", action: "modify" },
  ]);
  expect(text).toMatch(/^--- small\.ts\n {3}1 {2}export const small = 1;\n {3}2 {2}\nhash:/);
  expect(text).toContain("--- large.ts\nlarge.ts is ");
  expect(text).toMatch(/\d+-\d+ class Store/);
  expect(text).not.toContain("new.ts");
  expect(text).not.toContain("gone.ts");
});

test("whole files in the preload stop at the total; the rest are outlined", async () => {
  const dir = workspace();
  const body = readFileSync(join(dir, "large.ts"), "utf8").slice(0, WRITTEN_READ_BYTES - 100);
  const count = Math.ceil(PRELOAD_TOTAL_BYTES / body.length) + 1;
  const writes = Array.from({ length: count }, (_, i) => {
    writeFileSync(join(dir, `part${i}.ts`), body);
    return { path: `part${i}.ts`, action: "modify" };
  });
  const text = await preloadTaskFiles(dir, writes);
  const whole = text.split("\n\n--- ").filter((part) => part.includes("\nhash:"));
  expect(whole.length).toBe(Math.floor(PRELOAD_TOTAL_BYTES / body.length));
  expect(text).toContain("shown as an outline");
});

test("an outlined file in the preload carries the spans of the symbols the task names", async () => {
  const dir = workspace();
  const text = await preloadTaskFiles(
    dir,
    [{ path: "large.ts", action: "modify" }],
    "Change method42 and method7 of Store so Row ids are trimmed",
  );
  expect(text).toContain("shown as an outline");
  expect(text).toContain("The spans the task names");
  const lines = readFileSync(join(dir, "large.ts"), "utf8").split("\n");
  const at = lines.findIndex((line) => line.includes("method42("));
  expect(text).toContain(`${String(at + 1).padStart(4)}  ${lines[at]}`);
  expect(text).toContain("method7(value");
  expect(text).toMatch(/hash:\w+$/);
  // "Row" is shorter than a picked name, and the Store class is shown by the methods named.
  expect(text).not.toContain("   1  export interface Row");
  expect(text).not.toContain("method8(value");
  expect(Buffer.byteLength(text)).toBeLessThan(NAMED_SPANS_BYTES);
});

test("named spans skip a span past the allowance and words that are not declarations", () => {
  const symbols = [
    { name: "Store", kind: "class", location: { file: "f", line: 1, column: 0, endLine: 9 } },
    { name: "load", kind: "method", location: { file: "f", line: 2, column: 2, endLine: 4 } },
    { name: "save", kind: "method", location: { file: "f", line: 5, column: 2, endLine: 8 } },
  ] as SymbolInfo[];
  const lines = Array.from({ length: 9 }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`);
  expect(namedSymbolSpans(symbols, lines, "Make load and save atomic", 1000)).toEqual([
    { start: 2, end: 4 },
    { start: 5, end: 8 },
  ]);
  // A named class is shown by its named members, and whole when none is named and it fits.
  expect(namedSymbolSpans(symbols, lines, "Store.load", 1000)).toEqual([{ start: 2, end: 4 }]);
  expect(namedSymbolSpans(symbols, lines, "Store", 1000)).toEqual([{ start: 1, end: 9 }]);
  expect(namedSymbolSpans(symbols, lines, "Store", 100)).toEqual([]);
  expect(namedSymbolSpans(symbols, lines, "Update the docs", 1000)).toEqual([]);
});
