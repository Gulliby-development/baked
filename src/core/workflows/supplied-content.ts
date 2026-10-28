import { type LanguageRecord, none, rowOf } from "../intelligence/language-records.js";
import { detectLanguageFromPath } from "../intelligence/types.js";
import {
  type CaseContext,
  criterionCases,
  missingCases,
  writtenTestPaths,
} from "../verification/criteria-cases.js";
import type { Analysis, Spec, TaskGraph } from "./schemas.js";
import { exactTextSections, suppliedBlocks } from "./sizing.js";
import type { Task } from "./types.js";

/**
 * Criteria checked at analysis against file content the request supplies verbatim (#2006, part b
 * of #2000's fix). R64 mdtoc-update: the request gave tests/version.test.ts in full, AC-006 named a
 * literal that file lacks, and only the task-end case walk found it, after an implementer session
 * (237,581 tokens) and a second refusal (323,183 tokens). The host now runs the same case walk on
 * the supplied text at analysis, with no model call: a criterion literal that no supplied test file
 * of the task holds is a finding for the spec author, never a refusal for an implementer.
 *
 * A test file counts as supplied when the request gives exactly one fenced block for it
 * (`suppliedBlocks`, the reader pricing and the host apply decision use) and the task creates the
 * file or the prose before the block says it is the whole file. A task is checked only when every
 * test file it writes is supplied, and a case is raised only when no other task that carries the
 * criterion writes a test file of its own, since the walk lets a sibling's test hold a case.
 */
export const SUPPLIED_PREFIX = "SUPPLIED-";

export function isSuppliedContentFinding(finding: { id: string }): boolean {
  return finding.id.startsWith(SUPPLIED_PREFIX);
}

/** The test files each task writes whose whole content the request supplies, by task id. */
export function suppliedTestFiles(
  request: string,
  graph: Pick<TaskGraph, "tasks">,
): Map<string, { path: string; content: string }[]> {
  const paths = [...new Set(graph.tasks.flatMap((t) => writtenTestPaths(t)))];
  const blocks = suppliedBlocks(request, paths);
  const out = new Map<string, { path: string; content: string }[]>();
  for (const task of graph.tasks) {
    const tests = writtenTestPaths(task);
    const files = tests.flatMap((path) => {
      const supplied = blocks.get(path) ?? [];
      const [block] = supplied;
      const write = task.writes.find((w) => w.path === path);
      if (supplied.length !== 1 || block?.kind !== "file") return [];
      if (!block.whole && write?.action !== "create") return [];
      return [{ path, content: block.content }];
    });
    if (tests.length && files.length === tests.length) out.set(task.id, files);
  }
  return out;
}

/** One blocking finding per criterion whose literals a task's supplied test files do not hold. */
export function suppliedContentFindings(
  spec: Spec,
  graph: Pick<TaskGraph, "tasks">,
  request: string,
  context: Pick<CaseContext, "checks">,
): Analysis["findings"] {
  const supplied = suppliedTestFiles(request, graph);
  const missing = new Map<string, { task: string; paths: string[]; literals: string[] }[]>();
  for (const task of graph.tasks) {
    const files = supplied.get(task.id);
    if (!files) continue;
    const cases = criterionCases(spec, task, { checks: context.checks, tasks: graph.tasks });
    const open = missingCases(
      cases,
      files.map((f) => f.content),
    ).filter(
      // A sibling that carries the criterion and writes its own test file may test the case.
      (c) =>
        !graph.tasks.some(
          (other) =>
            other.id !== task.id &&
            other.criterionIds.includes(c.criterionId) &&
            writtenTestPaths(other).length > 0 &&
            !supplied.has(other.id),
        ),
    );
    for (const c of open) {
      const entries = missing.get(c.criterionId) ?? [];
      let entry = entries.find((e) => e.task === task.id);
      if (!entry) {
        entry = { task: task.id, paths: files.map((f) => f.path), literals: [] };
        entries.push(entry);
      }
      if (!entry.literals.includes(c.literal)) entry.literals.push(c.literal);
      missing.set(c.criterionId, entries);
    }
  }
  return [...missing].flatMap(([criterionId, entries]) => {
    const criterion = spec.criteria.find((c) => c.id === criterionId);
    if (!criterion) return [];
    const listed = entries
      .map(
        (e) =>
          `${e.literals.map((l) => JSON.stringify(l)).join(", ")} (task ${e.task} writes only ${e.paths.join(", ")})`,
      )
      .join("; ");
    return [
      {
        id: `${SUPPLIED_PREFIX}${criterionId}`,
        kind: "inconsistency" as const,
        refs: ["spec.json", criterionId],
        description:
          `Supplied content: ${criterionId} names ${listed}, but the request gives the content of those test files verbatim and it does not contain ${entries.length === 1 && entries[0]?.literals.length === 1 ? "that literal" : "those literals"}. The task-end case walk would refuse the implementer for it. The request outranks the criterion: rewrite ${criterionId} so the supplied content satisfies it (quote what the supplied file tests), or move the literal to a criterion a task with a test file of its own carries.`.slice(
            0,
            16000,
          ),
        blocking: true,
      },
    ];
  });
}

/** A report that says the content of a file is fixed: "verbatim", "exactly this content", "byte for byte". */
const EXACT_CONTENT =
  /\bverbatim\b|\bexact(?:ly)?\s+(?:this\s+|the\s+)?(?:content|contents|file|text)\b|\bbyte[- ]for[- ]byte\b|\bas (?:supplied|given) in the request\b/i;
export const namesExactContent = (text: string): boolean => EXACT_CONTENT.test(text);

/**
 * The criteria of a `spec_conflict` that cites none by id but is about a test file the request
 * supplies verbatim (#2006, part c): the report names the file, or says its content is fixed, and
 * the task writes a supplied test file. They are the task's criteria whose literals its supplied
 * files lack, as `suppliedContentFindings` finds them, so the request re-audit of the first
 * report checks them against the request instead of a second session meeting the same refusal.
 */
export function suppliedConflictCriteria(
  spec: Spec,
  task: TaskGraph["tasks"][number],
  graph: Pick<TaskGraph, "tasks">,
  request: string,
  report: { text: string; paths: readonly string[] },
  context: Pick<CaseContext, "checks">,
): string[] {
  const files = suppliedTestFiles(request, graph).get(task.id);
  if (!files) return [];
  if (!files.some((f) => report.paths.includes(f.path)) && !namesExactContent(report.text))
    return [];
  return suppliedContentFindings(spec, graph, request, context)
    .map((f) => f.refs[1] ?? "")
    .filter((id) => task.criterionIds.includes(id));
}

/** How a language writes a double-quoted string literal: its quotes, escapes and control escape. */
interface LiteralForm {
  /** Before the opening quote: `@` for an Objective-C string, `$` for Bash's ANSI-C quoting. */
  prefix?: string;
  quote: string;
  /** Characters the literal escapes by name: the quote, the escape character, line ends, tabs. */
  escapes: Readonly<Record<string, string>>;
  /** Any other control character, by code point. */
  control: (code: number) => string;
}

const hex = (code: number, width: number) => code.toString(16).padStart(width, "0");
const u4 = (code: number) => `\\u${hex(code, 4)}`;
const uBraced = (code: number) => `\\u{${hex(code, 1)}}`;
const x2 = (code: number) => `\\x${hex(code, 2)}`;
// Three digits, so a digit after the escape is never read into it.
const octal = (code: number) => `\\${code.toString(8).padStart(3, "0")}`;
const decimal = (code: number) => `\\${String(code).padStart(3, "0")}`;
const C_ESCAPES = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\t": "\\t", "\r": "\\r" } as const;
const form = (
  control: LiteralForm["control"],
  extra: Record<string, string> = {},
): LiteralForm => ({
  quote: '"',
  escapes: { ...C_ESCAPES, ...extra },
  control,
});
const JS_FORM = form(u4);
// `\uXXXX` is read before the lexer in Java, so `\u000a` would end the literal: octal instead.
const C_FORM = form(octal);
// Kotlin, Dart and PHP interpolate `$`; Ruby and Elixir interpolate `#{`, `#@` and `#$`.
const DOLLAR = { $: "\\$" };
const HASH = { "#": "\\#" };

/**
 * The double-quoted string literal of each language, for an expected text a test compares exactly
 * (#2101). R67 srtvet-update T005 compared a 1,264-character README section with backticks in Go,
 * where a raw string cannot hold a backtick, and spent 1.64M tokens over four check rounds on the
 * string's quoting. Only control characters other than line ends and tabs are escaped by code;
 * any other character, non-ASCII included, is written as it is (the source files are UTF-8).
 */
export const STRING_LITERALS: LanguageRecord<LiteralForm> = {
  typescript: JS_FORM,
  javascript: JS_FORM,
  vue: JS_FORM,
  svelte: JS_FORM,
  rescript: none(
    "ReScript reads a non-ASCII character in a plain string as bytes; its tests take js strings (`js`) the form does not write",
  ),
  python: form(u4),
  go: form(u4),
  rust: form(uBraced),
  java: C_FORM,
  kotlin: form(u4, DOLLAR),
  // Scala 2.13.2 and later and Scala 3 read `\u` in a string literal as its character.
  scala: form(u4),
  csharp: form(u4),
  c: C_FORM,
  cpp: C_FORM,
  objc: { ...C_FORM, prefix: "@" },
  ruby: form(u4, HASH),
  php: form(uBraced, DOLLAR),
  swift: form(uBraced),
  // Decimal escapes read the same in Lua 5.1 to 5.4 and LuaJIT; `\u{}` needs 5.3.
  lua: form(decimal),
  elixir: form(u4, HASH),
  dart: form(u4, DOLLAR),
  zig: form(x2),
  bash: {
    prefix: "$",
    quote: "'",
    escapes: { "\\": "\\\\", "'": "\\'", "\n": "\\n", "\t": "\\t", "\r": "\\r" },
    control: x2,
  },
  ocaml: form(decimal),
  solidity: none(
    "A Solidity string holds printable ASCII only without the unicode prefix, and a Foundry test compares hashes, not documents",
  ),
  sql: none("A SQL project's tests are queries, which compare no document text"),
  // The backtick escapes; typographic double quotes end a string as `"` does.
  powershell: {
    quote: '"',
    escapes: {
      "`": "``",
      '"': '`"',
      "“": "`“",
      "”": "`”",
      "„": "`„",
      $: "`$",
      "\n": "`n",
      "\t": "`t",
      "\r": "`r",
    },
    control: (code) => `$([char]0x${hex(code, 2)})`,
  },
  r: form(u4),
};

/** `text` as a string literal of `language`, or null for a language with no row. */
export function stringLiteral(language: string, text: string): string | null {
  const row = rowOf(STRING_LITERALS, language);
  if (!row) return null;
  let body = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const named = row.escapes[char];
    body += named ?? (code < 0x20 || code === 0x7f ? row.control(code) : char);
  }
  return `${row.prefix ?? ""}${row.quote}${body}${row.quote}`;
}

/**
 * The expected texts a test task's criteria compare exactly, as string literals of its test
 * files' language, for the implementer (`exactTextLiteral: "on"`, #2101): each request section a
 * criterion of the task names with an exact comparison (`exactTextSections`), written by the host
 * once. Absent for a task that writes no test file, compares no section exactly, or whose language
 * has no literal row.
 */
export function exactTextContext(
  request: string,
  spec: Pick<Spec, "criteria">,
  task: Pick<Task, "criterionIds" | "writes" | "title" | "description">,
): {
  exactText?: { sections: { title: string; characters: number; literal: string }[]; note: string };
} {
  const [test] = writtenTestPaths(task);
  if (!test) return {};
  const language = detectLanguageFromPath(test);
  const sections = exactTextSections(request, spec, task).flatMap(({ title, text }) => {
    const literal = stringLiteral(language, text);
    return literal ? [{ title, characters: [...text].length, literal }] : [];
  });
  if (!sections.length) return {};
  return {
    exactText: {
      sections,
      note: `The request gives these sections verbatim, and a criterion of this task compares one exactly. Each literal is the section's exact text as a ${language} string literal, every escape already written: paste it into the test as the expected value as it is, never retyping or re-escaping the text. The section runs from its heading line to the line before the next heading of the same or a higher level, with trailing whitespace trimmed; compare the file's region the same way.`,
    },
  };
}
