import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isTestCodePath } from "../workflows/quality/duplication.js";
import type { Spec } from "../workflows/schemas.js";
import type { Task } from "../workflows/types.js";

/**
 * The cases the criteria spell out, walked against the test files a task wrote (#1250). Bench
 * round 28: leaguetab's tests left out the table case "1, 2=, 2=, 4" and cochange-update's the
 * `--path src/cli` and `--path SRC` no-match cases; a model reviewer was the first to read them,
 * and each correction cost 0.2M to 0.5M tokens. The host now names such a case to the task that
 * writes the tests, inside its attempt.
 */

/** One quoted literal of a criterion: a message, an argument spelling or an input. */
export interface CriterionCase {
  criterionId: string;
  literal: string;
}

/** Quoted spans: "...", `...` and the typographic double quotes. */
const QUOTED = /"([^"\n]+)"|`([^`\n]+)`|\u201c([^\u201d\n]+)\u201d/g;
/** A placeholder the test fills with a concrete value: `<file>`, `{name}`, `...`. */
const PLACEHOLDER = /<[^<>\s][^<>]*>|\{[^{}]+\}|\.\.\.|\u2026/g;

/** The quoted literals of the automated criteria a task covers, each once. */
export function criterionCases(
  spec: Pick<Spec, "criteria">,
  task: Pick<Task, "criterionIds">,
): CriterionCase[] {
  const cases: CriterionCase[] = [];
  const seen = new Set<string>();
  for (const criterion of spec.criteria) {
    if (!task.criterionIds.includes(criterion.id) || criterion.method !== "automated") continue;
    for (const text of [criterion.given, criterion.when, criterion.then])
      for (const match of text.matchAll(QUOTED)) {
        const literal = (match[1] ?? match[2] ?? match[3] ?? "").trim();
        // One character says too little to look for, and a span that is all placeholder nothing.
        if (literal.replace(PLACEHOLDER, "").replace(/\W/g, "").length < 2 || seen.has(literal))
          continue;
        seen.add(literal);
        cases.push({ criterionId: criterion.id, literal });
      }
  }
  return cases;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** What may stand between the words of a literal in a test: spaces, or the quotes and commas of an argument list. */
const SEPARATOR = String.raw`[\s"'\x60,()[\]]+`;

/**
 * Whether a test text holds the literal: as written, with string escapes undone, or with its
 * words as separate arguments (`["--path", "src/cli"]`). A placeholder matches any text.
 */
export function testsHold(text: string, literal: string): boolean {
  const unescaped = text.replace(/\\(["'\\`])/g, "$1");
  const pattern = literal
    .split(PLACEHOLDER)
    .map((part) => part.split(/\s+/).filter(Boolean).map(escapeRegex).join(SEPARATOR))
    .join("[\\s\\S]*?");
  const regex = new RegExp(pattern);
  return regex.test(unescaped);
}

/** The cases no text holds. */
export const missingCases = (cases: CriterionCase[], texts: string[]): CriterionCase[] =>
  cases.filter((c) => !texts.some((text) => testsHold(text, c.literal)));

/** The test files a task creates or modifies. */
export const writtenTestPaths = (task: Pick<Task, "writes">): string[] =>
  task.writes.filter((w) => w.action !== "delete" && isTestCodePath(w.path)).map((w) => w.path);

/**
 * The check a task's attempt runs before it is accepted: the criteria's cases its test files do
 * not hold, one line each. Undefined when the task writes no test file or its criteria quote
 * nothing.
 */
export function caseCheck(
  spec: Pick<Spec, "criteria"> | null | undefined,
  task: Pick<Task, "criterionIds" | "writes">,
): ((root: string) => Promise<string[]>) | undefined {
  const paths = writtenTestPaths(task);
  const cases = spec ? criterionCases(spec, task) : [];
  if (!paths.length || !cases.length) return undefined;
  return async (root) => {
    const texts = (
      await Promise.all(paths.map((path) => readFile(join(root, path), "utf8").catch(() => null)))
    ).filter((text): text is string => text !== null);
    return missingCases(cases, texts).map(
      (c) =>
        `${c.criterionId} names ${JSON.stringify(c.literal)}, and no test file this task writes (${paths.join(", ")}) contains it.`,
    );
  };
}
