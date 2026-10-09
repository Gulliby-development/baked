import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoMap } from "../src/core/intelligence/repo-map.js";

let dir: string;
let repoMap: RepoMap;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "moniker-"));
});

afterEach(async () => {
  await repoMap?.close();
  rmSync(dir, { recursive: true, force: true });
});

function monikerOf(relPath: string, name: string): string | null {
  const ranges = repoMap.getFileSymbolRanges(relPath);
  return ranges.find((r) => r.name === name)?.moniker ?? null;
}

describe("stable symbol monikers", () => {
  test("moniker is assigned and position-independent", async () => {
    writeFileSync(join(dir, "svc.ts"), `export function widgetHandler() {\n  return 1;\n}\n`);
    repoMap = new RepoMap(dir);
    await repoMap.scan();

    const m1 = monikerOf("svc.ts", "widgetHandler");
    expect(m1).not.toBeNull();
    expect(m1).toContain("svc#widgetHandler(");

    const beforeLine = repoMap
      .getFileSymbolRanges("svc.ts")
      .find((r) => r.name === "widgetHandler")?.line;
    expect(beforeLine).toBe(1);
    await repoMap.close();

    // Insert lines above — symbol moves down, identity must NOT change.
    writeFileSync(
      join(dir, "svc.ts"),
      `// a new comment\n// another line\nconst preamble = 42;\nexport function widgetHandler() {\n  return 1;\n}\n`,
    );
    repoMap = new RepoMap(dir);
    await repoMap.scan();

    const m2 = monikerOf("svc.ts", "widgetHandler");
    expect(m2).toBe(m1);

    const afterLine = repoMap
      .getFileSymbolRanges("svc.ts")
      .find((r) => r.name === "widgetHandler")?.line;
    expect(afterLine).toBe(4);
  });

  test("resolveMoniker returns the current location after a line move", async () => {
    writeFileSync(join(dir, "svc.ts"), `export function alpha() {\n  return 1;\n}\n`);
    repoMap = new RepoMap(dir);
    await repoMap.scan();
    const m = monikerOf("svc.ts", "alpha");
    expect(m).not.toBeNull();
    await repoMap.close();

    writeFileSync(join(dir, "svc.ts"), `\n\n\nexport function alpha() {\n  return 1;\n}\n`);
    repoMap = new RepoMap(dir);
    await repoMap.scan();

    const hit = repoMap.resolveMoniker(m as string);
    expect(hit).not.toBeNull();
    expect(hit?.name).toBe("alpha");
    expect(hit?.path).toBe("svc.ts");
    expect(hit?.line).toBe(4);
  });

  test("rename changes the moniker (identity tied to name + kind)", async () => {
    writeFileSync(join(dir, "svc.ts"), `export function oldName() {\n  return 1;\n}\n`);
    repoMap = new RepoMap(dir);
    await repoMap.scan();
    const before = monikerOf("svc.ts", "oldName");
    expect(before).not.toBeNull();
    await repoMap.close();

    writeFileSync(join(dir, "svc.ts"), `export function newName() {\n  return 1;\n}\n`);
    repoMap = new RepoMap(dir);
    await repoMap.scan();
    const after = monikerOf("svc.ts", "newName");
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(repoMap.resolveMoniker(before as string)).toBeNull();
  });

  test("resolveMoniker returns null for unknown monikers", async () => {
    writeFileSync(join(dir, "svc.ts"), `export function alpha() {}\n`);
    repoMap = new RepoMap(dir);
    await repoMap.scan();
    expect(repoMap.resolveMoniker("nonexistent#foo(function)")).toBeNull();
  });
});
