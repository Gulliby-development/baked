import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lockKeyPath, lockOverrides, parseBunLock } from "../scripts/npm-smoke-overrides.js";

describe("npm smoke overrides: the packed tgz installs what bun.lock holds", () => {
  test("a lock key is a path of package names, scopes kept whole", () => {
    expect(lockKeyPath("@ai-sdk/provider-utils/undici")).toEqual(["@ai-sdk/provider-utils", "undici"]);
    expect(lockKeyPath("a/@scope/b/c")).toEqual(["a", "@scope/b", "c"]);
  });

  test("hoisted entries pin everywhere, nested ones under their path; aliases and non-registry entries are left out", () => {
    const lock = parseBunLock(`{
      "packages": {
        "a": ["a@1.0.0", "", {}, "sha"],
        "b": ["b@2.0.0", "", {}, "sha"],
        "a/b": ["b@1.5.0", "", {}, "sha"],
        "c": ["c@3.0.0", "", {}, "sha"],
        "c/d/b": ["b@1.0.0", "", {}, "sha"],
        "engine": ["web-tree-sitter@0.27.1", "", {}, "sha"],
        "local": ["local@workspace:packages/local", "", {}],
      },
    }`);
    expect(lockOverrides(lock)).toEqual({
      a: { ".": "1.0.0", b: "1.5.0" },
      b: "2.0.0",
      c: { ".": "3.0.0", d: { b: "1.0.0" } },
    });
  });

  test("the repository's lock pins every direct dependency to its locked version", () => {
    const lock = parseBunLock(readFileSync("bun.lock", "utf8"));
    const overrides = lockOverrides(lock);
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    for (const name of Object.keys(manifest.dependencies)) {
      const entry = lock.packages[name]?.[0] as string;
      if (!entry.startsWith(`${name}@`)) continue; // an alias such as web-tree-sitter-engine
      const pin = overrides[name];
      expect(typeof pin === "object" ? pin["."] : pin).toBe(entry.slice(name.length + 1));
    }
  });
});
