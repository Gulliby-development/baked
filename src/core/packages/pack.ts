/**
 * Writing a package's manifest (#135): `packPackage` walks a package folder, checks every path
 * against the package layout, hashes every file, runs the definition checks an install runs
 * (against the package's own content) and writes `baked-package.json`. It refuses, writing
 * nothing, when anything fails, so a manifest it writes describes a package `baked add` accepts.
 * It never touches a project. docs/packages.md#author-a-package describes it.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonical, hashBytes } from "../specs/hash.js";
import { writeViaTemp } from "../workflows/atomic-write.js";
import {
  kindOf,
  MANIFEST_FILE,
  MAX_FILE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_FILES,
  ManifestSchema,
  PACKAGE_KINDS,
  PackageError,
  type PackageFile,
  type PackageKind,
  type PackageManifest,
  PackageName,
  pathProblem,
  walk,
} from "./manifest.js";
import { type InspectOptions, validatePackageContents } from "./packages.js";

export interface PackOptions {
  /** The package name; defaults to the existing manifest's. */
  name?: string;
  /** The package version; defaults to the existing manifest's. */
  version?: string;
  /** The description; defaults to the existing manifest's, and an empty one removes it. */
  description?: string;
  /** Only report what would be written and whether the manifest on disk is up to date. */
  check?: boolean;
  /** The run policy whose checks are gates; defaults to the built-in policy. */
  policy?: InspectOptions["policy"];
}

export interface PackedFile {
  path: string;
  kind: PackageKind;
  sha256: string;
  size: number;
}

export interface PackResult {
  /** The package folder, with symbolic links in its own path resolved. */
  root: string;
  manifestPath: string;
  name: string | null;
  version: string | null;
  description: string | null;
  /** Every file found, sorted by path; files with a layout problem are left out. */
  files: PackedFile[];
  /** IDs by kind: agent profiles, skills, workflow definitions and gates. */
  contents: Record<PackageKind, string[]>;
  /** What blocks the manifest; when there are any, nothing is written. */
  problems: string[];
  /** The manifest that was or would be written; null when refused. */
  manifest: PackageManifest | null;
  /** Whether the folder had a manifest before. */
  existing: boolean;
  /** Whether the manifest on disk already says what this one says (formatting aside). */
  upToDate: boolean;
  /** Whether the manifest file was written. */
  written: boolean;
}

const VERSION = ManifestSchema.shape.version;
const DESCRIPTION = ManifestSchema.shape.description.unwrap();

const invalid = (message: string): never => {
  throw new PackageError("INVALID_ARGUMENT", message);
};

/** The name, version and description of a manifest on disk, when they are valid. */
function readExisting(path: string): {
  text: string | null;
  fields: { name?: string; version?: string; description?: string };
  parsed: PackageManifest | null;
  problem: string | null;
} {
  if (!existsSync(path)) return { text: null, fields: {}, parsed: null, problem: null };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink())
    return { text: null, fields: {}, parsed: null, problem: `${MANIFEST_FILE} is a symbolic link` };
  if (!stat.isFile())
    return { text: null, fields: {}, parsed: null, problem: `${MANIFEST_FILE} is not a file` };
  if (stat.size > MAX_MANIFEST_BYTES)
    return { text: null, fields: {}, parsed: null, problem: null };
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { text, fields: {}, parsed: null, problem: null };
  }
  if (!raw || typeof raw !== "object") return { text, fields: {}, parsed: null, problem: null };
  const record = raw as Record<string, unknown>;
  const fields: { name?: string; version?: string; description?: string } = {};
  if (PackageName.safeParse(record.name).success) fields.name = record.name as string;
  if (VERSION.safeParse(record.version).success) fields.version = record.version as string;
  if (DESCRIPTION.safeParse(record.description).success && record.description !== "")
    fields.description = record.description as string;
  const parsed = ManifestSchema.safeParse(raw);
  return { text, fields, parsed: parsed.success ? parsed.data : null, problem: null };
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A manifest with its files sorted, for comparing two manifests regardless of order and format. */
const normalized = (manifest: PackageManifest): string =>
  canonical({
    ...manifest,
    files: [...manifest.files].sort((a, b) => byPath(a.path, b.path)),
  });

/**
 * Writes `baked-package.json` for the package folder at `input` (or for the folder of the
 * `baked-package.json` given): every file below it except `.git` and the manifest, with its
 * SHA-256, sorted by path. The name, version and description default to the existing manifest's.
 * Throws a PackageError for a missing folder (`NOT_FOUND`) or a missing or invalid name, version
 * or description (`INVALID_ARGUMENT`); returns the problems, writing nothing, when a path breaks
 * the layout, a limit is exceeded, the folder holds a symbolic link or a special file, or a
 * definition would not load.
 */
export function packPackage(input: string, options: PackOptions = {}): PackResult {
  if (!existsSync(input)) throw new PackageError("NOT_FOUND", `${input} does not exist`);
  let root = input;
  if (!statSync(input).isDirectory()) {
    if (basename(input) !== MANIFEST_FILE)
      throw new PackageError(
        "INVALID_PACKAGE",
        `${input}: a package is a folder; give the folder or its ${MANIFEST_FILE}`,
      );
    root = dirname(input);
  }
  root = realpathSync(root);
  const manifestPath = join(root, MANIFEST_FILE);
  const existing = readExisting(manifestPath);

  if (options.name !== undefined && !PackageName.safeParse(options.name).success)
    invalid(
      `Name ${JSON.stringify(options.name)}: lowercase letters, digits, ., _ and -, at most 64`,
    );
  if (options.version !== undefined && !VERSION.safeParse(options.version).success)
    invalid(`Version ${JSON.stringify(options.version)}: a semantic version such as 1.0.0`);
  if (options.description !== undefined && !DESCRIPTION.safeParse(options.description).success)
    invalid("The description is longer than 2000 characters");
  const name = options.name ?? existing.fields.name ?? null;
  const version = options.version ?? existing.fields.version ?? null;
  const description =
    options.description !== undefined
      ? options.description || null
      : (existing.fields.description ?? null);
  if (name === null || version === null)
    invalid(
      `${existing.text === null ? `${root} has no ${MANIFEST_FILE}` : `${MANIFEST_FILE} has no valid ${name === null ? "name" : "version"}`}; give ${[name === null ? "a name" : "", version === null ? "a version" : ""].filter(Boolean).join(" and ")}`,
    );

  const problems: string[] = existing.problem ? [existing.problem] : [];
  let paths: string[] = [];
  try {
    // Sorted by code unit, so the order is the same on every machine and locale.
    paths = walk(root, problems)
      .filter((p) => p !== MANIFEST_FILE)
      .sort(byPath);
  } catch (error) {
    if (!(error instanceof PackageError)) throw error;
    problems.push(error.message);
  }
  if (paths.length === 0 && problems.length === 0)
    problems.push("The package holds no files besides the manifest");
  if (paths.length > MAX_PACKAGE_FILES)
    problems.push(`The package holds ${paths.length} files; at most ${MAX_PACKAGE_FILES}`);

  const seen = new Map<string, string>();
  const files: PackageFile[] = [];
  let total = 0;
  for (const path of paths) {
    const problem = pathProblem(path);
    if (problem) {
      problems.push(problem);
      continue;
    }
    // Windows and macOS folders ignore case, so two paths that differ only in case collide.
    const other = seen.get(path.toLowerCase());
    if (other) {
      problems.push(`${path} and ${other} differ only in case`);
      continue;
    }
    seen.set(path.toLowerCase(), path);
    const full = join(root, ...path.split("/"));
    const size = lstatSync(full).size;
    total += size;
    if (size > MAX_FILE_BYTES) {
      problems.push(`${path} is larger than ${MAX_FILE_BYTES} bytes`);
      continue;
    }
    if (total > MAX_PACKAGE_BYTES) continue;
    const bytes = readFileSync(full);
    files.push({ path, kind: kindOf(path), sha256: hashBytes(bytes), bytes });
  }
  if (total > MAX_PACKAGE_BYTES)
    problems.push(`The package is larger than ${MAX_PACKAGE_BYTES} bytes`);
  const skills = new Set(files.filter((f) => f.kind === "skills").map((f) => f.path.split("/")[1]));
  for (const id of skills)
    if (!paths.includes(`skills/${id}/SKILL.md`)) problems.push(`skills/${id}/ has no SKILL.md`);

  const checked = validatePackageContents(files, null, { policy: options.policy });
  problems.push(...checked.problems);

  const packed = files.map(({ path, kind, sha256, bytes }) => ({
    path,
    kind,
    sha256,
    size: bytes.byteLength,
  }));
  const base = {
    root,
    manifestPath,
    name,
    version,
    description,
    files: packed,
    contents: checked.contents,
    existing: existing.text !== null,
  };
  const candidate = ManifestSchema.safeParse({
    schemaVersion: 1,
    name,
    version,
    ...(description !== null ? { description } : {}),
    files: packed.map(({ path, sha256 }) => ({ path, sha256 })),
  });
  if (!candidate.success && problems.length === 0)
    problems.push(
      ...candidate.error.issues.map((i) => `${MANIFEST_FILE}: ${i.path.join(".")}: ${i.message}`),
    );
  if (problems.length || !candidate.success)
    return { ...base, problems, manifest: null, upToDate: false, written: false };

  const manifest = candidate.data;
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const upToDate = existing.parsed !== null && normalized(existing.parsed) === normalized(manifest);
  // An identical file is left alone, so its modification time says when it last changed.
  const written = !options.check && existing.text !== text;
  if (written) writeViaTemp(manifestPath, text, { flag: "w", flush: true });
  return { ...base, problems, manifest, upToDate, written };
}

/** The outcome of writing or checking a manifest, as text lines for the CLI and the terminal UI. */
export function describePack(result: PackResult, check = false): string[] {
  const label = [result.name, result.version].filter(Boolean).join(" ");
  const lines = [
    `Package ${label} in ${result.root}: ${result.files.length} ${result.files.length === 1 ? "file" : "files"}`,
  ];
  if (result.description) lines.push(`  ${result.description}`);
  const kinds = PACKAGE_KINDS.filter((k) => result.contents[k].length)
    .map((k) => `${k}: ${result.contents[k].join(", ")}`)
    .join("; ");
  if (kinds) lines.push(`Contents: ${kinds}`);
  if (result.problems.length) {
    lines.push(`${MANIFEST_FILE} not written:`, ...result.problems.map((p) => `  ${p}`));
    return lines;
  }
  if (check)
    lines.push(
      result.upToDate
        ? `${MANIFEST_FILE} is up to date.`
        : result.existing
          ? `${MANIFEST_FILE} is out of date; writing it would change it.`
          : `${MANIFEST_FILE} does not exist yet.`,
    );
  else
    lines.push(
      result.written
        ? `Wrote ${result.manifestPath}.`
        : `${MANIFEST_FILE} is up to date; nothing written.`,
    );
  return lines;
}
