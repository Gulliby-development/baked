import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepoMap } from "../src/core/intelligence/repo-map.js";

const TMP = join(tmpdir(), `repo-map-refs-${Date.now()}`);

function write(relPath: string, content: string): void {
  const abs = join(TMP, relPath);
  const dir = abs.slice(0, abs.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, content);
}

let repoMap: RepoMap;

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true });

  // A module that exports two functions
  write(
    "src/utils.ts",
    `export function formatDate(d: Date): string {
  return d.toISOString();
}

export function parseDate(s: string): Date {
  return new Date(s);
}
`,
  );

  // A file that imports and uses formatDate inside a function
  write(
    "src/app.ts",
    `import { formatDate } from "./utils.js";

export function renderTimestamp(d: Date): string {
  const label = "Time: ";
  return label + formatDate(d);
}

export function unusedFunction(): void {
  console.log("hello");
}
`,
  );

  // A file that does NOT import utils but happens to have "formatDate" as a local variable
  write(
    "src/unrelated.ts",
    `export function processData(): void {
  const formatDate = (x: number) => x.toString();
  console.log(formatDate(42));
}
`,
  );

  // A file that uses parseDate without importing it (unique export → should resolve)
  write(
    "src/consumer.ts",
    `export function handleInput(s: string): void {
  const d = parseDate(s);
  console.log(d);
}
`,
  );

  // A JSON file — should NOT produce identifier refs
  write(
    "package.json",
    JSON.stringify({
      name: "test-project",
      version: "1.0.0",
      scripts: { build: "tsc" },
    }),
  );

  // A YAML file — should NOT produce identifier refs
  write(
    "config.yaml",
    `name: test-project
version: 1.0.0
formatDate: true
`,
  );

  repoMap = new RepoMap(TMP);
  await repoMap.scan();
}, 30_000);

afterAll(async () => {
  await repoMap?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("non-code file ref filtering", () => {
  it("should not create identifier refs from JSON files", () => {
    // JSON files are tracked in files table but should have no identifier refs
    const stats = repoMap.getStats();
    expect(stats.files).toBeGreaterThanOrEqual(4);

    // Verify the JSON file exists but has no refs that pollute the graph
    const symbols = repoMap.findSymbols("name");
    // "name" from package.json should NOT resolve to any symbol edge
    const callers = repoMap.getCallers("name");
    // No function should be recorded as calling "name" from a JSON file
    for (const c of callers) {
      expect(c.callerPath).not.toMatch(/\.json$/);
    }
  });
});

describe("identifier ref resolution", () => {
  it("should resolve formatDate ref in app.ts to utils.ts (has import edge)", () => {
    // app.ts imports from utils.ts AND uses formatDate → should be resolved
    const callers = repoMap.getCallers("formatDate", "src/utils.ts");
    const appCaller = callers.find((c) => c.callerPath === "src/app.ts");
    expect(appCaller).toBeDefined();
    expect(appCaller!.callerName).toBe("renderTimestamp");
  });

  it("should NOT link unrelated.ts formatDate to utils.ts (local symbol shadow)", () => {
    // unrelated.ts has a local formatDate — local shadow prevents false resolution
    const callers = repoMap.getCallers("formatDate", "src/utils.ts");
    const unrelatedCaller = callers.find((c) => c.callerPath === "src/unrelated.ts");
    expect(unrelatedCaller).toBeUndefined();
  });

  it("should resolve unique export ref without import edge", () => {
    // consumer.ts uses parseDate (unique export from utils.ts) without importing it
    // The identifier ref should still be resolved via unique-export matching
    const db = (repoMap as any).db;
    const row = db
      .query(
        `SELECT r.source_file_id FROM refs r
         JOIN files f ON f.id = r.file_id
         WHERE f.path = 'src/consumer.ts' AND r.name = 'parseDate'`,
      )
      .get();
    expect(row).toBeDefined();
    expect(row.source_file_id).not.toBeNull();
  });
});

describe("call graph", () => {
  it("should record renderTimestamp → formatDate call", () => {
    // Find the renderTimestamp symbol
    const symbols = repoMap.findSymbols("renderTimestamp");
    expect(symbols.length).toBeGreaterThan(0);
    const sym = symbols.find((s) => s.path.endsWith(join("src", "app.ts")));
    expect(sym).toBeDefined();

    // Check that formatDate appears as a callee
    // (We need the symbol ID — use findSymbol which returns DB rows)
    const callers = repoMap.getCallers("formatDate", "src/utils.ts");
    expect(callers.some((c) => c.callerName === "renderTimestamp")).toBe(true);
  });

  it("should NOT record unusedFunction as calling formatDate", () => {
    // unusedFunction doesn't use formatDate even though it's in the same file
    const callers = repoMap.getCallers("formatDate", "src/utils.ts");
    expect(callers.some((c) => c.callerName === "unusedFunction")).toBe(false);
  });

  it("should include calls count in stats", () => {
    const stats = repoMap.getStats();
    expect(stats.calls).toBeGreaterThan(0);
    expect(typeof stats.calls).toBe("number");
  });

  it("getEnclosingSymbols returns ranged symbols for a file", () => {
    const syms = repoMap.getEnclosingSymbols("src/app.ts");
    expect(syms.length).toBeGreaterThan(0);
    const names = syms.map((s) => s.name);
    expect(names).toContain("renderTimestamp");
    for (const s of syms) {
      expect(s.endLine).toBeGreaterThanOrEqual(s.line);
    }
  });
});
