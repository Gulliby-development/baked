import { describe, expect, test } from "bun:test";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import {
  implementerPitfalls,
  LANGUAGE_PITFALLS,
  PITFALL_NOTE_MAX,
  REVIEW_CLAUSE_ORDER,
  reviewPitfallClauses,
} from "../src/core/agents/profiles/language-pitfalls.js";
import { rowOf, type SupportedLanguage } from "../src/core/intelligence/language-records.js";
import { LANGUAGE_REVIEW_PROFILE, type ProjectLanguage } from "../src/core/workflows/language.js";
import {
  pitfallsRecord,
  RUN_TRAPS_MAX,
  runTraps,
  TRAP_LINE_CHARS,
  trapLine,
  trapRule,
} from "../src/core/workflows/pitfall-notes.js";

// #2598: one table of per-language pitfalls feeds the language reviewer and the implementer.
const reviewer = builtinProfiles.find((p) => p.id === LANGUAGE_REVIEW_PROFILE)?.instructions ?? "";

/** The supported languages each language the reviewer runs for covers. */
const REVIEWED: Record<ProjectLanguage, SupportedLanguage[]> = {
  go: ["go"],
  dotnet: ["csharp"],
  rust: ["rust"],
  java: ["java"],
  kotlin: ["kotlin"],
  ruby: ["ruby"],
  dart: ["dart"],
  php: ["php"],
  sql: ["sql"],
  powershell: ["powershell"],
  lua: ["lua"],
  cpp: ["c", "cpp"],
  scala: ["scala"],
  swift: ["swift"],
  r: ["r"],
};

describe("language pitfalls table (#2598)", () => {
  test("the language reviewer's instructions hold every review clause of the table", () => {
    expect(reviewer).toContain(reviewPitfallClauses());
    for (const language of REVIEW_CLAUSE_ORDER) {
      const review = rowOf(LANGUAGE_PITFALLS, language)?.review;
      expect({ language, review: typeof review }).toEqual({ language, review: "string" });
      expect(reviewer).toContain(review ?? "");
    }
  });

  test.each(Object.entries(REVIEWED))("%s: every language the reviewer reviews has an implementer note", (_, languages) => {
    for (const language of languages) {
      const note = rowOf(LANGUAGE_PITFALLS, language)?.implement ?? "";
      expect({ language, note: note.length > 0 }).toEqual({ language, note: true });
      expect(note.length).toBeLessThanOrEqual(PITFALL_NOTE_MAX);
      // Taken from the reviewer's text: every code span the note holds, the reviewer holds too.
      for (const span of note.match(/`[^`]+`/g) ?? []) expect({ language, span, held: reviewer.includes(span) }).toEqual({ language, span, held: true });
    }
  });

  test("the PowerShell note names the R84 wrapsmith traps", () => {
    const note = rowOf(LANGUAGE_PITFALLS, "powershell")?.implement ?? "";
    for (const trap of ["[Parameter(Mandatory)]", "[AllowEmptyCollection()]", "[AllowEmptyString()]", "$null -eq $x", "$list.Add(...)", "@()", "Write-Host"])
      expect(note).toContain(trap);
    expect(reviewer).toContain("[AllowEmptyCollection()]");
  });

  test("a task's notes are those of the languages it writes, once each, and stay short", () => {
    const notes = implementerPitfalls(["src/Lines.ps1", "src/Layout.psm1", "tests/Lines.Tests.ps1", "README.md", "src/a.c", "src/b.cpp"]);
    expect(notes.map((n) => n.slice(0, n.indexOf(":")))).toEqual(["PowerShell", "C and C++"]);
    expect(implementerPitfalls(["src/index.ts", "app.py"])).toEqual([]);
    // Prompt size is watched: every note stays under PITFALL_NOTE_MAX, and a PowerShell task's
    // addition is measured.
    const longest = Object.values(LANGUAGE_PITFALLS).flatMap((row) => ("implement" in row ? [row.implement.length] : []));
    expect(Math.max(...longest)).toBeLessThanOrEqual(PITFALL_NOTE_MAX);
    const record = pitfallsRecord("T002", ["src/Lines.ps1"], [], true);
    expect(record.chars).toBe(rowOf(LANGUAGE_PITFALLS, "powershell")?.implement.length ?? 0);
    expect(record.chars).toBeLessThan(400);
  });
});

describe("run traps (#2598)", () => {
  const pester = [
    "Describing Get-Lines",
    "  [-] handles no positional arguments 14ms (12ms|2ms)",
    "   ParameterBindingValidationException: Cannot bind argument to parameter 'Positional' because it is an empty array.",
    "   at <ScriptBlock>, C:\\work\\src\\Lines.ps1:12",
    "Tests completed in 1.21s",
    "Tests Passed: 3, Failed: 1, Skipped: 0",
  ].join("\r\n");

  test("a failing output's trap is its first error line, normalized and cut", () => {
    expect(trapLine(pester)).toBe("ParameterBindingValidationException: Cannot bind argument to parameter 'Positional' because it is an empty array.");
    expect(trapLine("Tests Passed: 3, Failed: 1\n0 errors")).toBeNull();
    expect(trapLine(`error[E0308]: ${"x".repeat(400)}`)?.length).toBe(TRAP_LINE_CHARS);
  });

  test("other tasks' failures give each error line once, at most RUN_TRAPS_MAX, never the task's own", () => {
    const failures = [
      { taskId: "T001", checkId: "pester", output: pester },
      { taskId: "T003", checkId: "pester", output: pester.replace("14ms (12ms|2ms)", "9ms (8ms|1ms)") },
      { taskId: "T002", checkId: "pester", output: "TypeError: own failure" },
      ...["A", "B", "C"].map((n) => ({ taskId: "T004", checkId: "lint", output: `error: rule ${n}` })),
    ];
    const traps = runTraps(failures, "T002");
    expect(traps.map((t) => [t.taskId, t.checkId])).toEqual([["T001", "pester"], ["T004", "lint"], ["T004", "lint"]]);
    expect(traps).toHaveLength(RUN_TRAPS_MAX);
    expect(trapRule(traps[0]!)).toBe(
      "T001 of this run failed pester with: ParameterBindingValidationException: Cannot bind argument to parameter 'Positional' because it is an empty array. (avoid the same mistake in the files you write)",
    );
  });
});
