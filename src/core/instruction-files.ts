/**
 * Instruction files as the front ends show and edit them: every file found on disk with whether
 * agents read it, the on/off state of each instruction source (`instructionFiles` in config), and
 * hash-checked writes. The TUI (`/instructions`) and the local API (`/v1/projects/current/instructions`)
 * both use this module so the two surfaces agree on order, hashes and what a save affects.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { INSTRUCTION_SOURCES, loadInstructions } from "./instructions.js";
import { WorkflowStore } from "./workflows/store.js";

export interface InstructionFileEntry {
  /** Position in every agent's prompt; null when the file's source is switched off. */
  order: number | null;
  path: string;
  absolutePath: string;
  /** The instruction source ID (`baked`, `codex`, `claude`, ...) or `project` for the manifest's. */
  source: string;
  /** The source's display name (`AGENTS.md`, `CLAUDE.md`, ...); `baked/project.json` for the manifest's. */
  sourceLabel: string;
  scope: "project" | "global";
  /** Whether agents read the file: its source is on, or the project manifest lists it. */
  enabled: boolean;
  bytes: number;
  /** SHA-256 of the file's bytes. */
  hash: string;
  content: string;
}

export interface InstructionSourceState {
  id: string;
  label: string;
  /** The file names the source looks for, first match wins, in each of the project and home folder. */
  files: string[];
  enabled: boolean;
  defaultEnabled: boolean;
}

export const sha256 = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/** The source IDs agents read: `instructionFiles` from config, or the defaults when it is unset. */
export function enabledInstructionSources(configured: string[] | undefined): string[] {
  return configured ?? INSTRUCTION_SOURCES.filter((s) => s.defaultEnabled).map((s) => s.id);
}

export function instructionSourceStates(configured: string[] | undefined): InstructionSourceState[] {
  const enabled = new Set(enabledInstructionSources(configured));
  return INSTRUCTION_SOURCES.map((s) => ({
    id: s.id,
    label: s.label,
    files: [...s.files],
    enabled: enabled.has(s.id),
    defaultEnabled: s.defaultEnabled,
  }));
}

/** The new `instructionFiles` value after switching `id` on or off, in source order. */
export function toggledInstructionSources(
  configured: string[] | undefined,
  id: string,
  enabled: boolean,
): string[] {
  const next = new Set(enabledInstructionSources(configured));
  if (enabled) next.add(id);
  else next.delete(id);
  const known = INSTRUCTION_SOURCES.map((s) => s.id);
  return [...known.filter((s) => next.has(s)), ...[...next].filter((s) => !known.includes(s))];
}

export function isInstructionSource(id: string): boolean {
  return INSTRUCTION_SOURCES.some((s) => s.id === id);
}

/**
 * Every non-empty instruction file in the project and home folder, switched on or not, with the
 * manifest's files last. Enabled files are numbered in the order agents read them.
 */
export function listInstructionFiles(
  workspace: string,
  configured: string[] | undefined,
  opts: { homeDir?: string } = {},
): InstructionFileEntry[] {
  const home = opts.homeDir ?? homedir();
  const enabled = new Set(enabledInstructionSources(configured));
  const all = loadInstructions(
    workspace,
    INSTRUCTION_SOURCES.map((s) => s.id),
    { homeDir: home },
  );
  let order = 0;
  return all.map((entry) => {
    const absolute = resolve(entry.scope === "project" ? workspace : home, entry.file);
    const bytes = readFileSync(absolute);
    const on = entry.source === "project" || enabled.has(entry.source);
    return {
      order: on ? ++order : null,
      path: entry.file,
      absolutePath: absolute,
      source: entry.source,
      sourceLabel:
        INSTRUCTION_SOURCES.find((s) => s.id === entry.source)?.label ?? "baked/project.json",
      scope: entry.scope,
      enabled: on,
      bytes: bytes.byteLength,
      hash: sha256(bytes),
      content: bytes.toString("utf8"),
    };
  });
}

/** The listed file at `path`; a project file wins over a global one with the same path. */
export function findInstructionFile(
  files: InstructionFileEntry[],
  path: string,
): InstructionFileEntry | undefined {
  return (
    files.find((f) => f.path === path && f.scope === "project") ?? files.find((f) => f.path === path)
  );
}

/** The source a new project file at `path` would belong to, when `path` is one a source reads. */
export function sourceForNewFile(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  return INSTRUCTION_SOURCES.find((s) => s.files.includes(normalized))?.id ?? null;
}

export type InstructionWrite =
  | { status: "saved"; absolutePath: string }
  | { status: "changed"; message: string }
  | { status: "unknown"; message: string };

/**
 * Writes an instruction file when it still has the content that was read. `expectedHash: null`
 * creates a project file at one of the paths a source reads; it fails as `changed` when a
 * non-empty file is already there.
 */
export function writeInstructionFile(
  workspace: string,
  files: InstructionFileEntry[],
  path: string,
  content: string,
  expectedHash: string | null,
): InstructionWrite {
  if (expectedHash === null) {
    if (!sourceForNewFile(path))
      return { status: "unknown", message: `${path} is not a file name an instruction source reads` };
    const absolute = resolve(workspace, path);
    if (
      findInstructionFile(files, path)?.scope === "project" ||
      (existsSync(absolute) && readFileSync(absolute, "utf8").trim() !== "")
    )
      return { status: "changed", message: `${path} already exists; read it again` };
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    return { status: "saved", absolutePath: absolute };
  }
  const entry = findInstructionFile(files, path);
  if (!entry)
    return { status: "unknown", message: `${path} is not one of the instruction files agents read` };
  const current = existsSync(entry.absolutePath) ? sha256(readFileSync(entry.absolutePath)) : "";
  if (current !== expectedHash)
    return { status: "changed", message: `${path} changed since it was read; read it again` };
  writeFileSync(entry.absolutePath, content);
  return { status: "saved", absolutePath: entry.absolutePath };
}

const ENDED = new Set(["completed", "failed", "cancelled"]);

/** Runs in `store` that have not ended and froze `absolutePath` as an input. */
export function runsFreezingFile(store: WorkflowStore, absolutePath: string): string[] {
  const target = resolve(absolutePath);
  return store
    .list(100)
    .items.filter((run) => !ENDED.has(run.status))
    .filter((run) =>
      Object.keys(store.state(run.runId).frozenFiles).some((file) => resolve(file) === target),
    )
    .map((run) => run.runId);
}

/** `runsFreezingFile` on the workspace's workflow database, read-only; none when there is none. */
export function workspaceRunsFreezing(workspace: string, absolutePath: string): string[] {
  let store: WorkflowStore | null = null;
  try {
    store = new WorkflowStore(workspace, true);
    return runsFreezingFile(store, absolutePath);
  } catch {
    return [];
  } finally {
    store?.close();
  }
}
