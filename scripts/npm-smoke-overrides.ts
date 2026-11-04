#!/usr/bin/env bun
// Prints npm `overrides` that pin every package to the version in bun.lock, for the npm-package
// smoke install (.github/workflows/builds.yml). That job npm-installs the packed tgz against the
// manifest's ranges; without pins npm resolves the newest release in each range, so a release the
// registry lists but cannot serve yet (a tarball 404) turned every PR red. With the pins the smoke
// installs what `bun install --frozen-lockfile` installs and what the tests ran against.
//
// #2721. `bun scripts/npm-smoke-overrides.ts [bun.lock]` writes `{"overrides": {...}}` to stdout.
import { readFileSync } from "node:fs";

type Override = string | { [name: string]: Override };
type Tree = { [name: string]: Override };

/** `@scope/a/b/@scope/c` → ["@scope/a", "b", "@scope/c"]: a bun.lock key's path of package names. */
export function lockKeyPath(key: string): string[] {
  const parts = key.split("/");
  const path: string[] = [];
  for (let i = 0; i < parts.length; i++) path.push(parts[i]!.startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i]!);
  return path;
}

/** `@scope/name@1.2.3` → ["@scope/name", "1.2.3"]. */
function nameAndVersion(spec: string): [string, string] | null {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null;
  return [spec.slice(0, at), spec.slice(at + 1)];
}

/** bun.lock is JSON with trailing commas. */
export function parseBunLock(text: string): { packages: Record<string, unknown[]> } {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * npm overrides for every registry package in the lock. A hoisted entry pins the name everywhere;
 * an entry nested under its dependents (`a/b`, a second version of `b` that `a` needs) pins it
 * under that path only, as npm's nested override syntax does (`{"a": {".": "1.0.0", "b": "2.0.0"}}`).
 * Aliases (`name: npm:other@x`), workspace, git and file entries are left to the manifest.
 */
export function lockOverrides(lock: { packages: Record<string, unknown[]> }): Tree {
  const root: Tree = {};
  const hoisted = new Map<string, string>();
  const entries = Object.entries(lock.packages).sort(([a], [b]) => lockKeyPath(a).length - lockKeyPath(b).length);
  for (const [key, entry] of entries) {
    const spec = entry[0];
    if (typeof spec !== "string") continue;
    const parsed = nameAndVersion(spec);
    if (!parsed) continue;
    const [name, version] = parsed;
    if (!/^\d+\.\d+\.\d+/.test(version)) continue;
    const path = lockKeyPath(key);
    if (path[path.length - 1] !== name) continue;
    if (path.length === 1) hoisted.set(name, version);
    let node = root;
    for (const parent of path.slice(0, -1)) {
      const current = node[parent];
      // A parent with no entry of its own at this depth is the hoisted one: keep its pin.
      const pin = typeof current === "string" ? current : hoisted.get(parent);
      const next: Tree = typeof current === "object" ? current : pin ? { ".": pin } : {};
      node[parent] = next;
      node = next;
    }
    const existing = node[name];
    if (typeof existing === "object") existing["."] = version;
    else node[name] = version;
  }
  return root;
}

if (import.meta.main) {
  const lock = parseBunLock(readFileSync(process.argv[2] ?? "bun.lock", "utf8"));
  process.stdout.write(`${JSON.stringify({ overrides: lockOverrides(lock) }, null, 2)}\n`);
}
