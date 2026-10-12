/**
 * Finds `baked!`, `baked?` and `baked` comments in a file. A marker counts only inside a comment
 * of the file's language, as a whole word at the start or end of the comment, so a string literal
 * or prose that mentions "baked" does not start the agent. Files of unknown languages fall back to
 * matching whole lines.
 */

import { extname } from "node:path";

export type MarkerKind = "act" | "ask" | "context";

export interface Marker {
  kind: MarkerKind;
  /** 1-based first and last line of the comment group. */
  line: number;
  endLine: number;
  /** The comment text of the group, marker words removed, lines joined with newlines. */
  text: string;
}

interface CommentStyle {
  line: readonly string[];
  block: readonly (readonly [string, string])[];
  /** Quote characters that open string literals; the same character closes them. */
  quotes: readonly string[];
  /** Python-style `'''` and `"""` strings. */
  tripleQuotes?: boolean;
}

const C_LIKE: CommentStyle = { line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'", "`"] };
const HASH: CommentStyle = { line: ["#"], block: [], quotes: ['"', "'"] };
const PYTHON: CommentStyle = { ...HASH, tripleQuotes: true };
const DASH: CommentStyle = { line: ["--"], block: [], quotes: ['"', "'"] };
const SQL: CommentStyle = { line: ["--"], block: [["/*", "*/"]], quotes: ["'", '"'] };
const LISP: CommentStyle = { line: [";"], block: [], quotes: ['"'] };
const MARKUP: CommentStyle = { line: [], block: [["<!--", "-->"]], quotes: [] };
const CSS: CommentStyle = { line: [], block: [["/*", "*/"]], quotes: ['"', "'"] };

const STYLES: Record<string, CommentStyle> = {};
for (const ext of [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".go",
  ".rs",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".swift",
  ".dart",
  ".php",
  ".zig",
  ".jsonc",
  ".proto",
  ".groovy",
  ".gradle",
])
  STYLES[ext] = C_LIKE;
for (const ext of [
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".rb",
  ".pl",
  ".r",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".cfg",
  ".ps1",
  ".mk",
  ".cmake",
  ".nix",
  ".ex",
  ".exs",
  ".jl",
  ".tf",
])
  STYLES[ext] = HASH;
STYLES[".py"] = PYTHON;
STYLES[".pyi"] = PYTHON;
for (const ext of [".lua", ".hs", ".elm"]) STYLES[ext] = DASH;
STYLES[".sql"] = SQL;
for (const ext of [".lisp", ".clj", ".cljs", ".el", ".scm", ".asm", ".s"]) STYLES[ext] = LISP;
for (const ext of [".html", ".htm", ".xml", ".svg", ".md", ".mdx", ".vue", ".svelte"])
  STYLES[ext] = MARKUP;
for (const ext of [".css", ".scss", ".less"]) STYLES[ext] = CSS;
// Vue and Svelte files hold scripts too; their `//` comments count as well.
STYLES[".vue"] = {
  line: ["//"],
  block: [
    ["<!--", "-->"],
    ["/*", "*/"],
  ],
  quotes: ['"', "'", "`"],
};
STYLES[".svelte"] = STYLES[".vue"];
STYLES[".scss"] = { ...CSS, line: ["//"] };
STYLES[".less"] = STYLES[".scss"];

const BASENAME_STYLES: Record<string, CommentStyle> = {
  dockerfile: HASH,
  makefile: HASH,
  ".gitignore": HASH,
  ".env": HASH,
};

function styleFor(path: string): CommentStyle | null {
  const base = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  return BASENAME_STYLES[base] ?? STYLES[extname(base)] ?? null;
}

interface CommentLine {
  line: number;
  text: string;
  /** The comment starts its line; only such comments join a group with their neighbours. */
  own: boolean;
}

/** Splits source text into comment lines, skipping string literals. */
export function commentLines(path: string, text: string): CommentLine[] | null {
  const style = styleFor(path);
  if (!style) return null;
  const out: CommentLine[] = [];
  let line = 1;
  let lineStart = 0;
  let i = 0;
  const n = text.length;
  const ownLine = (at: number): boolean => text.slice(lineStart, at).trim() === "";
  const push = (from: number, to: number, startLine: number, own: boolean): void => {
    const parts = text.slice(from, to).split("\n");
    parts.forEach((part, k) => {
      out.push({
        line: startLine + k,
        text: part.replace(/^\s*\*?\s?/, "").trimEnd(),
        own: k > 0 || own,
      });
    });
  };
  outer: while (i < n) {
    const ch = text[i] as string;
    if (ch === "\n") {
      line++;
      i++;
      lineStart = i;
      continue;
    }
    for (const opener of style.line) {
      if (text.startsWith(opener, i)) {
        const end = text.indexOf("\n", i);
        const stop = end === -1 ? n : end;
        out.push({ line, text: text.slice(i + opener.length, stop).trim(), own: ownLine(i) });
        i = stop;
        continue outer;
      }
    }
    for (const [open, close] of style.block) {
      if (text.startsWith(open, i)) {
        const end = text.indexOf(close, i + open.length);
        const stop = end === -1 ? n : end;
        push(i + open.length, stop, line, ownLine(i));
        for (let k = i; k < stop; k++)
          if (text[k] === "\n") {
            line++;
            lineStart = k + 1;
          }
        i = end === -1 ? n : end + close.length;
        continue outer;
      }
    }
    if (style.tripleQuotes && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const quote = text.slice(i, i + 3);
      const end = text.indexOf(quote, i + 3);
      const stop = end === -1 ? n : end + 3;
      for (let k = i; k < stop; k++)
        if (text[k] === "\n") {
          line++;
          lineStart = k + 1;
        }
      i = stop;
      continue;
    }
    if (style.quotes.includes(ch)) {
      let k = i + 1;
      while (k < n && text[k] !== ch) {
        if (text[k] === "\\") k++;
        // Only template literals span lines; an unclosed quote ends at the line.
        else if (text[k] === "\n") {
          if (ch !== "`") break;
          line++;
          lineStart = k + 1;
        }
        k++;
      }
      i = k < n && text[k] === ch ? k + 1 : k;
      continue;
    }
    i++;
  }
  return out;
}

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The marker kind of one comment line, or null when the marker is not at its start or end. */
export function markerIn(comment: string, marker = "baked"): MarkerKind | null {
  const word = escapeRegExp(marker);
  const start = new RegExp(`^${word}([!?])?(?=\\s|$|[:,.-])`, "i");
  const end = new RegExp(`(?:^|\\s)${word}([!?])?$`, "i");
  const trimmed = comment.trim();
  const m = start.exec(trimmed) ?? end.exec(trimmed);
  if (!m) return null;
  return m[1] === "!" ? "act" : m[1] === "?" ? "ask" : "context";
}

function stripMarker(comment: string, marker: string): string {
  const word = escapeRegExp(marker);
  return comment
    .trim()
    .replace(new RegExp(`^${word}[!?]?[:,.-]?\\s*`, "i"), "")
    .replace(new RegExp(`\\s*${word}[!?]?$`, "i"), "")
    .trim();
}

const RANK: Record<MarkerKind, number> = { context: 0, ask: 1, act: 2 };

/**
 * The markers of a file. Consecutive comment lines form one group; a group with a marker becomes
 * one Marker of its strongest kind (act over ask over context) with the whole group's text.
 */
export function parseMarkers(path: string, text: string, marker = "baked"): Marker[] {
  const comments =
    commentLines(path, text) ??
    text.split("\n").map((line, k) => ({ line: k + 1, text: line.trim(), own: true }));
  const out: Marker[] = [];
  let group: CommentLine[] = [];
  const flush = (): void => {
    let kind: MarkerKind | null = null;
    for (const c of group) {
      const k = markerIn(c.text, marker);
      if (k && (kind === null || RANK[k] > RANK[kind])) kind = k;
    }
    if (kind && group.length > 0) {
      const first = group[0] as CommentLine;
      const last = group[group.length - 1] as CommentLine;
      out.push({
        kind,
        line: first.line,
        endLine: last.line,
        text: group
          .map((c) => stripMarker(c.text, marker))
          .filter((t) => t.length > 0)
          .join("\n"),
      });
    }
    group = [];
  };
  const known = styleFor(path) !== null;
  for (const c of comments) {
    // Unknown languages: only lines with a marker form groups, since every line is "a comment".
    const belongs = known || markerIn(c.text, marker) !== null;
    const prev = group[group.length - 1];
    if (!belongs || !c.own || (prev && (c.line > prev.line + 1 || !prev.own))) flush();
    if (belongs) group.push(c);
  }
  flush();
  return out;
}
