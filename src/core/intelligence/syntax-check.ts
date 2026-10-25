import { extname } from "node:path";
import { type ParseError, TreeSitterBackend } from "./backends/tree-sitter.js";

export type { ParseError } from "./backends/tree-sitter.js";

/**
 * The grammars the syntax check trusts, by file extension. Each was checked against idiomatic
 * current code of its language; a grammar that lags its language (Kotlin, Swift) would refuse
 * valid files, so a language outside this list passes unchecked. Ruby stays out (#1493): the
 * bundled tree-sitter-ruby reported errors in 5 of 2,618 valid files of the RuboCop, RSpec and
 * parser gems (`$:` globals, `self(` calls, a leading magic comment). Dart stays out (#1494): the
 * bundled tree-sitter-dart reported errors in 92 of 444 valid files of the args, async, collection,
 * path, matcher, test, shelf, glob, crypto and io packages (`library;` without a name, Dart 3
 * patterns). Lua stays out (#1495): the bundled tree-sitter-lua reported errors in 374 of 1,133
 * files of busted, luassert, penlight and luacheck that `luac -p` accepts (a call without
 * parentheses, `local f = function`).
 */
const CHECKED_GRAMMARS: Record<string, string> = {
  ".rs": "rust",
  ".go": "go",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".cs": "csharp",
  ".java": "java",
  // Not `.sql`: one grammar covers many dialects (T-SQL, PL/pgSQL bodies, MySQL delimiters) and
  // refuses valid statements of each, so SQL is checked by the project's SQLFluff gate (#1499).
  // Not `.ps1`/`.psm1`: the tree-sitter grammar reported errors in 27 of 98 scripts of the
  // Chocolatey, Pester and psake packages that PowerShell's own parser reads without one; the
  // PSScriptAnalyzer gate reports parse errors instead (#1498).
};

const MAX_ERRORS = 5;

let backend: TreeSitterBackend | null = null;

/** Whether the syntax check parses files with this path's extension. */
export function syntaxCheckable(path: string): boolean {
  return extname(path).toLowerCase() in CHECKED_GRAMMARS;
}

/**
 * The syntax errors tree-sitter finds in `content` (ERROR and MISSING nodes), at most five. Empty
 * when the file parses, and also when its language has no checked grammar or the grammar cannot
 * be loaded: a file the check cannot read passes.
 */
export async function syntaxErrors(path: string, content: string): Promise<ParseError[]> {
  const grammar = CHECKED_GRAMMARS[extname(path).toLowerCase()];
  if (!grammar) return [];
  try {
    backend ??= new TreeSitterBackend();
    return (await backend.parseErrors(grammar, content, MAX_ERRORS)) ?? [];
  } catch {
    return [];
  }
}

/** `path:line:column: message` for each error. */
export function formatSyntaxErrors(path: string, errors: readonly ParseError[]): string[] {
  return errors.map((e) => `${path}:${String(e.line)}:${String(e.column)}: ${e.message}`);
}
