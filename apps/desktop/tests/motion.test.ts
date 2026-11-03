import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { motionMs, reducedMotion, scrollBehavior } from "../src/renderer/lib/motion.ts";

const g = globalThis as { window?: unknown };
const saved = g.window;

function prefer(reduce: boolean): void {
  g.window = { matchMedia: (q: string) => ({ matches: reduce && q === "(prefers-reduced-motion: reduce)" }) };
}

afterEach(() => {
  g.window = saved;
});

describe("reduced motion for scripted animations (#2685)", () => {
  test("transitions and smooth scrolling stop under reduced motion", () => {
    prefer(true);
    expect(reducedMotion()).toBe(true);
    expect(motionMs(250)).toBe(0);
    expect(scrollBehavior()).toBe("auto");
  });

  test("they run otherwise, and without a window", () => {
    prefer(false);
    expect(motionMs(250)).toBe(250);
    expect(scrollBehavior()).toBe("smooth");
    g.window = undefined;
    expect(reducedMotion()).toBe(false);
  });

  test("no renderer file times a d3 transition or a smooth scroll on its own", () => {
    const root = join(import.meta.dir, "../src/renderer");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(root);
    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${file.slice(root.length + 1)}:${String(i + 1)}` }))
        .filter(({ line }) => /\.duration\(\d/.test(line) || /behavior:\s*"smooth"/.test(line))
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });
});
