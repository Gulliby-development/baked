import { extname } from "node:path";
import { type LanguageRecord, rowOf } from "../../intelligence/language-records.js";
import { detectLanguageFromPath } from "../../intelligence/types.js";

/** A string literal or comment the scanner is inside. */
interface Region {
  comment: boolean;
  /** Characters of the opener, shown for a string, blanked for a comment. */
  open: number;
  /** The closing delimiter; null ends the region at the end of the line. */
  close: string | null;
  /** `\` escapes the next character; `""` is an escaped quote (C# verbatim strings). */
  escape: "\\" | '""' | null;
  multiline: boolean;
  /** `${` opens code inside the string (JavaScript template literals). */
  interpolation?: boolean;
}

type Rule = (text: string, at: number) => Region | null;

const IDENTIFIER = /[\w$]/;

const lineComment =
  (token: string): Rule =>
  (text, at) =>
    text.startsWith(token, at)
      ? { comment: true, open: token.length, close: null, escape: null, multiline: false }
      : null;

const blockComment =
  (open: string, close: string): Rule =>
  (text, at) =>
    text.startsWith(open, at)
      ? { comment: true, open: open.length, close, escape: null, multiline: true }
      : null;

const quoted =
  (
    open: string,
    options: Partial<Pick<Region, "escape" | "multiline" | "interpolation">> & {
      close?: string;
      /** The opener must not continue an identifier (`r"`, `@"`). */
      prefixed?: boolean;
    } = {},
  ): Rule =>
  (text, at) =>
    text.startsWith(open, at) && !(options.prefixed && IDENTIFIER.test(text[at - 1] ?? ""))
      ? {
          comment: false,
          open: open.length,
          close: options.close ?? open.replace(/^[^"'`]*/, ""),
          escape: options.escape === undefined ? "\\" : options.escape,
          multiline: options.multiline ?? false,
          interpolation: options.interpolation,
        }
      : null;

/** A preprocessor directive (`#include`, `#if`, `#region`): only where it starts the line. */
const directive: Rule = (text, at) =>
  text[at] === "#" && /(?:^|\n)[ \t]*$/.test(text.slice(Math.max(0, at - 200), at))
    ? { comment: true, open: 1, close: null, escape: null, multiline: false }
    : null;

/** Rust raw strings: `r"…"`, `r#"…"#`, `br##"…"##`. */
const rustRaw: Rule = (text, at) => {
  const match = /^b?r(#*)"/.exec(text.slice(at, at + 260));
  if (!match || IDENTIFIER.test(text[at - 1] ?? "")) return null;
  return {
    comment: false,
    open: match[0].length,
    close: `"${match[1]}`,
    escape: null,
    multiline: true,
  };
};

/** A Rust character literal, not a lifetime (`'a`) or a label. */
const rustChar: Rule = (text, at) => {
  const match = /^'(?:\\(?:u\{[\da-fA-F]+\}|x[\da-fA-F]{2}|.)|[^\\'\n])'/u.exec(
    text.slice(at, at + 12),
  );
  return match ? { comment: false, open: 1, close: "'", escape: "\\", multiline: false } : null;
};

/** C++ raw strings: `R"delim(…)delim"`. */
const cppRaw: Rule = (text, at) => {
  const match = /^(?:u8|[uUL])?R"([^\s()\\]{0,16})\(/.exec(text.slice(at, at + 24));
  if (!match || IDENTIFIER.test(text[at - 1] ?? "")) return null;
  return {
    comment: false,
    open: match[0].length,
    close: `)${match[1]}"`,
    escape: null,
    multiline: true,
  };
};

/** Lua long brackets: `[[…]]`, `[==[…]==]`, and the comments `--[[…]]`. */
const luaLong =
  (comment: boolean): Rule =>
  (text, at) => {
    const match = (comment ? /^--\[(=*)\[/ : /^\[(=*)\[/).exec(text.slice(at, at + 64));
    return match
      ? { comment, open: match[0].length, close: `]${match[1]}]`, escape: null, multiline: true }
      : null;
  };

const C_STRINGS = [quoted('"'), quoted("'")];
const C_COMMENTS = [lineComment("//"), blockComment("/*", "*/")];
const TRIPLE = quoted('"""', { multiline: true });

const SYNTAX: Record<string, Rule[]> = {
  python: [lineComment("#"), TRIPLE, quoted("'''", { multiline: true }), ...C_STRINGS],
  javascript: [...C_COMMENTS, ...C_STRINGS, quoted("`", { multiline: true, interpolation: true })],
  // Java and Kotlin text blocks, Scala, Swift and Groovy multi-line strings.
  jvm: [...C_COMMENTS, TRIPLE, ...C_STRINGS],
  dart: [...C_COMMENTS, TRIPLE, quoted("'''", { multiline: true }), ...C_STRINGS],
  csharp: [
    directive,
    ...C_COMMENTS,
    quoted('"""', { escape: null, multiline: true }),
    quoted('$@"', { close: '"', escape: '""', multiline: true, prefixed: true }),
    quoted('@$"', { close: '"', escape: '""', multiline: true, prefixed: true }),
    quoted('@"', { close: '"', escape: '""', multiline: true, prefixed: true }),
    ...C_STRINGS,
  ],
  go: [...C_COMMENTS, quoted("`", { escape: null, multiline: true }), ...C_STRINGS],
  rust: [...C_COMMENTS, rustRaw, quoted('"', { multiline: true }), rustChar],
  c: [directive, ...C_COMMENTS, cppRaw, ...C_STRINGS],
  php: [
    ...C_COMMENTS,
    lineComment("#"),
    quoted('"', { multiline: true }),
    quoted("'", { multiline: true }),
  ],
  ruby: [lineComment("#"), quoted('"', { multiline: true }), quoted("'", { multiline: true })],
  lua: [luaLong(true), lineComment("--"), luaLong(false), ...C_STRINGS],
  // Elixir and shell: `#` comments, double- and single-quoted strings (#1846).
  hash: [
    lineComment("#"),
    TRIPLE,
    quoted('"', { multiline: true }),
    quoted("'", { multiline: true }),
  ],
  ocaml: [blockComment("(*", "*)"), quoted('"', { multiline: true })],
  // Zig, Solidity and ReScript: C comments and strings, ReScript's backtick templates.
  clike: [...C_COMMENTS, ...C_STRINGS, quoted("`", { multiline: true })],
  // Vue and Svelte components: HTML comments around a JavaScript or TypeScript script block.
  markup: [
    blockComment("<!--", "-->"),
    ...C_COMMENTS,
    ...C_STRINGS,
    quoted("`", { multiline: true, interpolation: true }),
  ],
  // An unknown language: the single-line rules the generator used before it knew languages.
  other: [lineComment("//"), lineComment("#"), ...C_STRINGS, quoted("`")],
};

/**
 * The comment and string syntax of every supported language (#1846): the case walk drops comments
 * by it, so a criterion's literal pasted into a comment is no evidence in any language.
 */
export const MASK_SYNTAX: LanguageRecord<keyof typeof SYNTAX> = {
  typescript: "javascript",
  javascript: "javascript",
  vue: "markup",
  svelte: "markup",
  python: "python",
  go: "go",
  rust: "rust",
  java: "jvm",
  kotlin: "jvm",
  scala: "jvm",
  swift: "jvm",
  csharp: "csharp",
  c: "c",
  cpp: "c",
  objc: "c",
  ruby: "ruby",
  php: "php",
  lua: "lua",
  elixir: "hash",
  bash: "hash",
  dart: "dart",
  zig: "clike",
  solidity: "clike",
  rescript: "clike",
  ocaml: "ocaml",
};

const LANGUAGE: Record<string, keyof typeof SYNTAX> = {
  ".py": "python",
  ".pyi": "python",
  ".pyw": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "javascript",
  ".tsx": "javascript",
  ".mts": "javascript",
  ".cts": "javascript",
  ".java": "jvm",
  ".kt": "jvm",
  ".kts": "jvm",
  ".scala": "jvm",
  ".sc": "jvm",
  ".groovy": "jvm",
  ".swift": "jvm",
  ".dart": "dart",
  ".cs": "csharp",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cc": "c",
  ".cpp": "c",
  ".cxx": "c",
  ".hh": "c",
  ".hpp": "c",
  ".hxx": "c",
  ".m": "c",
  ".mm": "c",
  ".php": "php",
  ".rb": "ruby",
  ".lua": "lua",
};

/**
 * The file with its string literal contents and comments replaced by spaces, newlines and
 * positions kept, so a line of the result shows only the code on that line (#1521). Strings and
 * comments that span lines are followed across them: Python docstrings, template literals, text
 * blocks, raw and verbatim strings, block comments. String delimiters stay visible.
 */
export function maskNonCode(path: string, text: string): string {
  return scan(path, text, true);
}

/** The file with only its comments replaced by spaces, newlines and positions kept (#1846). */
export function stripComments(path: string, text: string): string {
  return scan(path, text, false);
}

function syntaxOf(path: string): Rule[] {
  const key =
    rowOf(MASK_SYNTAX, detectLanguageFromPath(path)) ??
    LANGUAGE[extname(path).toLowerCase()] ??
    "other";
  return SYNTAX[key] ?? [];
}

function scan(path: string, text: string, strings: boolean): string {
  const rules = syntaxOf(path);
  const out = text.split("");
  // In comment-only mode a string's text stays; a comment is blanked either way.
  const blank = (from: number, to: number, comment = region?.comment === true) => {
    if (!strings && !comment) return;
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // Template literals whose `${…}` code is being scanned, with the brace depth to return at.
  const suspended: { region: Region; depth: number }[] = [];
  let region: Region | null = null;
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (!region) {
      if (suspended.length && c === "{") depth++;
      else if (suspended.length && c === "}") {
        if (depth === 0) {
          const resumed = suspended.pop();
          region = resumed?.region ?? null;
          depth = resumed?.depth ?? 0;
          i++;
          continue;
        }
        depth--;
      }
      let opened: Region | null = null;
      for (const rule of rules) {
        opened = rule(text, i);
        if (opened) break;
      }
      if (!opened) {
        i++;
        continue;
      }
      if (opened.comment) blank(i, i + opened.open, true);
      region = opened;
      i += opened.open;
      continue;
    }
    if (region.close === null) {
      if (c === "\n") region = null;
      else blank(i, i + 1);
      i++;
      continue;
    }
    if (region.escape === "\\" && c === "\\") {
      blank(i, i + 2);
      i += 2;
      continue;
    }
    if (region.escape === '""' && text.startsWith('""', i)) {
      blank(i, i + 2);
      i += 2;
      continue;
    }
    if (region.interpolation && text.startsWith("${", i)) {
      suspended.push({ region, depth });
      region = null;
      depth = 0;
      i += 2;
      continue;
    }
    if (text.startsWith(region.close, i)) {
      if (region.comment) blank(i, i + region.close.length);
      i += region.close.length;
      region = null;
      continue;
    }
    if (c === "\n" && !region.multiline) {
      region = null;
      i++;
      continue;
    }
    blank(i, i + 1);
    i++;
  }
  return out.join("");
}

/** Whether a masked line holds no code: it lies inside a string or a comment, or is blank. */
export function isNonCodeLine(masked: string | undefined): boolean {
  return !/[^\s"'`]/.test(masked ?? "");
}
