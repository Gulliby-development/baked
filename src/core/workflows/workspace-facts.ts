import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isManifestFile, isSourceFile } from "../intelligence/language-traits.js";
import { isTestCodePath } from "./quality/duplication.js";

/**
 * Workspace Facts: what the host knows about the files a run starts from. Stages used to get a
 * single `greenfield` label, which hid scaffold files (package.json, tsconfig, a README) from the
 * researcher and the planner, so research stated "no project files" and plans created files that
 * existed. The inventory is built by the host before research and handed to every stage that
 * reads the workspace; it outranks what a model wrote about the same files.
 */
/** A source file of any language the language table knows: code, markup, styles or queries. */
export const isSourcePath = (path: string): boolean => isSourceFile(path);
const SKIPPED = new Set([
  ".git",
  "node_modules",
  ".baked",
  "baked",
  ".venv",
  "dist",
  "target",
  "build",
  "obj",
  ".gradle",
  ".idea",
  "__pycache__",
  // dbt's installed packages (#1499).
  "dbt_packages",
  // R's project libraries: renv's and packrat's installed packages (#1500).
  "renv",
  "packrat",
]);
const SCAN_LIMIT = 2000;
const LISTED_LIMIT = 80;

export type WorkspaceKind =
  /** No file at all (besides skipped folders). */
  | "empty"
  /** Files exist but none is source code: manifests, configs, a README. */
  | "scaffold"
  /** At least one source file. */
  | "source";

export interface WorkspaceFacts {
  schemaVersion: 1;
  kind: WorkspaceKind;
  /** Files, shallowest first, with sizes in bytes; capped. */
  files: { path: string; bytes: number }[];
  totalFiles: number;
  sourceFiles: number;
  /** Build and tool manifests among the files. */
  manifests: string[];
  /** Scripts of the root package.json, name to command. */
  scripts: Record<string, string>;
  /** One sentence stages can quote. */
  summary: string;
}

export function workspaceFacts(root: string): WorkspaceFacts {
  const files: { path: string; bytes: number }[] = [];
  let seen = 0;
  let total = 0;
  let sources = 0;
  // Breadth first with no depth limit: Maven, Gradle and .NET keep their sources four or more
  // levels down (src/main/java/<package>/...), and a depth cap reported them as scaffold. The
  // entry limit bounds the scan instead, and shallow files are listed first.
  const queue: { dir: string; prefix: string }[] = [{ dir: root, prefix: "" }];
  scan: for (let next = queue.shift(); next; next = queue.shift()) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(next.dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > SCAN_LIMIT) break scan;
      const rel = next.prefix ? `${next.prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) queue.push({ dir: join(next.dir, entry.name), prefix: rel });
        continue;
      }
      total += 1;
      if (isSourceFile(entry.name)) sources += 1;
      if (files.length < LISTED_LIMIT) {
        let bytes = 0;
        try {
          bytes = statSync(join(next.dir, entry.name)).size;
        } catch {
          // A file that vanished while scanning is listed with size 0.
        }
        files.push({ path: rel, bytes });
      }
    }
  }
  const manifests = files.filter((f) => isManifestFile(f.path)).map((f) => f.path);
  let scripts: Record<string, string> = {};
  if (files.some((f) => f.path === "package.json")) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      const raw = (parsed as { scripts?: unknown }).scripts;
      if (raw && typeof raw === "object")
        scripts = Object.fromEntries(
          Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"),
        );
    } catch {
      // An unreadable manifest is still listed as a file.
    }
  }
  const kind: WorkspaceKind = sources > 0 ? "source" : total > 0 ? "scaffold" : "empty";
  const names = files
    .slice(0, 12)
    .map((f) => f.path)
    .join(", ");
  const summary =
    kind === "empty"
      ? "The workspace holds no files; everything the request describes is to be created."
      : kind === "scaffold"
        ? `The workspace holds ${String(total)} scaffold file(s) and no source code: ${names}. These files exist: modify them, never create them again; the program the request describes is still to be built.`
        : `The workspace holds ${String(total)} file(s), ${String(sources)} of them source code: ${names}.`;
  return {
    schemaVersion: 1,
    kind,
    files,
    totalFiles: total,
    sourceFiles: sources,
    manifests,
    scripts,
    summary,
  };
}

/** The workspace has no source code (empty or scaffold only): the program is yet to be built. */
export function hasNoSource(facts: Pick<WorkspaceFacts, "kind">): boolean {
  return facts.kind !== "source";
}

const ABSENCE =
  /\b(does not|doesn't|do not|don't|did not) exist|\bnonexistent\b|\bno such file\b|\b(is|are) (absent|missing|not present)\b/i;

/**
 * An analysis finding that says a listed file does not exist contradicts the host inventory; the
 * inventory wins, so the finding is a note rather than a reason to revise the spec.
 */
export function contradictsFacts(description: string, facts: WorkspaceFacts): boolean {
  if (!ABSENCE.test(description)) return false;
  return facts.files.some((f) => description.includes(f.path));
}

const INVENTORY_LIMIT = 500;

/** The files of the reviewed workspace, as the reviewers get them (#1506). */
export interface WorkspaceInventory {
  /** Every file: tracked and untracked ones, without ignored ones and files deleted on disk. */
  totalFiles: number;
  /** Of those, test files (test directories and the test file names of the supported languages). */
  testFiles: number;
  /** The paths, sorted, up to 500. */
  paths: string[];
  truncated: boolean;
  note: string;
}

function gitFiles(root: string): string[] | null {
  try {
    const proc = Bun.spawnSync(
      ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "ignore",
        windowsHide: true,
        timeout: 30_000,
      },
    );
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function walkedFiles(root: string): string[] {
  const files: string[] = [];
  const queue = [""];
  for (let prefix = queue.shift(); prefix !== undefined; prefix = queue.shift()) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(join(root, prefix), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) queue.push(rel);
      } else files.push(rel);
      if (files.length > 20 * INVENTORY_LIMIT) return files;
    }
  }
  return files;
}

/**
 * The workspace's files, sorted: git's view (tracked and untracked, not ignored) in a repository,
 * a walk that skips dependency and build folders otherwise; a file deleted on disk is left out.
 */
export function workspaceFiles(root: string): string[] {
  return (gitFiles(root) ?? walkedFiles(root))
    .filter((path) => existsSync(join(root, path)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The file list of the workspace a review reads (#1506). A criterion that counts or lists files
 * ("exactly 26 production files") could only end inconclusive: the reviewer has no tool that
 * lists files, and fecsmith release (bench round 42) asked it twice for 761k tokens and accepted
 * the criterion unverified. Git's view (tracked and untracked, not ignored) when the workspace is
 * a repository, a walk that skips dependency and build folders otherwise; a file deleted on disk
 * is not listed.
 */
export function workspaceInventory(root: string): WorkspaceInventory {
  const all = workspaceFiles(root);
  const tests = all.filter(isTestCodePath).length;
  const truncated = all.length > INVENTORY_LIMIT;
  return {
    totalFiles: all.length,
    testFiles: tests,
    paths: all.slice(0, INVENTORY_LIMIT),
    truncated,
    note: `The host's list of the files in the reviewed workspace now: ${String(all.length)} file(s), ${String(tests)} of them test files${truncated ? `; the first ${String(INVENTORY_LIMIT)} paths are listed` : ""}. Settle a criterion that counts, lists or limits files from it instead of leaving it inconclusive.`,
  };
}
