/**
 * Installing BAKED packages (#135) into a project: `inspectPackage` reads a package and plans the
 * copy into `baked/agents`, `baked/skills`, `baked/workflows` and `baked/gates`, validating each
 * file with the loader that will read it; `installPackage` writes an approved plan and records it
 * in `baked/packages.json`; `removePackage` deletes the files that still have their installed
 * hash. Nothing is ever read from the package after the install, so there is no runtime loading
 * from outside the project (the external presets removed in #52 stay removed). Installed gates
 * still need `baked workflow gates confirm` like any other project gate.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { assertProfileCapabilities } from "../agents/profiles/registry.js";
import { hashBytes, hashJson } from "../specs/hash.js";
import { writeViaTemp } from "../workflows/atomic-write.js";
import { defaultWorkflowPolicy } from "../workflows/defaults.js";
import { ProfileSchema, type RunPolicy, WorkflowSchema } from "../workflows/schemas.js";
import {
  type Gate,
  GateSchema,
  validateGate,
  validateWorkflowV2,
  type WorkflowV2,
  WorkflowV2Schema,
} from "../workflows/v2/definition.js";
import { gateDirectories, loadGateLibrary, readConfirmations } from "../workflows/v2/library.js";
import { upgradeWorkflowV1 } from "../workflows/v2/upgrade.js";
import {
  PACKAGE_KINDS,
  PackageError,
  type PackageFile,
  type PackageKind,
  PackageName,
  pathProblem,
  readPackage,
  Sha256,
} from "./manifest.js";

/** The lock file of a project, relative to the workspace. */
export const LOCK_PATH = "baked/packages.json";

const LockedFile = z.strictObject({
  /** The project path, `baked/<package path>`. */
  path: z.string().refine((p) => p.startsWith("baked/") && pathProblem(p.slice(6)) === null, {
    message: "not a package file under baked/",
  }),
  sha256: Sha256,
});
const InstalledPackageSchema = z.strictObject({
  name: PackageName,
  version: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  installedAt: z.string(),
  files: z.array(LockedFile),
});
const LockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  packages: z.array(InstalledPackageSchema),
});
export type InstalledPackage = z.infer<typeof InstalledPackageSchema>;

export type FileStatus = "new" | "identical" | "overwrite";
export interface PlannedFile {
  /** The path in the package. */
  path: string;
  /** The project path it is copied to, `baked/<path>`. */
  target: string;
  kind: PackageKind;
  sha256: string;
  size: number;
  /** `overwrite`: the project has a different file there, which an install replaces only when asked. */
  status: FileStatus;
}
/** A file the installed version of the package shipped and this version does not. */
export interface StaleFile {
  target: string;
  /** `remove`: unchanged since the install; `keep`: edited since, left in place; `missing`: gone. */
  action: "remove" | "keep" | "missing";
}
export interface PackagePlan {
  /** The package folder. */
  source: string;
  workspace: string;
  name: string;
  version: string;
  description: string | null;
  /** The version of this package the project has installed, or null. */
  installed: string | null;
  files: PlannedFile[];
  stale: StaleFile[];
  /** IDs by kind: agent profiles, skills, workflow definitions and gates. */
  contents: Record<PackageKind, string[]>;
  /** Gates whose installed definition is not confirmed in this workspace; runs refuse them until then. */
  gatesToConfirm: string[];
  /** What blocks the install: invalid definitions, files owned by another package, unsafe targets. */
  problems: string[];
  /** Files that would replace a different project file. */
  overwrites: number;
  /** The hash of what the plan shows; an install recomputes it and refuses a different one. */
  planHash: string;
}
export interface InspectOptions {
  /** The run policy whose checks are gates; defaults to the built-in policy. */
  policy?: RunPolicy;
  /** Gate folders for validation; tests point the user's folder elsewhere. */
  gateDirectories?: { user: string; project: string };
}
export interface InstallResult {
  name: string;
  version: string;
  written: string[];
  unchanged: string[];
  removed: string[];
  kept: string[];
  gatesToConfirm: string[];
}
export interface RemoveResult {
  name: string;
  version: string;
  removed: string[];
  /** Files edited since the install; they stay in the project. */
  kept: string[];
  missing: string[];
}
export interface PackageListEntry extends InstalledPackage {
  /** Installed files whose content changed or that are gone. */
  changed: string[];
}

const projectFile = (workspace: string, target: string): string =>
  join(workspace, ...target.split("/"));

export function readLock(workspace: string): InstalledPackage[] {
  const path = projectFile(workspace, LOCK_PATH);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PackageError("INVALID_LOCK", `${LOCK_PATH} is not JSON: ${(error as Error).message}`);
  }
  const parsed = LockSchema.safeParse(raw);
  if (!parsed.success)
    throw new PackageError(
      "INVALID_LOCK",
      `${LOCK_PATH}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return parsed.data.packages;
}

/** A skill an installed package put in `baked/skills/<id>/SKILL.md`. */
export interface PackageSkill {
  name: string;
  /** Absolute path of the SKILL.md. */
  path: string;
  scope: "package";
  /** The package that installed it. */
  package: string;
}

/**
 * The skills installed packages put in the project, from the lock file, while their SKILL.md is
 * still there (#1106). Workflow profiles that name them use them; the chat agent's skill folders
 * (`listInstalledSkills`) do not include them. An unreadable lock file lists none.
 */
export function listPackageSkills(workspace: string): PackageSkill[] {
  let packages: InstalledPackage[];
  try {
    packages = readLock(workspace);
  } catch {
    return [];
  }
  return packages
    .flatMap((entry) =>
      entry.files.flatMap((file) => {
        const id = /^baked\/skills\/([^/]+)\/SKILL\.md$/.exec(file.path)?.[1];
        const path = projectFile(workspace, file.path);
        return id && existsSync(path)
          ? [{ name: id, path, scope: "package" as const, package: entry.name }]
          : [];
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

function writeLock(workspace: string, packages: InstalledPackage[]): void {
  const path = projectFile(workspace, LOCK_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name));
  writeViaTemp(path, `${JSON.stringify({ schemaVersion: 1, packages: sorted }, null, 2)}\n`, {
    flag: "w",
    flush: true,
  });
}

/** The current hash of a project file, `null` when it is missing, `"other"` when it is not a file. */
function currentHash(workspace: string, target: string): string | null {
  const path = projectFile(workspace, target);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile()) return "other";
  return hashBytes(readFileSync(path));
}

/** A symbolic link or file on the way to `target` inside the project, which a write would follow. */
function unsafeAncestor(workspace: string, target: string): string | null {
  const parts = target.split("/");
  for (let i = 1; i < parts.length; i++) {
    const rel = parts.slice(0, i).join("/");
    const path = projectFile(workspace, rel);
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return `${rel} is a symbolic link`;
    if (!stat.isDirectory()) return `${rel} is not a folder`;
  }
  return null;
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const message = (error: unknown): string =>
  error instanceof z.ZodError
    ? error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ")
    : error instanceof Error
      ? error.message
      : String(error);

/**
 * Validates each definition with the checks its loader runs; returns problems and IDs by kind.
 * With a workspace, a profile's skills may come from the project and workflows see the project's
 * and the user's gates; with null (writing a package's manifest), only the package's own content
 * and the built-in and policy gates count.
 */
export function validatePackageContents(
  pkgFiles: readonly PackageFile[],
  workspace: string | null,
  options: InspectOptions,
): { problems: string[]; contents: Record<PackageKind, string[]>; gates: Gate[] } {
  const problems: string[] = [];
  const contents: Record<PackageKind, string[]> = {
    agents: [],
    skills: [],
    workflows: [],
    gates: [],
  };
  const gates: Gate[] = [];
  const byPath = new Map(pkgFiles.map((f) => [f.path, f]));
  const json = (bytes: Uint8Array): unknown => {
    try {
      return JSON.parse(text(bytes));
    } catch (error) {
      throw new Error(`not JSON: ${(error as Error).message}`);
    }
  };
  const policy = options.policy ?? defaultWorkflowPolicy;

  for (const file of pkgFiles) {
    const isDefinition = file.path.split("/").length === 2 && file.path.endsWith(".json");
    if (file.kind === "skills") {
      const id = file.path.split("/")[1] ?? "";
      if (!contents.skills.includes(id)) contents.skills.push(id);
      continue;
    }
    if (!isDefinition) continue;
    const fileId = file.path.split("/")[1]?.slice(0, -".json".length) ?? "";
    try {
      const raw = json(file.bytes);
      if (file.kind === "agents") {
        const profile = ProfileSchema.parse(raw);
        assertProfileCapabilities(profile);
        for (const skill of profile.skills) {
          const shipped = byPath.get(`skills/${skill.id}/SKILL.md`);
          const hash = shipped
            ? shipped.sha256
            : workspace === null
              ? null
              : currentHash(workspace, `baked/skills/${skill.id}/SKILL.md`);
          if (hash !== skill.hash)
            problems.push(
              workspace === null
                ? `${file.path}: needs skill ${skill.id} with hash ${skill.hash.slice(0, 12)}, which the package does not ship`
                : `${file.path}: needs skill ${skill.id} with hash ${skill.hash.slice(0, 12)}, which neither the package nor the project has`,
            );
        }
        contents.agents.push(profile.id);
      } else if (file.kind === "gates") {
        const gate = GateSchema.parse(raw);
        if (gate.id !== fileId) throw new Error(`the file name must be ${gate.id}.json`);
        const errors = validateGate(gate);
        if (errors.length) throw new Error(errors.join("; "));
        gates.push(gate);
        contents.gates.push(gate.id);
      }
    } catch (error) {
      problems.push(`${file.path}: ${message(error)}`);
    }
  }

  // Workflows are checked against the gates the project will have after the install.
  const library =
    workspace === null
      ? loadGateLibrary("", policy, null)
      : loadGateLibrary(workspace, policy, options.gateDirectories ?? gateDirectories(workspace));
  const allGates = new Map(library.gates);
  for (const gate of gates) allGates.set(gate.id, gate);
  for (const file of pkgFiles) {
    if (file.kind !== "workflows") continue;
    const fileId = file.path.slice("workflows/".length, -".json".length);
    try {
      const raw = json(file.bytes) as { schemaVersion?: unknown };
      let workflow: WorkflowV2;
      if (raw.schemaVersion === 2) workflow = WorkflowV2Schema.parse(raw);
      else workflow = upgradeWorkflowV1(WorkflowSchema.parse(raw), policy);
      if (workflow.id !== fileId) throw new Error(`the file name must be ${workflow.id}.json`);
      const errors = validateWorkflowV2(workflow, allGates);
      if (errors.length) throw new Error(errors.join("; "));
      contents.workflows.push(workflow.id);
    } catch (error) {
      problems.push(`${file.path}: ${message(error)}`);
    }
  }
  for (const kind of PACKAGE_KINDS) contents[kind].sort();
  return { problems, contents, gates };
}

/**
 * Reads a package and plans its install into `workspace`; writes nothing. Throws a PackageError
 * when the package itself is broken (manifest, paths, hashes, unlisted files, symbolic links);
 * definitions that would not load are reported in `problems`, which block the install.
 */
export function inspectPackage(
  path: string,
  workspace: string,
  options: InspectOptions = {},
): PackagePlan {
  const pkg = readPackage(resolve(workspace, path));
  const { manifest } = pkg;
  const { problems, contents, gates } = validatePackageContents(pkg.files, workspace, options);
  const lock = readLock(workspace);
  const owners = new Map<string, string>();
  for (const entry of lock)
    if (entry.name !== manifest.name) for (const f of entry.files) owners.set(f.path, entry.name);
  const previous = lock.find((p) => p.name === manifest.name) ?? null;

  const files: PlannedFile[] = pkg.files.map((file) => {
    const target = `baked/${file.path}`;
    const unsafe = unsafeAncestor(workspace, target);
    if (unsafe) problems.push(`${target}: ${unsafe}`);
    const owner = owners.get(target);
    if (owner) problems.push(`${target} belongs to the installed package ${owner}`);
    const current = currentHash(workspace, target);
    if (current === "other") problems.push(`${target} exists and is not a regular file`);
    const status: FileStatus =
      current === null ? "new" : current === file.sha256 ? "identical" : "overwrite";
    return {
      path: file.path,
      target,
      kind: file.kind,
      sha256: file.sha256,
      size: file.bytes.byteLength,
      status,
    };
  });
  const shipped = new Set(files.map((f) => f.target));
  const stale: StaleFile[] = (previous?.files ?? [])
    .filter((f) => !shipped.has(f.path))
    .map((f) => {
      const current = currentHash(workspace, f.path);
      return {
        target: f.path,
        action: current === null ? "missing" : current === f.sha256 ? "remove" : "keep",
      };
    });
  const confirmed = readConfirmations(workspace);
  const gatesToConfirm = gates.filter((g) => confirmed[g.id] !== hashJson(g)).map((g) => g.id);
  const shown = {
    source: pkg.root,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? null,
    installed: previous?.version ?? null,
    files: files.map(({ target, sha256, status }) => ({ target, sha256, status })),
    stale,
    problems,
  };
  return {
    source: pkg.root,
    workspace,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? null,
    installed: previous?.version ?? null,
    files,
    stale,
    contents,
    gatesToConfirm,
    problems,
    overwrites: files.filter((f) => f.status === "overwrite").length,
    planHash: hashJson(shown),
  };
}

/** Removes empty folders from `target`'s folder up to (not including) `baked/<kind>`. */
function pruneEmpty(workspace: string, target: string): void {
  const parts = target.split("/");
  for (let depth = parts.length - 1; depth > 2; depth--) {
    const dir = projectFile(workspace, parts.slice(0, depth).join("/"));
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}

/** Deletes a project file when it still has `sha256`; returns what happened to it. */
function removeIfUnchanged(
  workspace: string,
  target: string,
  sha256: string,
): "removed" | "kept" | "missing" {
  const current = currentHash(workspace, target);
  if (current === null) return "missing";
  if (current !== sha256) return "kept";
  rmSync(projectFile(workspace, target));
  pruneEmpty(workspace, target);
  return "removed";
}

/**
 * Installs a plan the person approved. The package is read and planned again, and the install is
 * refused when that plan's hash differs from the approved one (the package or the project changed
 * in between), when the plan has problems, or when it would replace different project files
 * without `overwrite`. Files are written through temp files; a failure restores the files written
 * so far. Gates are not confirmed: runs ask for `baked workflow gates confirm` as for any gate.
 */
export function installPackage(
  plan: Pick<PackagePlan, "source" | "workspace" | "planHash">,
  options: { approved: true; overwrite?: boolean } & InspectOptions,
): InstallResult {
  if (options.approved !== true)
    throw new PackageError("NOT_APPROVED", "An install needs the person's approval of the plan");
  const { workspace } = plan;
  const fresh = inspectPackage(plan.source, workspace, options);
  if (fresh.planHash !== plan.planHash)
    throw new PackageError(
      "STALE_PLAN",
      "The package or the project changed since the plan was shown; inspect it again",
    );
  if (fresh.problems.length)
    throw new PackageError("INVALID_PACKAGE", `Not installed:\n${fresh.problems.join("\n")}`);
  if (fresh.overwrites > 0 && !options.overwrite)
    throw new PackageError(
      "CONFLICT",
      `Not installed: it would replace ${fresh.overwrites} different project ${fresh.overwrites === 1 ? "file" : "files"} (${fresh.files
        .filter((f) => f.status === "overwrite")
        .map((f) => f.target)
        .join(", ")}); install with overwrite to replace them`,
    );
  const pkg = readPackage(plan.source);
  const bytes = new Map(pkg.files.map((f) => [f.path, f.bytes]));
  const written: { target: string; previous: Uint8Array | null }[] = [];
  try {
    for (const file of fresh.files) {
      if (file.status === "identical") continue;
      const content = bytes.get(file.path);
      // readPackage checked the hashes again; a file changing between the two reads is refused.
      if (!content || hashBytes(content) !== file.sha256)
        throw new PackageError("STALE_PLAN", `${file.path} changed during the install`);
      const path = projectFile(workspace, file.target);
      const previous = existsSync(path) ? readFileSync(path) : null;
      mkdirSync(dirname(path), { recursive: true });
      writeViaTemp(path, content, { flag: "w", flush: true });
      written.push({ target: file.target, previous });
    }
  } catch (error) {
    for (const { target, previous } of written.reverse()) {
      const path = projectFile(workspace, target);
      try {
        if (previous) writeViaTemp(path, previous, { flag: "w", flush: true });
        else {
          rmSync(path, { force: true });
          pruneEmpty(workspace, target);
        }
      } catch {
        // Best effort: the error below names the failure.
      }
    }
    throw error;
  }
  const removed: string[] = [];
  const kept: string[] = [];
  const lock = readLock(workspace);
  const previous = new Map(
    (lock.find((p) => p.name === fresh.name)?.files ?? []).map((f) => [f.path, f.sha256]),
  );
  for (const stale of fresh.stale) {
    const sha256 = previous.get(stale.target);
    if (sha256 === undefined) continue;
    const outcome = removeIfUnchanged(workspace, stale.target, sha256);
    if (outcome === "removed") removed.push(stale.target);
    if (outcome === "kept") kept.push(stale.target);
  }
  const others = lock.filter((p) => p.name !== fresh.name);
  others.push({
    name: fresh.name,
    version: fresh.version,
    ...(fresh.description !== null ? { description: fresh.description } : {}),
    installedAt: new Date().toISOString(),
    files: fresh.files.map((f) => ({ path: f.target, sha256: f.sha256 })),
  });
  writeLock(workspace, others);
  return {
    name: fresh.name,
    version: fresh.version,
    written: written.map((w) => w.target),
    unchanged: fresh.files.filter((f) => f.status === "identical").map((f) => f.target),
    removed,
    kept,
    gatesToConfirm: fresh.gatesToConfirm,
  };
}

/** The packages installed in a project, with the files changed since. */
export function listPackages(workspace: string): PackageListEntry[] {
  return readLock(workspace).map((entry) => ({
    ...entry,
    changed: entry.files
      .filter((f) => currentHash(workspace, f.path) !== f.sha256)
      .map((f) => f.path),
  }));
}

/**
 * Removes an installed package: deletes each of its files that still has its installed hash,
 * keeps files edited since (and says so), and drops the package from the lock file.
 */
export function removePackage(workspace: string, name: string): RemoveResult {
  const lock = readLock(workspace);
  const entry = lock.find((p) => p.name === name);
  if (!entry) throw new PackageError("NOT_INSTALLED", `No installed package ${name}`);
  const result: RemoveResult = { name, version: entry.version, removed: [], kept: [], missing: [] };
  for (const file of entry.files) {
    const outcome = removeIfUnchanged(workspace, file.path, file.sha256);
    result[outcome].push(file.path);
  }
  writeLock(
    workspace,
    lock.filter((p) => p.name !== name),
  );
  return result;
}

const STATUS_WORD: Record<FileStatus, string> = {
  new: "new      ",
  identical: "same     ",
  overwrite: "REPLACES ",
};

/** The plan as text lines, for the CLI and the terminal UI. */
export function describePlan(plan: PackagePlan): string[] {
  const lines = [
    `Package ${plan.name} ${plan.version}${plan.installed ? ` (installed: ${plan.installed})` : ""} from ${plan.source}`,
  ];
  if (plan.description) lines.push(`  ${plan.description}`);
  const kinds = PACKAGE_KINDS.filter((k) => plan.contents[k].length)
    .map((k) => `${k}: ${plan.contents[k].join(", ")}`)
    .join("; ");
  if (kinds) lines.push(`Contents: ${kinds}`);
  lines.push("Files:");
  for (const f of plan.files)
    lines.push(
      `  ${STATUS_WORD[f.status]}${f.target}${f.status === "overwrite" ? " (differs from the project's file)" : ""}`,
    );
  const removes = plan.stale.filter((s) => s.action === "remove");
  const keeps = plan.stale.filter((s) => s.action === "keep");
  if (removes.length)
    lines.push(
      `Removes files of ${plan.installed} this version no longer ships:`,
      ...removes.map((s) => `  ${s.target}`),
    );
  if (keeps.length)
    lines.push(
      `Keeps files of ${plan.installed} edited since the install:`,
      ...keeps.map((s) => `  ${s.target}`),
    );
  if (plan.gatesToConfirm.length)
    lines.push(
      `Gates to confirm after the install, before a run may use them: baked workflow gates confirm ${plan.gatesToConfirm.join(" ")}`,
    );
  if (plan.problems.length)
    lines.push("Cannot be installed:", ...plan.problems.map((p) => `  ${p}`));
  else if (plan.overwrites)
    lines.push(
      `${plan.overwrites} project ${plan.overwrites === 1 ? "file differs" : "files differ"}; installing replaces ${plan.overwrites === 1 ? "it" : "them"} only with overwrite.`,
    );
  return lines;
}

/** One line per installed package. */
export function describeInstalled(entry: PackageListEntry): string {
  const changed = entry.changed.length ? ` · ${entry.changed.length} changed since install` : "";
  return `${entry.name} ${entry.version} · ${entry.files.length} files · installed ${entry.installedAt.slice(0, 16).replace("T", " ")}${changed}`;
}

/** The outcome of a removal in words. */
export function describeRemoval(result: RemoveResult): string[] {
  const lines = [
    `Removed ${result.name} ${result.version}: ${result.removed.length} files deleted.`,
  ];
  if (result.kept.length)
    lines.push("Kept, edited since the install:", ...result.kept.map((p) => `  ${p}`));
  if (result.missing.length) lines.push(`Already gone: ${result.missing.join(", ")}`);
  return lines;
}

/** The outcome of an install in words. */
export function describeInstall(result: InstallResult): string[] {
  const lines = [
    `Installed ${result.name} ${result.version}: ${result.written.length} files written, ${result.unchanged.length} already identical.`,
  ];
  if (result.removed.length)
    lines.push(`Removed files the new version no longer ships: ${result.removed.join(", ")}`);
  if (result.kept.length)
    lines.push(`Kept edited files the new version no longer ships: ${result.kept.join(", ")}`);
  if (result.gatesToConfirm.length)
    lines.push(
      `Confirm its gates before a run uses them: baked workflow gates confirm ${result.gatesToConfirm.join(" ")}`,
    );
  return lines;
}
