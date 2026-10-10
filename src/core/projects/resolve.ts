import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { configDir } from "../platform/index.js";
import { manifestPath, type ProjectManifest, readManifest } from "./manifest.js";
import { isInside, realPath } from "./paths.js";
import { readRegistry } from "./registry.js";

export interface ResolvedProject {
  id: string;
  name: string;
  manifest: ProjectManifest;
  /** Real path of the checkout holding the manifest. */
  root: string;
  /** Real paths of the trusted roots, the primary root first. */
  roots: string[];
  /** Secondary roots named by the manifest but not registered by the user. */
  ignoredRoots: string[];
  /** Whether the user registered this checkout. */
  registered: boolean;
}

export interface ResolveOptions {
  /** The directory holding the user registry; defaults to the BAKED config directory. */
  configDir?: string;
}

/** The manifest's project with its trusted roots. */
export function projectAt(
  root: string,
  manifest: ProjectManifest,
  opts: ResolveOptions = {},
): ResolvedProject {
  const primary = realPath(root);
  const entry = readRegistry(opts.configDir ?? configDir()).find(
    (e) => e.root === primary && e.id === manifest.id,
  );
  const accepted = new Set(entry?.roots ?? []);
  const roots = [primary];
  const ignoredRoots: string[] = [];
  for (const declared of manifest.roots) {
    const path = realPath(resolve(primary, declared));
    if (roots.includes(path)) continue;
    if (accepted.has(path) && existsSync(path)) roots.push(path);
    else ignoredRoots.push(path);
  }
  return {
    id: manifest.id,
    name: manifest.name,
    manifest,
    root: primary,
    roots,
    ignoredRoots,
    registered: entry !== undefined,
  };
}

/**
 * The project of a directory: its own `.baked/project.json`, else a registered project one of
 * whose trusted roots (the primary root included) contains it (the deepest root wins), else null. Throws ProjectManifestError
 * when the manifest that applies is invalid.
 */
export function resolveProject(cwd: string, opts: ResolveOptions = {}): ResolvedProject | null {
  const own = readManifest(cwd);
  if (own) return projectAt(cwd, own, opts);
  const here = realPath(cwd);
  let best: { project: ResolvedProject; depth: number } | null = null;
  for (const entry of readRegistry(opts.configDir ?? configDir())) {
    if (!existsSync(manifestPath(entry.root))) continue;
    const roots = [entry.root, ...entry.roots].filter((root) => isInside(root, here));
    if (roots.length === 0) continue;
    const manifest = readManifest(entry.root);
    if (!manifest || manifest.id !== entry.id) continue;
    const project = projectAt(entry.root, manifest, opts);
    for (const root of roots) {
      if (!project.roots.includes(root)) continue;
      if (!best || root.length > best.depth) best = { project, depth: root.length };
    }
  }
  return best?.project ?? null;
}

const reported = new Set<string>();

/**
 * resolveProject for callers that must keep working without a project: an invalid manifest is
 * reported once per message through `warn` and treated as no project.
 */
export function activeProject(
  cwd: string,
  opts: ResolveOptions & { warn?: (message: string) => void } = {},
): ResolvedProject | null {
  try {
    return resolveProject(cwd, opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!reported.has(message)) {
      reported.add(message);
      (opts.warn ?? ((m: string) => process.stderr.write(`Warning: ${m}\n`)))(message);
    }
    return null;
  }
}

const idCache = new Map<string, { id: string | null; at: number }>();

/** The active project's ID for a directory, cached briefly because session autosave calls it often. */
export function projectIdOf(cwd: string, opts: ResolveOptions = {}): string | null {
  const key = `${opts.configDir ?? ""}\0${cwd}`;
  const cached = idCache.get(key);
  if (cached && Date.now() - cached.at < 5_000) return cached.id;
  const id = activeProject(cwd, opts)?.id ?? null;
  idCache.set(key, { id, at: Date.now() });
  return id;
}

/** Forgets cached project IDs, after the manifest or the registry changed. */
export function clearProjectCache(): void {
  idCache.clear();
}
