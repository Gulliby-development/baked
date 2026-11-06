import {
  isSupportedLanguage,
  type LanguageRecord,
  none,
  rowOf,
  type SupportedLanguage,
} from "../../intelligence/language-records.js";
import { detectLanguageFromPath } from "../../intelligence/types.js";

/**
 * Per-language pitfalls (#2598): one table read by the language reviewer and the implementer. R84
 * wrapsmith (PowerShell): every handler task wrote `[Parameter(Mandatory)] [int[]] $Positional`
 * without `[AllowEmptyCollection()]` and failed Pester on the same `ParameterBindingValidation
 * Exception`, 25 checks across three features, because the pitfalls lived only in the language
 * reviewer's prompt, which runs after the work.
 *
 * `review` is the language's clause in the language reviewer's instructions, which
 * `reviewPitfallClauses` joins in `REVIEW_CLAUSE_ORDER`; a language whose pitfalls the reviewer
 * words together with other languages' (ignored errors, culture formatting) has none. `implement`
 * is the implementer's short note, taken from the reviewer's text (`tests/language-pitfalls.test.ts`
 * fails on a code span the reviewer does not hold, and on a note past `PITFALL_NOTE_MAX`). A
 * language the reviewer holds no pitfalls for is `none(reason)`. A new supported language adds its
 * row; a new reviewer pitfall goes into its language's row, both fields.
 */
export interface LanguagePitfalls {
  /** The language's clause in the language reviewer's instructions; absent when worded with others. */
  readonly review?: string;
  /** The implementer's note: one short line, from the reviewer's text. */
  readonly implement: string;
}

/** The longest implementer note: the note goes into every implementer step's prompt (#2598). */
export const PITFALL_NOTE_MAX = 400;

const NO_REVIEW = (language: string) =>
  none(
    `the language reviewer holds no ${language} pitfalls: its review runs for the languages detectLanguages finds`,
  );

const C_FAMILY: LanguagePitfalls = {
  review:
    "C and C++: undefined behavior (signed overflow, out-of-bounds reads and writes, use after free, uninitialized reads, shifts past the width), buffer sizes from strlen without the terminator, sprintf and strcpy instead of snprintf and bounded copies, unchecked malloc, fopen and strtol results, char signedness and sizeof(long) that differ between platforms and compilers (long is 32-bit on 64-bit Windows), text-mode fopen and printf of \\n that become CRLF on Windows, owning raw pointers and new or delete where RAII and smart pointers apply, std::unordered_map order assumed where the spec orders",
  implement:
    "C and C++: no undefined behavior (signed overflow, out-of-bounds access, uninitialized reads); size buffers for the terminator; snprintf and bounded copies, not sprintf and strcpy; check malloc, fopen and strtol results; text-mode output becomes CRLF on Windows; std::unordered_map has no order.",
};

export const LANGUAGE_PITFALLS: LanguageRecord<LanguagePitfalls> = {
  typescript: NO_REVIEW("TypeScript"),
  javascript: NO_REVIEW("JavaScript"),
  python: NO_REVIEW("Python"),
  go: {
    implement:
      "Go: never discard an error and never defer in a loop; close the files and stop the goroutines you open; sort map keys where the spec orders; keep gofmt and go vet clean.",
  },
  rust: {
    implement:
      "Rust: no unwrap or expect on input-dependent values and no panics on user input; check overflow and conversions on user-supplied numbers; keep cargo fmt and clippy clean.",
  },
  java: {
    implement:
      "Java: pass Locale.ROOT to formatting and parsing; never swallow exceptions; release resources with try-with-resources; check overflow on user-supplied numbers.",
  },
  kotlin: {
    implement:
      "Kotlin: no `!!` or unchecked `as` casts on input-dependent values; `runCatching` and `catch (e: Exception)` also swallow `CancellationException` in coroutines; give `String.format` and `.format(x)` Locale.ROOT; Java platform types may be null.",
  },
  scala: {
    implement:
      "Scala: no `.get` on an Option or Try and no `.head` on a collection that may be empty; catch with `NonFatal`, not Throwable; give the `f` interpolator and `.format` a locale; `Set` and `Map` iterate in no fixed order; `toInt` throws where `toIntOption` does not.",
  },
  csharp: {
    implement:
      "C# and .NET: pass CultureInfo.InvariantCulture to formatting and parsing; Environment.NewLine and Console.WriteLine end lines with CRLF on Windows where the spec fixes the bytes; never swallow exceptions; release resources with using or Dispose.",
  },
  c: C_FAMILY,
  cpp: C_FAMILY,
  ruby: {
    implement:
      "Ruby: rescue specific errors, not a bare `rescue` or `rescue nil`; use `fetch` where a missing key is an error; read and write files with an explicit UTF-8 encoding or binary mode where the spec fixes the bytes; frozen string literals raise on `<<`.",
  },
  php: {
    review:
      "PHP: loose comparisons (== on strings and numbers, in_array or array_search without strict), a file without declare(strict_types=1) where the project uses it, byte functions (strlen, substr, strtoupper) on multibyte text instead of mb_*, PHP_EOL where the spec fixes a \\n line ending, json_encode or json_decode without JSON_THROW_ON_ERROR, errors silenced with @, integers past PHP_INT_MAX turning into floats",
    implement:
      "PHP: strict comparisons (=== and in_array with strict); mb_* functions on multibyte text; \\n, not PHP_EOL, where the spec fixes the line ending; JSON_THROW_ON_ERROR on json_encode and json_decode; never silence errors with @.",
  },
  swift: {
    implement:
      "Swift: no `!`, `try!` or `as!` on input-dependent values; `try?` drops an error the spec reports; give `String(format:)` an en_US_POSIX `Locale`; Int arithmetic traps on overflow; Dictionary and Set have no order; Linux needs FoundationNetworking for `URLSession`.",
  },
  lua: {
    review:
      "Lua: off-by-one errors from one-based indexing and string.sub bounds, # on a table with nil holes, a variable assigned without local that becomes a global, string patterns treated as regular expressions (magic characters need %, or string.find with plain set to true), integer and float output that differs between Lua 5.1 and 5.3 or later (3 / 2 is 1.5, 4 / 2 prints 2.0, use // or math.tointeger), print separating values with tabs where the spec fixes the bytes (use io.write), pairs order assumed where the spec orders (sort the keys)",
    implement:
      "Lua: indexes start at 1; # is unreliable on a table with nil holes; declare every variable local; escape magic characters in string patterns (or string.find with plain); use // and io.write where the spec fixes the bytes; sort keys where the spec orders.",
  },
  elixir: NO_REVIEW("Elixir"),
  dart: {
    implement:
      "Dart: `catch (e)` without `on` also catches Errors; await a Future or pass it to `unawaited`; no `!` or `late` on input-dependent values; `List.sort` is not stable and a `HashMap` has no order; `~/` truncates toward zero.",
  },
  zig: NO_REVIEW("Zig"),
  bash: NO_REVIEW("Bash"),
  ocaml: NO_REVIEW("OCaml"),
  objc: NO_REVIEW("Objective-C"),
  vue: NO_REVIEW("Vue"),
  svelte: NO_REVIEW("Svelte"),
  rescript: NO_REVIEW("ReScript"),
  solidity: NO_REVIEW("Solidity"),
  sql: {
    review:
      "SQL: syntax of another dialect than the project's (the SQLFluff dialect, the database the migrations target), a migration that cannot be reversed or drops data without a backup step, a schema change that takes a long table lock (an index built without CONCURRENTLY on PostgreSQL, a column added with a volatile default), NULL compared with = or <>, and string-built queries instead of parameters",
    implement:
      "SQL: write the project's dialect; compare NULL with IS NULL, not = or <>; use parameters, not string-built queries; keep migrations reversible and avoid long table locks (CONCURRENTLY on PostgreSQL).",
  },
  powershell: {
    review:
      "PowerShell: a `[Parameter(Mandatory)]` parameter that rejects an empty array or empty string a caller may pass (add `[AllowEmptyCollection()]` or `[AllowEmptyString()]`), a comparison with $null on the right (`$list -eq $null` filters the array; write `$null -eq $x`), a single result unrolled from an array where the caller counts or indexes it (wrap in @()), stray output from an unassigned call (`$list.Add(...)` returns an index; assign to $null), -eq, -like, -match and -contains that compare case-insensitively where the spec is case-sensitive (-ceq, -cmatch), errors that do not stop the script (a cmdlet's non-terminating error without -ErrorAction Stop), Write-Host where the result belongs on the pipeline, and Windows PowerShell 5.1 differences when the project supports it (Set-Content and Out-File default encodings, no ternary or ?? operators, no $PSStyle)",
    implement:
      "PowerShell: a `[Parameter(Mandatory)]` parameter rejects an empty array or string (add `[AllowEmptyCollection()]` or `[AllowEmptyString()]`); write `$null -eq $x`; wrap a result in @() once, where the caller counts it; assign `$list.Add(...)` to $null; -ceq or -cmatch where the spec is case-sensitive; -ErrorAction Stop; results on the pipeline, not Write-Host.",
  },
  r: {
    review:
      "R: 1:length(x) or 1:nrow(df) on empty input (it counts down to 0; use seq_along or seq_len), sapply whose result type depends on the input (use vapply), if or while on a vector longer than one or on NA (an error since R 4.2), == against NA (use is.na) and == on doubles (use all.equal or a tolerance), silent recycling of vectors of unequal lengths, T and F for TRUE and FALSE, partial matching of $ and of argument names, library() or require() inside package code instead of Imports and pkg::fn, and set.seed or options changed without restoring them",
    implement:
      "R: seq_along or seq_len, not 1:length(x); vapply, not sapply; is.na, not == NA; all.equal or a tolerance on doubles; TRUE and FALSE, not T and F; pkg::fn, not library() in package code.",
  },
};

/** The reviewer's own clauses, in the order its instructions list them. */
export const REVIEW_CLAUSE_ORDER: readonly SupportedLanguage[] = [
  "php",
  "lua",
  "c",
  "cpp",
  "sql",
  "powershell",
  "r",
];

/** The language reviewer's per-language clauses, joined as its instructions hold them. */
export function reviewPitfallClauses(): string {
  const clauses = REVIEW_CLAUSE_ORDER.flatMap((language) => {
    const review = rowOf(LANGUAGE_PITFALLS, language)?.review;
    return review ? [review] : [];
  });
  return [...new Set(clauses)].join("; ");
}

/** The implementer's notes for the languages of the files a task writes, once each, in path order. */
export function implementerPitfalls(paths: readonly string[]): string[] {
  const notes: string[] = [];
  for (const path of paths) {
    const language = detectLanguageFromPath(path);
    if (!language || !isSupportedLanguage(language)) continue;
    const note = rowOf(LANGUAGE_PITFALLS, language)?.implement;
    if (note && !notes.includes(note)) notes.push(note);
  }
  return notes;
}
