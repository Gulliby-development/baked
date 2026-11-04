import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

// The renderer runs in a browser (Vite in the mock preview, Electron's sandboxed renderer), where
// a node builtin is an externalized stub: the Code graph screen of the mock preview showed
// "Module node:fs has been externalized" because mock-graph.ts reached `node:fs` through
// src/core/intelligence/code-graph-model.ts (#2683). This walks the relative import graph of every
// renderer module, static and dynamic imports alike (type-only imports are erased), and fails when
// it reaches a node builtin.
const desktop = join(import.meta.dir, "..");
const renderer = join(desktop, "src", "renderer");
const repo = join(desktop, "..", "..");

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });

/** The file a relative specifier names: `./x.js` is `./x.ts` or `./x.tsx` in the source tree. */
function resolveFile(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  const stem = base.replace(/\.[cm]?jsx?$/, "");
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, join(base, "index.ts")];
  return candidates.find((path) => /\.tsx?$/.test(path) && existsSync(path)) ?? null;
}

const scanners = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};
const importsCache = new Map<string, string[]>();

function importsOf(file: string): string[] {
  let found = importsCache.get(file);
  if (!found) {
    const scanner = file.endsWith(".tsx") ? scanners.tsx : scanners.ts;
    found = scanner.scanImports(readFileSync(file, "utf8")).map((entry) => entry.path);
    importsCache.set(file, found);
  }
  return found;
}

/** The import chain from `entry` to the first node builtin it reaches, or null. */
function builtinChain(entry: string): string[] | null {
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]): string[] | null => {
    if (seen.has(file)) return null;
    seen.add(file);
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith("node:") || isBuiltin(specifier)) return [...chain, specifier];
      if (!specifier.startsWith(".")) continue;
      const next = resolveFile(file, specifier);
      if (!next) continue;
      const hit = walk(next, [...chain, relative(repo, next)]);
      if (hit) return hit;
    }
    return null;
  };
  return walk(entry, [relative(repo, entry)]);
}

describe("renderer import graph", () => {
  test("mock-graph.ts reaches no node builtin (#2683)", () => {
    expect(builtinChain(join(renderer, "client", "mock-graph.ts"))).toBeNull();
  });

  test("no renderer module reaches a node builtin", () => {
    const files = sources(renderer);
    expect(files.length).toBeGreaterThan(50);
    const reached = files.map(builtinChain).filter((chain) => chain !== null);
    expect(reached.map((chain) => chain.join(" -> "))).toEqual([]);
  });

  test("the walk finds a builtin behind a relative import", () => {
    expect(builtinChain(join(repo, "src", "core", "intelligence", "test-file-at.ts"))).toEqual([
      "src/core/intelligence/test-file-at.ts",
      "node:fs",
    ]);
  });
});
