import { isCodeFile } from "./language-traits.js";
import { detectLanguageFromPath, type Language } from "./types.js";

/** Languages whose line comments start with `#`; the rest of the code languages use `//`. */
const HASH: ReadonlySet<Language> = new Set(["python", "ruby", "bash", "elixir"]);
/** Languages whose line comments start with `--` (Lua also has `--[[ ... ]]` blocks). */
const DASH: ReadonlySet<Language> = new Set(["lua"]);
/** Languages with a `#` line comment besides their `//` and block comments. */
const ALSO_HASH: ReadonlySet<Language> = new Set(["php"]);

/**
 * The code of a source file with its comments and Python docstrings removed and blank lines and
 * trailing spaces dropped, so two versions that differ only in prose compare equal (#1517).
 * String literals are kept whole, so a `#` or `//` inside one is not a comment. Null for a file
 * that is not code. A construct the scanner misreads (a Rust lifetime read as a quote) keeps
 * more text, never less, so the result errs toward "the code changed".
 */
export function codeWithoutComments(path: string, text: string): string | null {
  if (!isCodeFile(path)) return null;
  const language = detectLanguageFromPath(path);
  const hash = HASH.has(language) || ALSO_HASH.has(language);
  const slash = !HASH.has(language) && !DASH.has(language);
  const dash = DASH.has(language);
  const python = language === "python";
  let out = "";
  let i = 0;
  const atStatementStart = (): boolean => {
    let k = out.length - 1;
    while (k >= 0 && (out[k] === " " || out[k] === "\t")) k--;
    return k < 0 || out[k] === "\n";
  };
  while (i < text.length) {
    const rest = text.slice(i, i + 4);
    const char = text[i] ?? "";
    if (python && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const quote = rest.slice(0, 3);
      const end = text.indexOf(quote, i + 3);
      const stop = end < 0 ? text.length : end + 3;
      // A triple-quoted string that starts a statement is a docstring; any other is a value.
      if (!atStatementStart()) out += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (char === '"' || char === "'" || (char === "`" && !python)) {
      let j = i + 1;
      while (j < text.length && text[j] !== char && !(text[j] === "\n" && char !== "`")) {
        j += text[j] === "\\" ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (dash && rest.startsWith("--[[")) {
      const end = text.indexOf("]]", i + 4);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    // A `#` is a comment only at a word boundary, so `$#` in a shell script stays code.
    const hashComment = hash && char === "#" && /^\s?$/.test(out.at(-1) ?? "");
    if ((dash && rest.startsWith("--")) || hashComment || (slash && rest.startsWith("//"))) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (slash && rest.startsWith("/*")) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    out += char;
    i++;
  }
  return out
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Whether two versions of a source file differ, and only in comments and docstrings (#1517). */
export function commentOnlyChange(path: string, before: string, after: string): boolean {
  if (before === after) return false;
  const a = codeWithoutComments(path, before);
  return a !== null && a === codeWithoutComments(path, after);
}
