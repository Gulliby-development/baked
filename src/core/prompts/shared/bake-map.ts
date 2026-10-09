/**
 * Baked Map content builder.
 * The Baked Map is injected as a user message (aider pattern) — models treat
 * user content as context to reference, keeping it separate from instructions.
 *
 * The map is rebuilt after every edit (uncached), while the system prompt
 * stays stable (cached). This separation is key for prompt caching efficiency.
 */
import { walkDir } from "../../context/file-tree.js";

const BAKE_MAP_DESCRIPTION = `This is the Baked Map — a live structural view of the entire codebase, rebuilt after every edit.
It is ranked by importance, so the highest-impact files surface first.

What each part means:
- Files are ranked by importance (highest-impact files first)
- (→N) after a file = blast radius — N other files depend on it
- + before a symbol = exported (part of the public API)
- ← arrows = "imported by" — shows which files depend on this one
- Signatures show function/type shapes so you can understand APIs without reading files
- Key dependencies section shows external packages and how widely they're used`;

const BAKE_MAP_USAGE = `This map is a ranked, truncated index — an orientation layer, not the codebase. It surfaces the highest-impact files and exports; lower-ranked symbols, bodies, and whole files are cut (see "+N more", "... (N more)"). Use it to locate, not to conclude.

- "Where is X?" → the map points you at a file + line to confirm with a read/navigate.
- "What does Y export?" → a starting list; verify before asserting the full surface.
- "What depends on Z?" → (→N) and ← arrows orient blast radius; bake_impact confirms it.

Absence from the map is NOT absence from the codebase — a missing symbol may be ranked out, not nonexistent. Before stating any claim about how the code behaves, confirm it with a bake tool (bake_grep() / bake_find() / navigate() / read()). The map tells you where to look; the tools tell you what's true. Reason from the snapshot, answer from the tools.`;

const LEGEND = "+ = exported. (→N) = blast radius. [NEW] = modified in last 48h.\n";
const DIR_TREE_DEPTH = 2;

const DIR_TREE_TTL_MS = 60_000;
const dirTreeCache = new Map<string, { result: string | null; at: number }>();

/**
 * Build a shallow directory tree (2 levels deep) for project structure overview.
 * Complements the Baked Map's file-level detail with directory-level context.
 *
 * Result cached per `(cwd, limit)` for DIR_TREE_TTL_MS. The cache also clears
 * on edit via `invalidateDirectoryTree(cwd)` — called from ContextManager when
 * the file set changes. TTL is the fallback for external file creates/deletes
 * that bypass the edit hook.
 */
export function buildDirectoryTree(cwd: string, limit = 60): string | null {
  const key = `${cwd}|${String(limit)}`;
  const cached = dirTreeCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < DIR_TREE_TTL_MS) {
    return cached.result;
  }
  const lines: string[] = [];
  walkDir(cwd, "", DIR_TREE_DEPTH, lines);
  let result: string | null;
  if (lines.length === 0) {
    result = null;
  } else {
    const trimmed = lines.length > limit ? lines.slice(0, limit) : lines;
    result =
      trimmed.join("\n") +
      (lines.length > limit ? `\n... (${String(lines.length - limit)} more)` : "");
  }
  dirTreeCache.set(key, { result, at: now });
  return result;
}

export function invalidateDirectoryTree(cwd?: string): void {
  if (!cwd) {
    dirTreeCache.clear();
    return;
  }
  for (const key of dirTreeCache.keys()) {
    if (key.startsWith(`${cwd}|`)) dirTreeCache.delete(key);
  }
}

export function buildBakeMapUserMessage(
  rendered: string,
  isMinimal: boolean,
  dirTree?: string | null,
  entryPoints?: string[] | null,
): string {
  const legend = isMinimal ? "" : LEGEND;
  const treeSection = dirTree ? `\n<directory_tree>\n${dirTree}\n</directory_tree>\n` : "";
  const entrySection =
    entryPoints && entryPoints.length > 0
      ? `\n<entry_points>\n${entryPoints.slice(0, 8).join("\n")}\n</entry_points>\n`
      : "";
  return (
    `<bake_map>\n` +
    `<description>\n${BAKE_MAP_DESCRIPTION}\n</description>\n\n` +
    `<how_to_use>\n${BAKE_MAP_USAGE}\n</how_to_use>\n${treeSection}${entrySection}\n` +
    `<data>\n${legend}${rendered}\n</data>\n` +
    `</bake_map>`
  );
}

export function buildBakeMapAck(): string {
  // Neutral anchor (per Gemini 3 long-context guidance: bridge phrase after large data blocks).
  // Avoids first-person assistant narration that contradicts answer_voice.
  return "Baked Map indexed. Subsequent requests resolve file paths, symbols, and dependencies against it.";
}
