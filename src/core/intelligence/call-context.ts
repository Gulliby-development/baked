import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { TreeSitterBackend } from "./backends/tree-sitter.js";
import { computeMinHash, jaccardSimilarity, tokenize } from "./clone-detection.js";
import { type LanguageRecord, rowOf } from "./language-records.js";
import { detectLanguageFromPath } from "./types.js";

/**
 * How a language calls a function and imports a file, for the call-graph context of a review
 * (#1845): the adversarial reviewer gets the callers, callees, importers and similar functions of
 * every function a pull request changes, so the sibling sweep starts from the code that reaches
 * the change instead of the diff alone. Definitions come from tree-sitter; this record holds what
 * a definition query does not give: the call and import spellings of each language.
 */
export interface CallSyntax {
  /** A regex source matching a call of `name` (already escaped) on one line. */
  call: (name: string) => string;
  /**
   * A regex source matching a line that imports the file whose stem (`sum` of `src/sum.ts`) and
   * module name (`Sum`) are given, or null when the language imports by package, not by file.
   */
  imports: ((stem: string, module: string) => string) | null;
  /** Symbol names the grammar's query reports that are syntax, not functions (Elixir `def`). */
  skip?: readonly string[];
  /** The functions live in the file's `<script>` block, parsed as TypeScript. */
  script?: boolean;
  /** Languages of one family call each other's functions (a `.vue` file calls a `.ts` module). */
  family?: string;
}

/** A call: the name followed by an argument list, also as a method or qualified call. */
const parens = (name: string) => `(?<![\\w$])${name}\\s*\\(`;
const jsImports = (stem: string) =>
  `(?:from\\s+|import\\s*\\(?\\s*|require\\s*\\(\\s*)["'][^"']*\\b${stem}(?:\\.[\\w]+)?["']`;

export const CALL_SYNTAX: LanguageRecord<CallSyntax> = {
  typescript: { call: parens, imports: jsImports, family: "js" },
  javascript: { call: parens, imports: jsImports, family: "js" },
  vue: { call: parens, imports: jsImports, script: true, family: "js" },
  svelte: { call: parens, imports: jsImports, script: true, family: "js" },
  python: {
    call: parens,
    imports: (stem) => `^\\s*(?:from\\s+[\\w.]*\\b${stem}\\b|import\\s+[\\w.]*\\b${stem}\\b)`,
  },
  go: { call: parens, imports: null },
  rust: { call: parens, imports: (stem) => `\\b(?:use\\s+[\\w:]*\\b${stem}\\b|mod\\s+${stem}\\b)` },
  java: {
    call: parens,
    imports: (_, module) => `^\\s*import\\s+(?:static\\s+)?[\\w.]*\\b${module}\\b`,
  },
  kotlin: { call: parens, imports: (_, module) => `^\\s*import\\s+[\\w.]*\\b${module}\\b` },
  scala: { call: parens, imports: (_, module) => `^\\s*import\\s+[\\w.]*\\b${module}\\b` },
  csharp: { call: parens, imports: null },
  c: { call: parens, imports: (stem) => `#\\s*include\\s*["<][^">]*\\b${stem}\\.h[">]` },
  cpp: {
    call: parens,
    imports: (stem) => `#\\s*include\\s*["<][^">]*\\b${stem}\\.(?:h|hpp|hh)[">]`,
  },
  objc: {
    call: parens,
    imports: (stem) => `#\\s*(?:import|include)\\s*["<][^">]*\\b${stem}\\.h[">]`,
  },
  ruby: {
    // Ruby calls without parentheses too: `sum 1, 2`, `Sum.sum(1, 2)`.
    call: (name) => `(?<![\\w$:@/"'])${name}\\b(?!\\s*=[^=>~])`,
    imports: (stem) => `\\brequire(?:_relative)?\\s*\\(?\\s*["'][^"']*\\b${stem}["']`,
  },
  php: {
    call: parens,
    imports: (stem, module) =>
      `\\b(?:require|include)(?:_once)?\\b.*\\b${stem}\\.php|^\\s*use\\s+[\\w\\\\]*\\b${module}\\b`,
  },
  swift: { call: parens, imports: null },
  lua: { call: parens, imports: (stem) => `\\brequire\\s*\\(?\\s*["'][^"']*\\b${stem}["']` },
  elixir: {
    call: (name) => `(?:\\.|(?<![\\w:]))${name}\\b[!?]?\\s*[(\\s]`,
    imports: (_, module) => `\\b(?:alias|import|use|require)\\s+[\\w.]*\\b${module}\\b`,
    skip: [
      "defmodule",
      "def",
      "defp",
      "defmacro",
      "defmacrop",
      "raise",
      "use",
      "import",
      "alias",
      "require",
    ],
  },
  dart: { call: parens, imports: (stem) => `\\bimport\\s+["'][^"']*\\b${stem}\\.dart["']` },
  zig: { call: parens, imports: (stem) => `@import\\s*\\(\\s*"[^"]*\\b${stem}\\.zig"\\s*\\)` },
  bash: {
    // A shell function is called like a command: at the start of a command, without parentheses.
    call: (name) =>
      `(?:^|[;&|(\`{]|\\$\\(|\\bthen|\\bdo|\\belse)\\s*${name}(?=\\s|$|;|\\))(?!\\s*\\(\\))`,
    imports: (stem) => `(?:^|\\s)(?:source|\\.)\\s+\\S*\\b${stem}\\.(?:sh|bash)\\b`,
  },
  ocaml: {
    call: (name) => `(?<![\\w'])${name}\\b(?!\\s*=)(?!')`,
    imports: (_, module) => `\\b(?:open|include)\\s+${module}\\b|\\b${module}\\.`,
  },
  rescript: { call: parens, imports: (_, module) => `\\bopen\\s+${module}\\b|\\b${module}\\.` },
  solidity: { call: parens, imports: (stem) => `\\bimport\\b.*["'][^"']*\\b${stem}\\.sol["']` },
  sql: {
    call: parens,
    // psql's `\i` and `\ir` include a file; SQL itself has no import.
    imports: (stem) => `^\\s*\\\\i(?:r|nclude(?:_relative)?)?\\s+\\S*\\b${stem}\\.sql\\b`,
  },
};

/** A function of a file: its name and 1-based lines. */
export interface FunctionSpan {
  file: string;
  name: string;
  start: number;
  end: number;
  body: string;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The `<script>` block of a Vue or Svelte file, with the lines before it blanked so line numbers hold. */
function scriptBlock(text: string): string {
  const match = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(text);
  if (!match || match.index === undefined) return "";
  const before = text.slice(0, match.index + match[0].indexOf(">") + 1);
  return "\n".repeat(before.split("\n").length - 1) + (match[1] ?? "");
}

/**
 * The functions and methods tree-sitter finds in the files, with their bodies. A symbol that
 * starts on the same line as a longer one (Elixir's `def` around `sum`) takes the longer span.
 */
export async function functionsIn(
  backend: TreeSitterBackend,
  files: readonly { path: string; text: string }[],
): Promise<FunctionSpan[]> {
  await backend.initialize("");
  const scratch = mkdtempSync(join(tmpdir(), "baked-call-context-"));
  try {
    const spans: FunctionSpan[] = [];
    for (const [index, { path, text }] of files.entries()) {
      const syntax = rowOf(CALL_SYNTAX, detectLanguageFromPath(path));
      if (!syntax) continue;
      const source = syntax.script ? scriptBlock(text) : text;
      const copy = join(
        scratch,
        String(index),
        syntax.script ? `${basename(path)}.ts` : basename(path),
      );
      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, source);
      const symbols = (await backend.findSymbols(copy)) ?? [];
      const lines = source.split("\n");
      const ends = new Map<number, number>();
      for (const s of symbols)
        ends.set(
          s.location.line,
          Math.max(ends.get(s.location.line) ?? 0, s.location.endLine ?? s.location.line),
        );
      const seen = new Set<string>();
      for (const s of symbols) {
        if (s.kind !== "function" && s.kind !== "method") continue;
        if (syntax.skip?.includes(s.name) || !/^[A-Za-z_][\w]*[!?]?$/.test(s.name)) continue;
        const start = s.location.line;
        const end = Math.max(ends.get(start) ?? start, s.location.endLine ?? start);
        const key = `${s.name}:${start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        spans.push({
          file: path,
          name: s.name,
          start,
          end,
          body: lines.slice(start - 1, end).join("\n"),
        });
      }
    }
    return spans;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A place in the repository: a file and a line, with the function it is in when known. */
export interface Place {
  file: string;
  line: number;
  in?: string;
}

export interface FunctionContext {
  fn: FunctionSpan;
  callers: Place[];
  callees: string[];
  importers: string[];
  similar: { fn: FunctionSpan; similarity: number }[];
}

const LIMIT = 15;
const SIMILAR = 0.5;

const enclosing = (spans: FunctionSpan[], file: string, line: number) =>
  spans
    .filter((s) => s.file === file && s.start <= line && line <= s.end)
    .sort((a, b) => a.end - a.start - (b.end - b.start))[0];

/**
 * The call-graph context of the changed functions over the repository's files: who calls each one
 * (by the language's call spelling, its own definition aside), what it calls among the repository's
 * functions, which files import its file, and the functions most like it by name or body.
 */
export function callContext(
  changed: readonly FunctionSpan[],
  all: readonly FunctionSpan[],
  files: readonly { path: string; text: string }[],
): FunctionContext[] {
  const spans = [...all];
  const defined = new Set(spans.map((s) => s.name));
  const hashes = new Map(spans.map((s) => [s, computeMinHash(tokenize(s.body))]));
  return changed.map((fn) => {
    const language = detectLanguageFromPath(fn.file);
    const syntax = rowOf(CALL_SYNTAX, language);
    const callers: Place[] = [];
    const importers: string[] = [];
    if (syntax) {
      const call = new RegExp(syntax.call(escapeRegex(fn.name)));
      const stem = basename(fn.file, extname(fn.file));
      const module = stem.charAt(0).toUpperCase() + stem.slice(1);
      const imports = syntax.imports
        ? new RegExp(syntax.imports(escapeRegex(stem), escapeRegex(module)), "m")
        : null;
      const family = (path: string) => {
        const other = rowOf(CALL_SYNTAX, detectLanguageFromPath(path));
        return other === syntax || (!!other?.family && other.family === syntax.family);
      };
      const importLine = imports ? new RegExp(imports.source) : null;
      for (const { path, text } of files) {
        if (!family(path)) continue;
        if (imports && path !== fn.file && imports.test(text)) importers.push(path);
        for (const [i, line] of text.split("\n").entries()) {
          const number = i + 1;
          if (!call.test(line) || importLine?.test(line)) continue;
          // A definition of that name is not a call of it.
          if (spans.some((s) => s.file === path && s.name === fn.name && s.start === number))
            continue;
          const inside = enclosing(spans, path, number);
          if (path === fn.file && inside?.name === fn.name && inside.start === fn.start) continue;
          callers.push({ file: path, line: number, ...(inside ? { in: inside.name } : {}) });
        }
      }
    }
    const callees = [
      ...new Set(
        [
          ...fn.body
            .split("\n")
            .slice(1)
            .join("\n")
            .matchAll(/([A-Za-z_]\w*)\s*\(/g),
        ].map((m) => m[1] ?? ""),
      ),
    ]
      .filter((name) => name !== fn.name && defined.has(name))
      .slice(0, LIMIT);
    const own = hashes.get(fn) ?? computeMinHash(tokenize(fn.body));
    const similar = spans
      .filter(
        (s) =>
          !(s.file === fn.file && s.start === fn.start) &&
          (detectLanguageFromPath(s.file) === language ||
            (!!syntax?.family &&
              rowOf(CALL_SYNTAX, detectLanguageFromPath(s.file))?.family === syntax.family)),
      )
      .map((s) => {
        const other = hashes.get(s);
        const body = own && other ? jaccardSimilarity(own, other) : 0;
        return { fn: s, similarity: s.name === fn.name ? Math.max(body, 1) : body };
      })
      .filter((s) => s.similarity >= SIMILAR)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, LIMIT);
    return {
      fn,
      callers: callers.slice(0, LIMIT),
      callees,
      importers: importers.slice(0, LIMIT),
      similar,
    };
  });
}

/** The functions whose lines a change touches, by the changed lines of each file. */
export function changedFunctions(
  spans: readonly FunctionSpan[],
  lines: ReadonlyMap<string, readonly number[]>,
): FunctionSpan[] {
  return spans.filter((s) =>
    (lines.get(s.file) ?? []).some((line) => s.start <= line && line <= s.end),
  );
}

/**
 * The changed lines of each file on the new side of a unified diff. Inside a hunk (by its `@@`
 * counts) a removed `---` line or an added `+++` line is content, not a file header: a README
 * hunk that drops a `---` rule or front matter counts that line (#2018). A `--- ` line followed
 * by `+++ ` starts the next file even where a hand-written hunk's counts run long.
 */
export function changedLines(diff: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const texts = diff.split("\n");
  let file: string | null = null;
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] as string;
    const inHunk = oldLeft > 0 || newLeft > 0;
    const pairs = (at: number) =>
      texts[at]?.startsWith("--- ") === true && texts[at + 1]?.startsWith("+++ ") === true;
    if (pairs(i)) continue;
    const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(text);
    if (header && (!inHunk || pairs(i - 1))) {
      file = header[1] === "/dev/null" ? null : (header[1] ?? null);
      oldLeft = 0;
      newLeft = 0;
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[2]);
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[3] ?? 1);
      continue;
    }
    if (!file || (!inHunk && text.startsWith("---"))) continue;
    if (text.startsWith("+")) {
      out.set(file, [...(out.get(file) ?? []), line]);
      line++;
      newLeft = Math.max(0, newLeft - 1);
    } else if (text.startsWith("-")) {
      // A removed line sits between the new lines around it: count the line after it as touched.
      out.set(file, [...(out.get(file) ?? []), line]);
      oldLeft = Math.max(0, oldLeft - 1);
    } else if (!text.startsWith("\\")) {
      line++;
      oldLeft = Math.max(0, oldLeft - 1);
      newLeft = Math.max(0, newLeft - 1);
    }
  }
  return out;
}

/** One file's part of a unified diff, as `git apply -p1` reads it. */
export interface DiffSection {
  /** The new path, or the old one when the section deletes the file. */
  path: string;
  /** The section with `--- a/<old>` and `+++ b/<new>` headers (or `/dev/null`) and its hunks. */
  patch: string;
  deletes: boolean;
}

/**
 * Each file's section of a unified diff, split where `changedLines` starts a new file (a `--- `
 * line followed by `+++ `). Headers are rewritten to the `a/` and `b/` form, so a brief that writes
 * `--- src/x.ts` applies with `-p1` like one that writes `--- a/src/x.ts`; a diff timestamp after a
 * tab is dropped. Lines between hunks that are not hunk content (`diff --git`, `index`, prose) are
 * left out, and an empty line inside a hunk is an empty context line, as a markdown editor leaves
 * it. Hunk counts are kept as written: apply with `--recount` when a person wrote them.
 */
export function diffSections(diff: string): DiffSection[] {
  const texts = diff.split("\n");
  const strip = (header: string, prefix: "a" | "b"): string => {
    const path = (header.slice(4).split("\t")[0] ?? "").trim();
    return path === "/dev/null" || !path.startsWith(`${prefix}/`) ? path : path.slice(2);
  };
  const sections: { from: string; to: string; lines: string[] }[] = [];
  let current: { from: string; to: string; lines: string[] } | null = null;
  let hunks = false;
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] as string;
    if (text.startsWith("--- ") && texts[i + 1]?.startsWith("+++ ")) {
      current = { from: strip(text, "a"), to: strip(texts[i + 1] as string, "b"), lines: [] };
      sections.push(current);
      hunks = false;
      i++;
      continue;
    }
    if (!current) continue;
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(text)) {
      hunks = true;
      current.lines.push(text);
      continue;
    }
    if (!hunks) continue;
    if (text === "") current.lines.push(" ");
    else if (/^[ +\-\\]/.test(text)) current.lines.push(text);
    else hunks = false;
  }
  return sections.flatMap(({ from, to, lines }): DiffSection[] => {
    const deletes = to === "/dev/null";
    const path = deletes ? from : to;
    // Blank lines after the last hunk are the fence's layout, not context the file must have.
    while (lines.at(-1) === " ") lines.pop();
    if (!lines.length || path === "/dev/null") return [];
    const head = [
      `--- ${from === "/dev/null" ? from : `a/${from}`}`,
      `+++ ${deletes ? to : `b/${to}`}`,
    ];
    return [{ path, patch: `${[...head, ...lines].join("\n")}\n`, deletes }];
  });
}

/** The context as the reviewer reads it. */
export function renderCallContext(contexts: readonly FunctionContext[]): string {
  const place = (p: Place) => `\`${p.file}:${p.line}\`${p.in ? ` in \`${p.in}\`` : ""}`;
  return contexts
    .map(({ fn, callers, callees, importers, similar }) =>
      [
        `## \`${fn.name}\` in \`${fn.file}\` (lines ${fn.start}-${fn.end})`,
        `- Callers: ${callers.length ? callers.map(place).join(", ") : "none found"}`,
        `- Callees: ${callees.length ? callees.map((c) => `\`${c}\``).join(", ") : "none in the repository"}`,
        `- Importers of its file: ${importers.length ? importers.map((f) => `\`${f}\``).join(", ") : "none found"}`,
        `- Similar functions: ${
          similar.length
            ? similar
                .map(
                  (s) =>
                    `\`${s.fn.name}\` in \`${s.fn.file}:${s.fn.start}\` (${s.similarity.toFixed(2)})`,
                )
                .join(", ")
            : "none found"
        }`,
      ].join("\n"),
    )
    .join("\n\n");
}
