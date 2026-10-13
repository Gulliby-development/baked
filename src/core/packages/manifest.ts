/**
 * BAKED packages (#135): a local folder with a `baked-package.json` manifest that lists every file
 * with its SHA-256. Reading a package checks the manifest, the paths, the hashes and that the
 * folder holds nothing else; it never runs or loads anything from the package. Installing copies
 * the files into the project's own `baked/` folders (see packages.ts), after which they are
 * ordinary project content. docs/packages.md describes the format.
 */
import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { hashBytes } from "../specs/hash.js";

export const MANIFEST_FILE = "baked-package.json";
/** Package folders and the project folders they install into (`baked/<kind>/`). */
export const PACKAGE_KINDS = ["agents", "skills", "workflows", "gates"] as const;
export type PackageKind = (typeof PACKAGE_KINDS)[number];
export const MAX_PACKAGE_FILES = 500;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

export type PackageErrorCode =
  | "NOT_FOUND"
  | "INVALID_MANIFEST"
  | "INVALID_PATH"
  | "SYMLINK"
  | "UNLISTED_FILE"
  | "MISSING_FILE"
  | "HASH_MISMATCH"
  | "TOO_LARGE"
  | "INVALID_PACKAGE"
  | "NOT_INSTALLED"
  | "NOT_APPROVED"
  | "STALE_PLAN"
  | "CONFLICT"
  | "INVALID_LOCK";

export class PackageError extends Error {
  constructor(
    readonly code: PackageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PackageError";
  }
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const PackageName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "lowercase letters, digits, ., _ and -, at most 64");
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "a lowercase hex SHA-256");

export const ManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: PackageName,
  version: z.string().regex(SEMVER, "a semantic version such as 1.0.0"),
  description: z.string().max(2000).optional(),
  files: z
    .array(z.strictObject({ path: z.string().min(1).max(512), sha256: Sha256 }))
    .min(1)
    .max(MAX_PACKAGE_FILES),
});
export type PackageManifest = z.infer<typeof ManifestSchema>;

export interface PackageFile {
  /** The path in the package, `/`-separated, starting with its kind. */
  path: string;
  kind: PackageKind;
  sha256: string;
  bytes: Uint8Array;
}
export interface LoadedPackage {
  /** The package folder, with symbolic links in its own path resolved. */
  root: string;
  manifest: PackageManifest;
  files: PackageFile[];
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * Why a manifest path cannot be installed, or null. Paths are relative and `/`-separated, start
 * with a package kind and use portable names: `agents/NAME.json`, `workflows/ID.json`,
 * `skills/ID/FILE...` and `gates/ID.json` or `gates/FOLDER/FILE...` for gate scripts.
 */
export function pathProblem(path: string): string | null {
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path))
    return `${path}: an absolute path; paths are relative to the package folder`;
  if (path.includes("\\")) return `${path}: use / between folders`;
  const parts = path.split("/");
  if (parts.includes("..") || parts.includes("."))
    return `${path}: leaves the package folder or names it twice`;
  if (parts.some((p) => !SEGMENT.test(p) || WINDOWS_RESERVED.test(p) || p.endsWith(".")))
    return `${path}: names use letters, digits, ., _ and -, and do not start with a dot`;
  const [kind, name = "", ...rest] = parts;
  if (!(PACKAGE_KINDS as readonly string[]).includes(kind ?? ""))
    return `${path}: not under agents/, skills/, workflows/ or gates/`;
  const jsonId = (file: string): boolean => file.endsWith(".json") && ID.test(file.slice(0, -5));
  switch (kind as PackageKind) {
    case "agents":
      return rest.length === 0 && jsonId(name)
        ? null
        : `${path}: an agent profile is agents/NAME.json`;
    case "workflows":
      return rest.length === 0 && jsonId(name)
        ? null
        : `${path}: a workflow definition is workflows/ID.json`;
    case "skills":
      return rest.length > 0 && ID.test(name) ? null : `${path}: a skill file is skills/ID/FILE`;
    case "gates":
      if (rest.length > 0) return null;
      return jsonId(name)
        ? null
        : `${path}: a gate is gates/ID.json; put its scripts in a folder under gates/`;
  }
}

function fail(code: PackageErrorCode, message: string): never {
  throw new PackageError(code, message);
}

/** Every file below `root` as a `/`-separated path; a symbolic link or special file is refused. */
function walk(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      fail("INVALID_PACKAGE", `Cannot read ${dir}: ${(error as Error).message}`);
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      // Version control data of a package kept in its own repository is not package content.
      if (!prefix && entry.name === ".git") continue;
      if (entry.isSymbolicLink())
        fail("SYMLINK", `${rel} is a symbolic link; a package holds only regular files`);
      if (entry.isDirectory()) visit(join(dir, entry.name), rel);
      else if (entry.isFile()) found.push(rel);
      else fail("INVALID_PACKAGE", `${rel} is not a regular file`);
      if (found.length > MAX_PACKAGE_FILES * 2)
        fail("TOO_LARGE", `The package folder holds more than ${MAX_PACKAGE_FILES} files`);
    }
  };
  visit(root, "");
  return found;
}

/** The kind of a path that passed `pathProblem`. */
export const kindOf = (path: string): PackageKind => path.split("/")[0] as PackageKind;

/**
 * Reads a package folder (or its `baked-package.json`) and checks it: the manifest's schema, every
 * path, that each listed file exists with its hash, and that the folder holds no unlisted file and
 * no symbolic link. Throws a PackageError naming the first problem.
 */
export function readPackage(input: string): LoadedPackage {
  if (!existsSync(input)) fail("NOT_FOUND", `${input} does not exist`);
  let root = input;
  if (!statSync(input).isDirectory()) {
    if (basename(input) !== MANIFEST_FILE)
      fail("INVALID_PACKAGE", `${input}: a package is a folder with a ${MANIFEST_FILE}`);
    root = dirname(input);
  }
  root = realpathSync(root);
  const manifestPath = join(root, MANIFEST_FILE);
  if (!existsSync(manifestPath)) fail("NOT_FOUND", `${root} has no ${MANIFEST_FILE}`);
  const manifestStat = lstatSync(manifestPath);
  if (manifestStat.isSymbolicLink()) fail("SYMLINK", `${MANIFEST_FILE} is a symbolic link`);
  if (manifestStat.size > MAX_MANIFEST_BYTES)
    fail("TOO_LARGE", `${MANIFEST_FILE} is larger than ${MAX_MANIFEST_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail("INVALID_MANIFEST", `${MANIFEST_FILE} is not JSON: ${(error as Error).message}`);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success)
    fail(
      "INVALID_MANIFEST",
      `${MANIFEST_FILE}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
        .join("; ")}`,
    );
  const manifest = parsed.data;
  const seen = new Set<string>();
  for (const file of manifest.files) {
    const problem = pathProblem(file.path);
    if (problem) fail("INVALID_PATH", problem);
    // Windows and macOS folders ignore case, so two paths that differ only in case collide.
    const key = file.path.toLowerCase();
    if (seen.has(key)) fail("INVALID_MANIFEST", `${file.path} is listed twice`);
    seen.add(key);
  }
  const listed = new Set(manifest.files.map((f) => f.path));
  const present = walk(root).filter((p) => p !== MANIFEST_FILE);
  const unlisted = present.filter((p) => !listed.has(p));
  if (unlisted.length)
    fail(
      "UNLISTED_FILE",
      `Files not listed in ${MANIFEST_FILE}: ${unlisted.slice(0, 10).join(", ")}${unlisted.length > 10 ? ` and ${unlisted.length - 10} more` : ""}`,
    );
  const presentSet = new Set(present);
  let total = 0;
  const files: PackageFile[] = [];
  for (const entry of manifest.files) {
    if (!presentSet.has(entry.path)) fail("MISSING_FILE", `${entry.path} is listed but missing`);
    const full = join(root, ...entry.path.split("/"));
    const size = lstatSync(full).size;
    if (size > MAX_FILE_BYTES)
      fail("TOO_LARGE", `${entry.path} is larger than ${MAX_FILE_BYTES} bytes`);
    total += size;
    if (total > MAX_PACKAGE_BYTES)
      fail("TOO_LARGE", `The package is larger than ${MAX_PACKAGE_BYTES} bytes`);
    const bytes = readFileSync(full);
    const actual = hashBytes(bytes);
    if (actual !== entry.sha256)
      fail(
        "HASH_MISMATCH",
        `${entry.path}: SHA-256 is ${actual}, the manifest says ${entry.sha256}`,
      );
    files.push({ path: entry.path, kind: kindOf(entry.path), sha256: actual, bytes });
  }
  const skills = new Set(files.filter((f) => f.kind === "skills").map((f) => f.path.split("/")[1]));
  for (const id of skills)
    if (!listed.has(`skills/${id}/SKILL.md`))
      fail("INVALID_PACKAGE", `skills/${id}/ has no SKILL.md`);
  return { root, manifest, files };
}
