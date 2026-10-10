import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, parse } from "node:path";
import { z } from "zod";
import { configDir } from "../platform/index.js";
import { writeViaTemp } from "../workflows/atomic-write.js";
import { readManifest } from "./manifest.js";
import { realPath } from "./paths.js";

/**
 * The folders BAKED was opened in, so the user can switch between them. A folder is a project
 * whether or not it has `baked/project.json`; the manifest only adds roots, a working set and
 * defaults. This list grants nothing: trusting secondary roots stays with `projects.json`.
 */
const KnownProjectSchema = z
  .object({
    /** Absolute real path of the folder. */
    path: z.string().min(1),
    /** A name the user chose; otherwise the manifest name or the folder name is shown. */
    name: z.string().min(1).max(120).optional(),
    pinned: z.boolean(),
    addedAt: z.number().int().nonnegative(),
    lastOpenedAt: z.number().int().nonnegative(),
  })
  .strict();
type KnownProjectEntry = z.infer<typeof KnownProjectSchema>;

const KnownProjectsSchema = z
  .object({ schemaVersion: z.literal(1), projects: z.array(KnownProjectSchema) })
  .strict();

/** Unpinned folders beyond this many are forgotten, least recently opened first. */
export const KNOWN_PROJECTS_LIMIT = 100;

export interface KnownProject {
  path: string;
  name: string;
  /** The manifest's project ID, or null for a plain folder. */
  projectId: string | null;
  pinned: boolean;
  addedAt: number;
  lastOpenedAt: number;
  /** False when the folder was moved or deleted since it was last opened. */
  exists: boolean;
}

export interface KnownProjectOptions {
  configDir?: string;
  now?: number;
}

export function knownProjectsPath(dir = configDir()): string {
  return join(dir, "known-projects.json");
}

function readEntries(dir: string): KnownProjectEntry[] {
  const path = knownProjectsPath(dir);
  if (!existsSync(path)) return [];
  try {
    return KnownProjectsSchema.parse(JSON.parse(readFileSync(path, "utf8"))).projects;
  } catch {
    // An unreadable list never blocks BAKED; the next open starts a new one.
    return [];
  }
}

function writeEntries(entries: KnownProjectEntry[], dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = knownProjectsPath(dir);
  writeViaTemp(path, `${JSON.stringify({ schemaVersion: 1, projects: entries }, null, 2)}\n`, {
    flag: "w",
    flush: true,
    mode: 0o600,
  });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX modes.
  }
}

function prune(entries: KnownProjectEntry[]): KnownProjectEntry[] {
  const unpinned = entries
    .filter((e) => !e.pinned)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, KNOWN_PROJECTS_LIMIT);
  const keep = new Set(unpinned.map((e) => e.path));
  return entries.filter((e) => e.pinned || keep.has(e.path));
}

/**
 * Folders that are not a project: the home directory, a filesystem root and the BAKED config
 * directory. Opening BAKED there is usually by accident and would clutter the list.
 */
function isUnsuitable(path: string, dir: string): boolean {
  const home = realPath(process.env.HOME ?? homedir());
  return path === home || path === parse(path).root || path === realPath(dir);
}

/** Records that BAKED was opened in `folder`; returns false when the folder is not listed. */
export function recordProjectOpen(folder: string, opts: KnownProjectOptions = {}): boolean {
  const dir = opts.configDir ?? configDir();
  const path = realPath(folder);
  if (isUnsuitable(path, dir)) return false;
  const now = opts.now ?? Date.now();
  const entries = readEntries(dir);
  const existing = entries.find((e) => e.path === path);
  if (existing) existing.lastOpenedAt = now;
  else entries.push({ path, pinned: false, addedAt: now, lastOpenedAt: now });
  writeEntries(prune(entries), dir);
  return true;
}

function displayName(entry: KnownProjectEntry, manifestName: string | undefined): string {
  return entry.name ?? manifestName ?? (basename(entry.path) || entry.path);
}

function describe(entry: KnownProjectEntry): KnownProject {
  const exists = existsSync(entry.path);
  let manifest: ReturnType<typeof readManifest> = null;
  try {
    manifest = exists ? readManifest(entry.path) : null;
  } catch {
    // An invalid manifest still leaves a usable folder.
  }
  return {
    path: entry.path,
    name: displayName(entry, manifest?.name),
    projectId: manifest?.id ?? null,
    pinned: entry.pinned,
    addedAt: entry.addedAt,
    lastOpenedAt: entry.lastOpenedAt,
    exists,
  };
}

/** Known projects, pinned first, then the most recently opened. */
export function listKnownProjects(opts: KnownProjectOptions = {}): KnownProject[] {
  return readEntries(opts.configDir ?? configDir())
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.lastOpenedAt - a.lastOpenedAt ||
        a.path.localeCompare(b.path),
    )
    .map(describe);
}

/** The known project for a folder, or null. */
export function findKnownProject(
  folder: string,
  opts: KnownProjectOptions = {},
): KnownProject | null {
  const path = realPath(folder);
  return listKnownProjects(opts).find((p) => p.path === path) ?? null;
}

function update(
  folder: string,
  opts: KnownProjectOptions,
  change: (entry: KnownProjectEntry) => void,
): KnownProject {
  const dir = opts.configDir ?? configDir();
  const path = realPath(folder);
  const entries = readEntries(dir);
  const entry = entries.find((e) => e.path === path);
  if (!entry) throw new Error(`${path} is not in the project list.`);
  change(entry);
  writeEntries(entries, dir);
  return describe(entry);
}

/**
 * Adds a folder without opening it. Unlike recordProjectOpen it refuses unsuitable or missing
 * folders, because the user named this one on purpose.
 */
export function addKnownProject(folder: string, opts: KnownProjectOptions = {}): KnownProject {
  const dir = opts.configDir ?? configDir();
  const path = realPath(folder);
  if (!existsSync(path)) throw new Error(`${path} does not exist.`);
  if (isUnsuitable(path, dir))
    throw new Error(`${path} is a home, root or config directory, not a project.`);
  const now = opts.now ?? Date.now();
  const entries = readEntries(dir);
  let entry = entries.find((e) => e.path === path);
  if (!entry) {
    entry = { path, pinned: false, addedAt: now, lastOpenedAt: now };
    entries.push(entry);
  }
  writeEntries(prune(entries), dir);
  return describe(entry);
}

export function setProjectPinned(
  folder: string,
  pinned: boolean,
  opts: KnownProjectOptions = {},
): KnownProject {
  return update(folder, opts, (entry) => {
    entry.pinned = pinned;
  });
}

/** Sets the display name; an empty name goes back to the manifest or folder name. */
export function renameKnownProject(
  folder: string,
  name: string,
  opts: KnownProjectOptions = {},
): KnownProject {
  const trimmed = name.trim();
  if (trimmed.length > 120) throw new Error("A project name has at most 120 characters.");
  return update(folder, opts, (entry) => {
    if (trimmed) entry.name = trimmed;
    else delete entry.name;
  });
}

/** Removes a folder from the list; its sessions and runs stay in the folder. */
export function forgetKnownProject(folder: string, opts: KnownProjectOptions = {}): boolean {
  const dir = opts.configDir ?? configDir();
  const path = realPath(folder);
  const entries = readEntries(dir);
  const kept = entries.filter((e) => e.path !== path);
  if (kept.length === entries.length) return false;
  writeEntries(kept, dir);
  return true;
}
