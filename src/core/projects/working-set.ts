import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { builtinForbidden, isForbidden } from "../security/forbidden.js";
import { hashBytes } from "../specs/hash.js";
import { displayPath, isInside, realPath } from "./paths.js";
import type { ResolvedProject } from "./resolve.js";

export const DEFAULT_WORKING_SET_MAX_BYTES = 64 * 1024;
export const DEFAULT_WORKING_SET_FILE_MAX_BYTES = 16 * 1024;
/** Files one entry may expand to, so a broad glob cannot walk a whole disk. */
const MAX_FILES_PER_ENTRY = 500;
const MAX_FILES = 2000;
const SKIPPED_DIRS = new Set([".git", "node_modules", ".baked"]);

export interface WorkingSetFile {
  /** Real absolute path. */
  path: string;
  bytes: number;
}
export interface WorkingSetSkip {
  path: string;
  reason: string;
}
export interface WorkingSet {
  files: WorkingSetFile[];
  skipped: WorkingSetSkip[];
}

const GLOB_CHARS = /[*?[{]/;

function trustedRoot(project: ResolvedProject, path: string): string | null {
  return project.roots.find((root) => isInside(root, path)) ?? null;
}

/** Matches of one entry as absolute paths: a file, every file under a directory, or a glob. */
function expand(base: string, entry: string): string[] | null {
  const segments = entry.replaceAll("\\", "/").split("/");
  const firstGlob = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  if (firstGlob === -1) {
    const path = resolve(base, entry);
    if (!existsSync(path)) return null;
    return statSync(path).isDirectory() ? scan(path, "**/*") : [path];
  }
  const dir = resolve(base, segments.slice(0, firstGlob).join("/") || ".");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  return scan(dir, segments.slice(firstGlob).join("/"));
}

function scan(dir: string, pattern: string): string[] {
  const out: string[] = [];
  for (const rel of new Bun.Glob(pattern).scanSync({ cwd: dir, onlyFiles: true, dot: false })) {
    if (rel.split(/[\\/]/).some((segment) => SKIPPED_DIRS.has(segment))) continue;
    out.push(join(dir, rel));
    if (out.length >= MAX_FILES_PER_ENTRY) break;
  }
  return withoutIgnored(dir, out.sort());
}

/** Drops paths Git ignores when `dir` is in a Git checkout; outside one, keeps them all. */
function withoutIgnored(dir: string, paths: string[]): string[] {
  if (paths.length === 0) return paths;
  const result = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
    cwd: dir,
    input: paths.join("\0"),
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  // 0: some paths ignored, 1: none ignored, anything else: not a checkout or git failed.
  if (result.status !== 0) return paths;
  const ignored = new Set(result.stdout.split("\0").filter(Boolean));
  return paths.filter((path) => !ignored.has(path));
}

function isBinary(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).includes(0);
  } finally {
    closeSync(fd);
  }
}

/**
 * The files of a working set. Entries resolve against the primary root; a file is kept only when
 * its real path lies in a trusted root, it matches no forbidden pattern and it is text.
 */
export function resolveWorkingSet(
  project: ResolvedProject,
  entries: string[] = project.manifest.workingSet,
): WorkingSet {
  const files: WorkingSetFile[] = [];
  const skipped: WorkingSetSkip[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const matches = expand(project.root, entry);
    if (!matches) {
      skipped.push({ path: entry, reason: "not found" });
      continue;
    }
    if (matches.length >= MAX_FILES_PER_ENTRY)
      skipped.push({ path: entry, reason: `only the first ${MAX_FILES_PER_ENTRY} files are used` });
    for (const match of matches) {
      if (files.length >= MAX_FILES) {
        skipped.push({ path: entry, reason: `the working set stops at ${MAX_FILES} files` });
        break;
      }
      const path = realPath(match);
      if (seen.has(path)) continue;
      seen.add(path);
      const root = trustedRoot(project, path);
      if (!root) {
        skipped.push({ path, reason: "outside the trusted project roots" });
        continue;
      }
      if (
        relative(root, path)
          .split(/[\\/]/)
          .some((segment) => SKIPPED_DIRS.has(segment))
      ) {
        skipped.push({ path, reason: "excluded directory" });
        continue;
      }
      const pattern = builtinForbidden(path) ?? builtinForbidden(match) ?? isForbidden(path);
      if (pattern) {
        skipped.push({ path, reason: `forbidden (${pattern})` });
        continue;
      }
      try {
        const stat = statSync(path);
        if (!stat.isFile()) continue;
        if (isBinary(path)) {
          skipped.push({ path, reason: "binary" });
          continue;
        }
        files.push({ path, bytes: stat.size });
      } catch {
        skipped.push({ path, reason: "unreadable" });
      }
    }
  }
  return { files, skipped };
}

export interface RenderOptions {
  /** Paths are shown relative to this directory. */
  cwd: string;
  maxBytes?: number;
  fileMaxBytes?: number;
  now?: Date;
}
export interface RenderedWorkingSet {
  text: string;
  hash: string;
  /** Real paths whose contents the text holds. */
  included: string[];
}

function kb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * One context block with the contents of the working set. Files over their share of the budget
 * are listed by name rather than cut, since a partial file misleads more than an absent one.
 */
export function renderWorkingSet(
  projectId: string,
  set: WorkingSet,
  opts: RenderOptions,
): RenderedWorkingSet | null {
  if (set.files.length === 0 && set.skipped.length === 0) return null;
  const maxBytes = opts.maxBytes ?? DEFAULT_WORKING_SET_MAX_BYTES;
  const fileMaxBytes = opts.fileMaxBytes ?? DEFAULT_WORKING_SET_FILE_MAX_BYTES;
  const show = (path: string) => displayPath(opts.cwd, path);
  let used = 0;
  const blocks: string[] = [];
  const listed: string[] = [];
  const included: string[] = [];
  for (const file of set.files) {
    if (file.bytes > fileMaxBytes || used + file.bytes > maxBytes) {
      listed.push(`${show(file.path)} (${kb(file.bytes)})`);
      continue;
    }
    let content: string;
    try {
      content = readFileSync(file.path, "utf8");
    } catch {
      continue;
    }
    used += Buffer.byteLength(content);
    included.push(file.path);
    blocks.push(`<file path="${show(file.path)}">\n${content.replace(/\n?$/, "\n")}</file>`);
  }
  const lines = [
    `<working_set project="${projectId}" captured="${(opts.now ?? new Date()).toISOString()}">`,
    "Files the user marked as the current focus of this project, as of the capture time. Read a file again before editing it; it may have changed since.",
    ...blocks,
  ];
  if (listed.length) lines.push(`Listed without contents (over budget): ${listed.join(", ")}`);
  if (set.skipped.length)
    lines.push(
      `Skipped: ${set.skipped.map((s) => `${isAbsolute(s.path) ? show(s.path) : s.path} (${s.reason})`).join(", ")}`,
    );
  lines.push("</working_set>");
  const text = lines.join("\n");
  return { text, hash: hashBytes(text), included };
}

/** Entries checked for adding to a manifest: kept as typed, refused when they leave every root. */
export function checkEntries(project: ResolvedProject, entries: string[]): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    const segments = entry.replaceAll("\\", "/").split("/");
    const firstGlob = segments.findIndex((segment) => GLOB_CHARS.test(segment));
    const base = resolve(
      project.root,
      firstGlob === -1 ? entry : segments.slice(0, firstGlob).join("/") || ".",
    );
    const inRoot = [project.root, ...project.manifest.roots.map((r) => resolve(project.root, r))]
      .map(realPath)
      .some((root) => isInside(root, realPath(base)));
    if (!inRoot) problems.push(`${entry}: outside the project roots`);
  }
  return problems;
}
