import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// #1919: the dev preload ran Babel and the React Compiler over all of `src/`, the 10 MB of
// `src/core/` too, so every test fixture child that imported the workflow core spent about 8 s
// (55 s on a loaded macOS runner) compiling code with no component or hook in it.
const root = join(import.meta.dir, "..");
const plugin = readFileSync(join(root, "plugins/react-compiler.ts"), "utf8");
const literal = plugin.match(/const REACT_COMPILER_FILTER = \/(.+)\/;/)?.[1];
const filter = new RegExp(literal ?? "^$");

function files(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1).replaceAll("\\", "/"));
}

describe("React Compiler scope (#1919)", () => {
  test("the preload compiles UI sources and leaves src/core out", () => {
    expect(literal).toBeDefined();
    for (const path of ["src/components/App.tsx", "src/hooks/useReducedMotion.ts", "src/stores/ui.ts"])
      expect(filter.test(`/repo/${path}`)).toBe(true);
    for (const path of ["src/core/workflows/scheduler.ts", "src/core/tools/index.ts", "src/core/src/x.ts"])
      expect(filter.test(`/repo/${path}`)).toBe(false);
  });

  test("src/core holds no component or hook, so leaving it out changes no output", () => {
    const react: string[] = [];
    for (const path of files("src/core")) {
      if (path.endsWith(".tsx")) react.push(path);
      else if (/\.ts$/.test(path) && /from\s+["'](?:react|@opentui\/react)(?:\/[^"']*)?["']/.test(readFileSync(join(root, path), "utf8")))
        react.push(path);
    }
    expect(react).toEqual([]);
  });
});
