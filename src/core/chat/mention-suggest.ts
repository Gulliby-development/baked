import { type Dirent, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { IGNORED_DIRS } from "../context/file-tree.js";
import { fuzzyFilter } from "../history/fuzzy.js";
import { builtinForbidden, isForbidden } from "../security/forbidden.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";

/** One `@` completion: `insert` is the text that follows the `@`. */
export interface MentionSuggestion {
  kind: "file" | "directory" | "symbol";
  insert: string;
  label: string;
  detail: string;
  /** Matched character offsets in `label`, for highlighting. */
  indices: number[];
}

const CACHE_MS = 15_000;
const WALK_CAP = 20_000;
const cache = new Map<string, { at: number; paths: Promise<string[]> }>();

async function gitFiles(cwd: string): Promise<string[] | null> {
  try {
    const proc = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    });
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return text.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

function walk(cwd: string): string[] {
  const out: string[] = [];
  const stack = [cwd];
  while (stack.length > 0 && out.length < WALK_CAP) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(abs);
      } else if (e.isFile()) {
        out.push(relative(cwd, abs).replaceAll("\\", "/"));
      }
    }
  }
  return out;
}

/** Files and directories of the workspace, relative, without ignored and forbidden ones. */
async function listPaths(cwd: string): Promise<string[]> {
  const files = ((await gitFiles(cwd)) ?? walk(cwd)).filter((f) => {
    const abs = join(cwd, f);
    return !isForbidden(abs) && !builtinForbidden(abs);
  });
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join("/")}/`);
  }
  return [...dirs, ...files];
}

function workspacePaths(cwd: string): Promise<string[]> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.paths;
  const paths = listPaths(cwd);
  cache.set(cwd, { at: Date.now(), paths });
  return paths;
}

/** Forgets the cached file list, so new files show up at once. */
export function clearMentionCache(cwd?: string): void {
  if (cwd) cache.delete(cwd);
  else cache.clear();
}

/** The `@` token that ends at `cursor`, if the cursor is inside one. */
export function mentionAtCursor(
  text: string,
  cursor: number = text.length,
): { query: string; start: number } | null {
  const before = text.slice(0, cursor);
  const m = /(^|[\s([{,;])@([^\s"'`()<>[\]{},;@]*)$/.exec(before);
  if (!m) return null;
  // A `!` command line is shell text: `@` there is literal.
  const lineStart = before.lastIndexOf("\n") + 1;
  if (lineStart === 0 && before.trimStart().startsWith("!")) return null;
  return { query: m[2] ?? "", start: m.index + (m[1]?.length ?? 0) };
}

/**
 * Fuzzy completions for an `@` query: workspace files and directories, then symbols from the
 * repository graph when the query looks like an identifier.
 */
export async function suggestMentions(
  query: string,
  opts: { cwd: string; repoMap?: IntelligenceClient; limit?: number },
): Promise<MentionSuggestion[]> {
  const limit = opts.limit ?? 20;
  const paths = await workspacePaths(opts.cwd);
  const pathMatches = fuzzyFilter(query, paths, limit).map(
    (m): MentionSuggestion => ({
      kind: m.entry.endsWith("/") ? "directory" : "file",
      insert: m.entry,
      label: m.entry,
      detail: m.entry.endsWith("/") ? "directory" : "file",
      indices: m.indices,
    }),
  );
  const symbols: MentionSuggestion[] = [];
  const ident = /^[A-Za-z_$][\w$]*(?:\.[\w$]*)?$/.test(query) && query.length >= 2;
  if (ident && opts.repoMap?.isReady) {
    const [container, member] = query.includes(".") ? query.split(".") : [query, undefined];
    try {
      if (member !== undefined && container) {
        const members = await opts.repoMap.getClassMembers(container);
        for (const s of fuzzyFilter(
          member,
          members.map((x) => x.name),
          8,
        )) {
          const label = `${container}.${s.entry}`;
          symbols.push({
            kind: "symbol",
            insert: label,
            label,
            detail: members.find((x) => x.name === s.entry)?.kind ?? "member",
            indices: [],
          });
        }
      } else {
        const found = await opts.repoMap.searchSymbolsFts(`${query}*`, 8);
        for (const s of found) {
          if (symbols.some((x) => x.label === s.name)) continue;
          symbols.push({
            kind: "symbol",
            insert: s.name,
            label: s.name,
            detail: `${s.kind} · ${s.path}:${String(s.line)}`,
            indices: [...s.name.slice(0, query.length)].map((_, i) => i),
          });
        }
      }
    } catch {
      // The graph may be rescanning; paths are still useful on their own.
    }
  }
  // Exact-ish symbol hits rank above scattered path matches.
  const merged = query
    ? [...symbols.slice(0, 5), ...pathMatches, ...symbols.slice(5)]
    : pathMatches;
  return merged.slice(0, limit);
}
