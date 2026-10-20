import type { Language } from "./types.js";

/**
 * The programming languages BAKED supports (#1717): every language whose files are code. Code
 * that branches on language, extension, manifest or toolchain takes its data from a
 * `LanguageRecord`, so adding a language here makes the compiler ask for its row in every record,
 * and `tests/language-parity.test.ts` asks for its fixture.
 */
export const SUPPORTED_LANGUAGES = [
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "kotlin",
  "scala",
  "csharp",
  "c",
  "cpp",
  "ruby",
  "php",
  "swift",
  "lua",
  "elixir",
  "dart",
  "zig",
  "bash",
  "ocaml",
  "objc",
  "vue",
  "svelte",
  "rescript",
  "solidity",
] as const satisfies readonly Language[];

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** A row a language deliberately does not fill, with the reason. */
export interface NoRow {
  readonly none: string;
}

/** A row left empty on purpose: `none("Swift manifests are Swift code")`. */
export const none = (reason: string): NoRow => ({ none: reason });

export const isNoRow = (row: unknown): row is NoRow =>
  typeof row === "object" && row !== null && "none" in row;

/** Data for every supported language: a value, or `none(reason)` where it does not apply. */
export type LanguageRecord<T> = Readonly<Record<SupportedLanguage, T | NoRow>>;

export const isSupportedLanguage = (language: string): language is SupportedLanguage =>
  (SUPPORTED_LANGUAGES as readonly string[]).includes(language);

/** The row of a language, or null for a language outside the list or a `none` row. */
export function rowOf<T>(record: LanguageRecord<T>, language: string): T | null {
  if (!isSupportedLanguage(language)) return null;
  const row = record[language];
  return isNoRow(row) ? null : row;
}
