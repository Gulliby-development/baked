import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LARGE_READ_BYTES, outlineLargeReads } from "../src/core/workflows/read-outline.js";

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

test("a large file the task writes is read whole up to the written-file limit", async () => {
  const dir = workspace();
  const large = join(dir, "large.ts");
  expect(await outlineLargeReads([{ path: large }], [large])).toEqual({
    files: [{ path: large }],
    outlines: [],
  });
});
