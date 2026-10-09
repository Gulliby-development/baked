import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoMap } from "../src/core/intelligence/repo-map.js";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("rescan re-indexes a same-mtime content change (size gate)", async () => {
  dir = join(tmpdir(), `size-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  const file = join(dir, "src", "a.ts");
  writeFileSync(file, "export function before() { return 1; }\n");

  const rm = new RepoMap(dir);
  await rm.scan();
  expect(rm.findSymbols("before").length).toBe(1);

  // Capture mtime, rewrite with DIFFERENT content+size, then restore the exact mtime.
  // Without size gating, the (mtime-only) diff would skip re-indexing this file.
  const { atimeMs, mtimeMs } = statSync(file);
  writeFileSync(file, "export function afterChange() { return 22; }\nexport const x = 1;\n");
  utimesSync(file, atimeMs / 1000, mtimeMs / 1000);

  await rm.scan();
  expect(rm.findSymbols("afterChange").length).toBe(1);
  expect(rm.findSymbols("before").length).toBe(0);
  await rm.close();
});

test("rescan skips an unchanged file (mtime+size both equal)", async () => {
  dir = join(tmpdir(), `size-gate-skip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "b.ts"), "export function keep() { return 1; }\n");

  const rm = new RepoMap(dir);
  await rm.scan();
  const before = rm.getStats().files;
  await rm.scan(); // no changes — gate should skip all files
  expect(rm.getStats().files).toBe(before);
  expect(rm.findSymbols("keep").length).toBe(1);
  await rm.close();
});
