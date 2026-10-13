import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Task } from "./types.js";

/**
 * Version-matched library docs for implementers (#741). The source is configured (`libraryDocs`
 * in the global or project config, frozen into the run's policy): a local directory of Markdown
 * files or an MCP tool. Without a source a run gets no docs and nothing else changes.
 */
export const LibraryDocsSchema = z.union([
  z
    .object({
      /** Directory of `<name>@<version>.md` files, absolute or relative to the workspace (`~` is home). */
      dir: z.string().min(1).max(1024),
      maxChars: z.number().int().min(500).max(50_000).optional(),
    })
    .strict(),
  z
    .object({
      mcp: z
        .object({
          /** A server of `mcpServers`. */
          server: z.string().min(1).max(128),
          tool: z.string().min(1).max(128),
          /** Tool arguments; `{name}`, `{version}` and `{ecosystem}` are replaced. */
          args: z.record(z.string(), z.string()).optional(),
        })
        .strict(),
      maxChars: z.number().int().min(500).max(50_000).optional(),
    })
    .strict(),
]);
export type LibraryDocsSource = z.infer<typeof LibraryDocsSchema>;

export type Ecosystem = "npm" | "cargo" | "pypi" | "go";
export interface LockedLibrary {
  name: string;
  version: string;
  ecosystem: Ecosystem;
}

const DEFAULT_MAX_CHARS = 8000;
/** Libraries one task gets docs for. */
export const MAX_LIBRARIES = 3;

const read = (root: string, name: string): string | null => {
  const path = join(root, name);
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
};

/** `[[package]]` tables with `name` and `version`, as Cargo.lock, uv.lock and poetry.lock write them. */
function tomlPackages(text: string, ecosystem: Ecosystem): LockedLibrary[] {
  const found: LockedLibrary[] = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name && version) found.push({ name, version, ecosystem });
  }
  return found;
}

/**
 * The versions the workspace's lockfiles pin: package-lock.json, bun.lock, Cargo.lock, uv.lock,
 * poetry.lock and the `require` lines of go.mod. A name listed twice keeps its first version.
 */
export function lockedLibraries(root: string): LockedLibrary[] {
  const found: LockedLibrary[] = [];
  const npm = read(root, "package-lock.json");
  if (npm)
    try {
      const packages = (JSON.parse(npm) as { packages?: Record<string, { version?: string }> })
        .packages;
      for (const [key, value] of Object.entries(packages ?? {})) {
        const name = key.startsWith("node_modules/") ? key.slice("node_modules/".length) : "";
        if (name && !name.includes("/node_modules/") && value.version)
          found.push({ name, version: value.version, ecosystem: "npm" });
      }
    } catch {
      // An unreadable lockfile pins nothing.
    }
  const bun = read(root, "bun.lock");
  if (bun)
    for (const match of bun.matchAll(/^\s*"([^"]+)":\s*\["((?:@[^@"/]+\/)?[^@"]+)@([^"]+)"/gm))
      if (match[2] && match[1] === match[2] && match[3])
        found.push({ name: match[2], version: match[3], ecosystem: "npm" });
  const cargo = read(root, "Cargo.lock");
  if (cargo) found.push(...tomlPackages(cargo, "cargo"));
  for (const file of ["uv.lock", "poetry.lock"]) {
    const text = read(root, file);
    if (text) found.push(...tomlPackages(text, "pypi"));
  }
  const gomod = read(root, "go.mod");
  if (gomod)
    for (const match of gomod.matchAll(
      /^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+(v[^\s]+)/gim,
    ))
      if (match[1] && match[2]) found.push({ name: match[1], version: match[2], ecosystem: "go" });
  const seen = new Set<string>();
  return found.filter((library) => {
    const key = `${library.ecosystem}:${library.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` imports the library in its ecosystem's syntax. */
function imports(text: string, library: LockedLibrary): boolean {
  const name = escapeRegex(library.name);
  const module = escapeRegex(library.name.replaceAll("-", "_"));
  switch (library.ecosystem) {
    case "npm":
    case "go":
      return new RegExp(
        `(?:from|import|require\\(|import\\()\\s*["'\`]${name}(?:/[^"'\`]*)?["'\`]|^\\s*["']${name}(?:/[^"']*)?["']\\s*$`,
        "m",
      ).test(text);
    case "cargo":
      return new RegExp(`\\b(?:use|extern\\s+crate)\\s+${module}\\b|\\b${module}::`).test(text);
    case "pypi":
      return new RegExp(`^\\s*(?:from|import)\\s+${module}\\b`, "im").test(text);
  }
}

/** Whether the task's title or description names the library as a word. */
const names = (text: string, library: LockedLibrary): boolean =>
  library.name.length >= 3 &&
  new RegExp(`(?:^|[\\s\`'"(])${escapeRegex(library.name)}(?:$|[\\s\`'".,;:)])`, "i").test(text);

/**
 * The locked libraries a task uses: those its existing files and read hints import, then those
 * its title or description names, at most `MAX_LIBRARIES`.
 */
export function taskLibraries(
  root: string,
  task: Pick<Task, "title" | "description" | "writes" | "readHints">,
  locked: readonly LockedLibrary[],
): LockedLibrary[] {
  const sources = [...task.writes.map((w) => w.path), ...task.readHints]
    .map((path) => read(root, path) ?? "")
    .join("\n");
  const text = `${task.title}\n${task.description}`;
  const imported = locked.filter((library) => imports(sources, library));
  const named = locked.filter((library) => !imported.includes(library) && names(text, library));
  return [...imported, ...named].slice(0, MAX_LIBRARIES);
}

/** The directory of a `dir` source. */
export const docsDirectory = (workspace: string, dir: string): string =>
  dir === "~" || dir.startsWith("~/")
    ? join(homedir(), dir.slice(1))
    : isAbsolute(dir)
      ? dir
      : resolve(workspace, dir);

/** A library name as a path below the docs directory; null for a name that would leave it. */
const safeName = (name: string): string | null =>
  name.split("/").every((part) => part && part !== "." && part !== "..") && !name.includes("\\")
    ? name
    : null;

export type McpCall = (
  server: string,
  tool: string,
  args: Record<string, string>,
) => Promise<string>;

/** The docs of one library version from the source, cut to its size limit; null when it has none. */
export async function fetchLibraryDocs(
  workspace: string,
  source: LibraryDocsSource,
  library: LockedLibrary,
  callMcp: McpCall,
): Promise<string | null> {
  const limit = source.maxChars ?? DEFAULT_MAX_CHARS;
  let text: string | null = null;
  if ("dir" in source) {
    const name = safeName(library.name);
    if (!name) return null;
    const dir = docsDirectory(workspace, source.dir);
    for (const file of [`${name}@${library.version}.md`, join(name, `${library.version}.md`)]) {
      text = read(dir, file);
      if (text !== null) break;
    }
  } else {
    const fill = (value: string) =>
      value
        .replaceAll("{name}", library.name)
        .replaceAll("{version}", library.version)
        .replaceAll("{ecosystem}", library.ecosystem);
    const args = Object.fromEntries(
      Object.entries(source.mcp.args ?? { library: "{name}", version: "{version}" }).map(
        ([key, value]) => [key, fill(value)],
      ),
    );
    try {
      text = await callMcp(source.mcp.server, source.mcp.tool, args);
    } catch {
      text = null;
    }
  }
  if (!text?.trim()) return null;
  return text.length > limit ? `${text.slice(0, limit)}\n[cut at ${limit} characters]` : text;
}

/**
 * Calls an MCP tool of a server configured in `mcpServers` (global and project), connecting the
 * server first when no chat has.
 */
export async function configuredMcpCall(
  workspace: string,
  server: string,
  tool: string,
  args: Record<string, string>,
): Promise<string> {
  const { loadConfig, loadEffectiveProjectConfig, mergeConfigs } = await import(
    "../../config/index.js"
  );
  const config = mergeConfigs(loadConfig(), loadEffectiveProjectConfig(workspace));
  const servers = (config.mcpServers ?? []).filter((s) => s.name === server && !s.disabled);
  if (!servers.length) throw new Error(`MCP server "${server}" is not configured`);
  const { getMCPManager } = await import("../mcp/index.js");
  const manager = getMCPManager();
  await manager.ensureConnected(servers);
  return manager.callTool(server, tool, args);
}
