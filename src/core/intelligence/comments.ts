import { isCodeFile } from "./language-traits.js";
import { detectLanguageFromPath, type Language } from "./types.js";

/** Languages whose line comments start with `#`; the rest of the code languages use `//`. */
const HASH: ReadonlySet<Language> = new Set(["python", "ruby", "bash", "elixir"]);
/** Languages whose line comments start with `--` (Lua also has `--[[ ... ]]` blocks). */
const DASH: ReadonlySet<Language> = new Set(["lua"]);
/** Languages with a `#` line comment besides their `//` and block comments. */
const ALSO_HASH: ReadonlySet<Language> = new Set(["php"]);

type SegmentKind = "code" | "comment" | "string" | "docstring";

interface Segment {
  kind: SegmentKind;
  text: string;
}

/** A Rust character literal at the start of the text: `'a'`, `'\n'`, `'\u{1F600}'`. */
const RUST_CHAR = /^'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/;
/** A Rust raw string at the start of the text: `r"..."`, `r#"..."#`, `br##"..."##`. */
const RUST_RAW = /^b?r(#*)"/;

/**
 * A source file cut into code, comments and string literals, in order, so that the pieces joined
 * give the text back. String literals are read whole, so a `#` or `//` inside one is not a
 * comment, and a comment is read whole, so an apostrophe in it opens no string. A construct the
 * scanner misreads keeps the rest of the line as a string or as code, never drops it. A Python
 * triple-quoted string that starts a statement is a docstring.
 */
function segments(language: Language, text: string): Segment[] {
  const hash = HASH.has(language) || ALSO_HASH.has(language);
  const slash = !HASH.has(language) && !DASH.has(language);
  const dash = DASH.has(language);
  const python = language === "python";
  const rust = language === "rust";
  const csharp = language === "csharp";
  const out: Segment[] = [];
  // The code and strings so far, without comments and docstrings.
  let kept = "";
  const push = (kind: SegmentKind, piece: string) => {
    const last = out.at(-1);
    if (kind === "code" && last?.kind === "code") last.text += piece;
    else out.push({ kind, text: piece });
    if (kind === "code" || kind === "string") kept += piece;
  };
  const atStatementStart = (): boolean => /(?:^|\n)[ \t]*$/.test(kept.slice(-200));
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i, i + 4);
    const char = text[i] ?? "";
    if (python && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const quote = rest.slice(0, 3);
      const end = text.indexOf(quote, i + 3);
      const stop = end < 0 ? text.length : end + 3;
      push(atStatementStart() ? "docstring" : "string", text.slice(i, stop));
      i = stop;
      continue;
    }
    if (rust) {
      const raw = RUST_RAW.exec(text.slice(i, i + 260));
      if (raw && !/\w/.test(kept.at(-1) ?? "")) {
        const close = `"${raw[1]}`;
        const end = text.indexOf(close, i + raw[0].length);
        const stop = end < 0 ? text.length : end + close.length;
        push("string", text.slice(i, stop));
        i = stop;
        continue;
      }
      if (char === "'") {
        // A lifetime (`'a`, `'static`) is code; only a character literal is a string.
        const literal = RUST_CHAR.exec(text.slice(i, i + 16));
        push(literal ? "string" : "code", literal ? literal[0] : char);
        i += literal ? literal[0].length : 1;
        continue;
      }
    }
    if (csharp && rest.startsWith('@"')) {
      // A verbatim string: no escapes, and a doubled quote stands for one.
      let j = i + 2;
      while (j < text.length && !(text[j] === '"' && text[j + 1] !== '"'))
        j += text[j] === '"' ? 2 : 1;
      push("string", text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (char === '"' || char === "'" || (char === "`" && !python)) {
      let j = i + 1;
      while (j < text.length && text[j] !== char && !(text[j] === "\n" && char !== "`")) {
        j += text[j] === "\\" ? 2 : 1;
      }
      push("string", text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (dash && rest.startsWith("--[[")) {
      const end = text.indexOf("]]", i + 4);
      const stop = end < 0 ? text.length : end + 2;
      push("comment", text.slice(i, stop));
      i = stop;
      continue;
    }
    // A `#` is a comment only at a word boundary, so `$#` in a shell script stays code.
    const hashComment = hash && char === "#" && /^\s?$/.test(kept.at(-1) ?? "");
    if ((dash && rest.startsWith("--")) || hashComment || (slash && rest.startsWith("//"))) {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      push("comment", text.slice(i, stop));
      i = stop;
      continue;
    }
    if (slash && rest.startsWith("/*")) {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      push("comment", text.slice(i, stop));
      i = stop;
      continue;
    }
    push("code", char);
    i++;
  }
  return out;
}

/**
 * The code of a source file with its comments and Python docstrings removed and blank lines and
 * trailing spaces dropped, so two versions that differ only in prose compare equal (#1517).
 * String literals are kept whole. Null for a file that is not code. A construct the scanner
 * misreads keeps more text, never less, so the result errs toward "the code changed".
 */
export function codeWithoutComments(path: string, text: string): string | null {
  if (!isCodeFile(path)) return null;
  return segments(detectLanguageFromPath(path), text)
    .filter((s) => s.kind === "code" || s.kind === "string")
    .map((s) => s.text)
    .join("")
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

/** String content that may stay: a short word such as `"test"` or `'pytest'`. */
const KEPT_CONTENT = /^\w{1,16}$/;
const OPENING = /^(?:b?r#*|@)?(?:"""|'''|["'`])/;
const CLOSING = /(?:"""|'''|["'`])#*$/;

/** A call whose first string argument names a test: `it("...")`, `test.each(...)("...")`. */
const TITLE_CALL = /(?:^|[^.\w$])(?:it|test|describe|suite|context)(?:\.\w+)*\s*\(\s*$/;

/**
 * A source file with the content of its string literals and docstrings blanked to spaces, and
 * its quotes, comments, code and line breaks kept in place (#1549), so a pattern for code or for
 * a comment no longer matches test data such as `"custom_value: any text"` or `"# noqa"`. A short
 * word stays (`process.env.NODE_ENV === "test"`), since some patterns compare with one, and with
 * `titles` so does a test's title (`it("parses a list", ...)`). A file that is not code is
 * returned as it is.
 */
export function blankStringLiterals(
  path: string,
  text: string,
  options: { titles?: boolean } = {},
): string {
  if (!isCodeFile(path)) return text;
  let tail = "";
  return segments(detectLanguageFromPath(path), text)
    .map(({ kind, text: piece }) => {
      if (kind === "code") tail = (tail + piece).slice(-80);
      if (kind !== "string" && kind !== "docstring") return piece;
      const title = options.titles === true && TITLE_CALL.test(tail);
      tail = "";
      const open = OPENING.exec(piece)?.[0] ?? "";
      const body = piece.slice(open.length);
      const close = body.length ? (CLOSING.exec(body)?.[0] ?? "") : "";
      const content = body.slice(0, body.length - close.length);
      return title || KEPT_CONTENT.test(content)
        ? piece
        : open + content.replace(/[^\r\n]/g, " ") + close;
    })
    .join("");
}
