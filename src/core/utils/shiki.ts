import type { BundledLanguage, Highlighter, ThemedToken } from "shiki";

const RST = "\x1b[0m";

// Language alias normalization
const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  dockerfile: "docker",
  tf: "terraform",
  cs: "csharp",
  "c++": "cpp",
  "c#": "csharp",
  objc: "objective-c",
};

let _highlighter: Highlighter | null = null;
let _initPromise: Promise<Highlighter> | null = null;

/** Lazy-loaded shiki highlighter singleton. */
export async function getHighlighter(): Promise<Highlighter> {
  if (_highlighter) return _highlighter;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const { createHighlighter } = await import("shiki");
    _highlighter = await createHighlighter({
      themes: ["catppuccin-mocha"],
      langs: [
        "typescript",
        "javascript",
        "tsx",
        "jsx",
        "python",
        "rust",
        "go",
        "bash",
        "json",
        "yaml",
        "toml",
        "html",
        "css",
        "sql",
        "markdown",
        "ruby",
        "java",
        "kotlin",
        "swift",
        "c",
        "cpp",
        "csharp",
        "php",
        "lua",
        "zig",
        "elixir",
        "haskell",
        "ocaml",
        "scala",
        "dart",
        "dockerfile",
        "graphql",
        "terraform",
        "vim",
        "diff",
        "ini",
        "xml",
      ],
    });
    return _highlighter;
  })();
  return _initPromise;
}

function normalizeLang(lang: string): string {
  const lower = lang.toLowerCase().trim();
  return LANG_ALIASES[lower] ?? lower;
}

/** Check if shiki supports this language (from the pre-loaded set). */
export function isShikiLanguage(lang: string): boolean {
  if (!_highlighter) return false;
  try {
    const normalized = normalizeLang(lang);
    return _highlighter.getLoadedLanguages().includes(normalized);
  } catch {
    return false;
  }
}

/** Convert hex color (#RRGGBB) to 24-bit ANSI foreground escape. */
function hexToAnsi(hex: string): string {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${String(r)};${String(g)};${String(b)}m`;
}

/** Render code to ANSI-colored string for terminal output. */
export async function codeToAnsi(code: string, lang?: string): Promise<string> {
  const hl = await getHighlighter();
  const normalized = lang ? normalizeLang(lang) : "text";
  const langId = hl.getLoadedLanguages().includes(normalized)
    ? (normalized as BundledLanguage)
    : "text";

  let tokens: ThemedToken[][];
  try {
    const result = hl.codeToTokens(code, {
      lang: langId,
      theme: "catppuccin-mocha",
    });
    tokens = result.tokens;
  } catch {
    return code;
  }

  const lines: string[] = [];
  for (const line of tokens) {
    let lineStr = "";
    for (const token of line) {
      if (token.color) {
        lineStr += `${hexToAnsi(token.color)}${token.content}${RST}`;
      } else {
        lineStr += token.content;
      }
    }
    lines.push(lineStr);
  }
  return lines.join("\n");
}

/** Return themed tokens for TUI rendering. Each line is an array of {content, color} tokens. */
export async function codeToStyledTokens(
  code: string,
  lang?: string,
): Promise<Array<Array<{ content: string; color?: string }>>> {
  const hl = await getHighlighter();
  const normalized = lang ? normalizeLang(lang) : "text";
  const langId = hl.getLoadedLanguages().includes(normalized)
    ? (normalized as BundledLanguage)
    : "text";

  try {
    const result = hl.codeToTokens(code, {
      lang: langId,
      theme: "catppuccin-mocha",
    });
    return result.tokens.map((line) =>
      line.map((token) => ({
        content: token.content,
        color: token.color ?? undefined,
      })),
    );
  } catch {
    return code.split("\n").map((line) => [{ content: line }]);
  }
}
