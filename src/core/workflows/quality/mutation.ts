/**
 * The mutation gate (#636): small faults planted in the lines a run added, one at a time, with
 * the project's test checks run against each. A mutant the tests do not notice ("survived") means
 * the new tests assert too little. Under `required` a surviving mutant is a blocking finding the
 * run corrects with a test that kills it; under `advisory` survivors are notes in the run report.
 * The engine is built in and needs no tool on the machine. A gate that runs out of its time
 * budget is inconclusive for the mutants it did not run, never a failure.
 */
import { isTestCodePath } from "./duplication.js";
import { addedLines, type ChangedFile } from "./rules.js";

export type MutationMode = "off" | "advisory" | "required";
/** Artifact of the latest mutation gate of a run. */
export const QUALITY_MUTATION = "quality/mutation.json";
/**
 * The file a mutant is planted in, as it was, until the gate restores it: a host that stops
 * mid-mutant restores it on the next drive.
 */
export const QUALITY_MUTATION_PENDING = "quality/mutation-pending.json";
/** Whether a finding's claim is one the mutation gate made. */
export const mutationClaim = (claim: unknown): boolean =>
  typeof claim === "string" && /^Surviving mutant \S+: /.test(claim);
/** The gate's mode when neither the policy nor the project names one: by workflow preset. */
export function presetMutation(preset: string): MutationMode {
  if (preset === "harden") return "required";
  return preset === "full" || preset === "tdd" ? "advisory" : "off";
}
/** The preset of a run's workflow; a schema 1 workflow runs the full pipeline. */
export const presetOf = (definition: { schemaVersion: number; definition: unknown }): string =>
  definition.schemaVersion === 2
    ? ((definition.definition as { preset?: string }).preset ?? "custom")
    : "full";
export const mutationOf = (
  policy: { mutation?: MutationMode | undefined },
  preset: string,
): MutationMode => policy.mutation ?? presetMutation(preset);
/** Mutants planted per gate, spread over the changed files and lines. */
export const MAX_MUTANTS = 24;
/** Time the gate may spend on mutants, all test checks included. */
export const DEFAULT_MUTATION_BUDGET_MS = 300_000;

export interface Mutant {
  id: string;
  file: string;
  /** 1-based. */
  line: number;
  operator: string;
  original: string;
  mutated: string;
}

export interface MutantOutcome extends Mutant {
  status: "killed" | "survived" | "timeout" | "not-run";
  /** The test check that failed on the mutant, for a killed one. */
  killedBy?: string;
  /** Whether a survivor blocks: the mode is `required`, the baseline is known, the file is under its threshold. */
  blocking: boolean;
}

export interface MutationResult {
  schemaVersion: 1;
  mode: MutationMode;
  /** The checks run against each mutant. */
  tests: string[];
  mutants: MutantOutcome[];
  /** Killed of run mutants, in percent; null when none ran. */
  score: number | null;
  note?: string;
}

interface Operator {
  id: string;
  /** Matched on the line with strings and comments blanked out. */
  pattern: RegExp;
  replace: string | ((match: string) => string);
}

// Binary operators need spaces around them so `=>`, `->`, generics and `<<` stay untouched.
const OPERATORS: readonly Operator[] = [
  { id: "equality", pattern: / === /, replace: " !== " },
  { id: "equality", pattern: / !== /, replace: " === " },
  { id: "equality", pattern: / == /, replace: " != " },
  { id: "equality", pattern: / != /, replace: " == " },
  { id: "boundary", pattern: / <= /, replace: " < " },
  { id: "boundary", pattern: / >= /, replace: " > " },
  { id: "boundary", pattern: / < /, replace: " <= " },
  { id: "boundary", pattern: / > /, replace: " >= " },
  { id: "logical", pattern: / && /, replace: " || " },
  { id: "logical", pattern: / \|\| /, replace: " && " },
  { id: "logical", pattern: / and /, replace: " or " },
  { id: "logical", pattern: / or /, replace: " and " },
  { id: "arithmetic", pattern: / \+ /, replace: " - " },
  { id: "arithmetic", pattern: / - /, replace: " + " },
  { id: "arithmetic", pattern: / \* /, replace: " / " },
  { id: "boolean", pattern: /\btrue\b/, replace: "false" },
  { id: "boolean", pattern: /\bfalse\b/, replace: "true" },
  { id: "boolean", pattern: /\bTrue\b/, replace: "False" },
  { id: "boolean", pattern: /\bFalse\b/, replace: "True" },
  { id: "negation", pattern: /(?<![\w)\]!=])!(?=[\w(])/, replace: "" },
  { id: "negation", pattern: /\bnot (?=\w)/, replace: "" },
  { id: "literal", pattern: /(?<![\w.])\d+(?![\w.])/, replace: (n) => String(Number(n) + 1) },
];

/** Lines that only declare or import: mutating them breaks the build, not the behavior. */
const SKIP_LINE =
  /^\s*(?:import\b|from\s+\S+\s+import\b|export\s+(?:\*|\{|type\b|interface\b)|package\b|using\b|use\b|#include\b|@|type\s+\w+\s*=|interface\b)/;

/** The line with string literals and comments replaced by spaces, so positions stay the same. */
export function codeOnly(line: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (quote) {
      if (c === "\\") {
        out += "  ";
        i++;
        continue;
      }
      if (c === quote) quote = null;
      out += c === quote || quote === null ? c : " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if ((c === "/" && line[i + 1] === "/") || c === "#") return out + " ".repeat(line.length - i);
    out += c;
  }
  return out;
}

/** Mutants on the lines each changed non-test code file gained, spread round-robin and capped. */
export function generateMutants(files: ChangedFile[], max = MAX_MUTANTS): Mutant[] {
  const perLine: Mutant[][] = [];
  for (const file of files) {
    if (isTestCodePath(file.path)) continue;
    const lines = file.content.split("\n");
    for (const index of [...addedLines(file.before, file.content)].sort((a, b) => a - b)) {
      const original = lines[index] ?? "";
      if (!original.trim() || SKIP_LINE.test(original)) continue;
      const masked = codeOnly(original);
      const mutants: Mutant[] = [];
      for (const operator of OPERATORS) {
        const match = operator.pattern.exec(masked);
        if (!match) continue;
        const replacement =
          typeof operator.replace === "string" ? operator.replace : operator.replace(match[0]);
        const mutated =
          original.slice(0, match.index) +
          replacement +
          original.slice(match.index + match[0].length);
        if (mutated === original || mutants.some((m) => m.mutated === mutated)) continue;
        mutants.push({
          id: "",
          file: file.path,
          line: index + 1,
          operator: operator.id,
          original,
          mutated,
        });
      }
      if (mutants.length) perLine.push(mutants);
    }
  }
  // One mutant per line first, then the second of each line, so a cap covers the most lines.
  const out: Mutant[] = [];
  for (let round = 0; out.length < max; round++) {
    const next = perLine.map((mutants) => mutants[round]).filter((m): m is Mutant => !!m);
    if (!next.length) break;
    out.push(...next.slice(0, max - out.length));
  }
  return out.map((mutant, i) => ({ ...mutant, id: `M${i + 1}` }));
}

/** The file with one line replaced by its mutant. */
export function applyMutant(content: string, mutant: Mutant): string {
  const lines = content.split("\n");
  lines[mutant.line - 1] = mutant.mutated;
  return lines.join("\n");
}

/** Whether a check runs the project's tests rather than a linter, formatter or type checker. */
export function isTestCheck(check: { id: string; executable: string; args: string[] }): boolean {
  const text = [check.id, check.executable, ...check.args].join(" ").toLowerCase();
  return /\b(?:test|tests|pytest|vitest|jest|mocha|ava|tap|phpunit|rspec|ctest|nextest)\b/.test(
    text,
  );
}

/** A path glob as a regular expression: `**` spans directories, `*` and `?` stay within one. */
function globRegex(pattern: string): RegExp {
  const part = (text: string) =>
    text
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
  return new RegExp(
    `^${pattern
      .split(/\*\*\/?/)
      .map(part)
      .join(".*")}$`,
  );
}

/**
 * The killed share in percent a file needs under `required`: the longest pattern that matches
 * it, a glob or a directory prefix (`src/auth/**: 70`), else 100 (every mutant must be killed).
 */
export function thresholdFor(path: string, thresholds: Record<string, number> | undefined): number {
  let best: { length: number; value: number } | null = null;
  for (const [pattern, value] of Object.entries(thresholds ?? {})) {
    const prefix = pattern.replace(/\/?\*\*$/, "").replace(/\/$/, "");
    const matches =
      globRegex(pattern).test(path) || (prefix !== "" && path.startsWith(`${prefix}/`));
    if (matches && (!best || pattern.length > best.length))
      best = { length: pattern.length, value };
  }
  return best?.value ?? 100;
}

export interface MutationRunner {
  /** Writes a mutated file into the workspace. */
  plant(path: string, content: string): Promise<void>;
  /** Puts a file back exactly as it was (its bytes, not the decoded text). */
  restore(path: string): Promise<void>;
  /** Runs the test checks on the workspace as it is now. */
  test(timeLeftMs: number): Promise<{ status: "passed" | "failed" | "timeout"; check?: string }>;
  now(): number;
}

/**
 * Plants each mutant, runs the tests and restores the file before the next one. The original is
 * restored in a `finally`, so an error or cancellation never leaves a mutant behind.
 */
export async function runMutants(
  mode: MutationMode,
  mutants: Mutant[],
  files: ChangedFile[],
  tests: string[],
  runner: MutationRunner,
  options: { budgetMs?: number; thresholds?: Record<string, number>; signal?: AbortSignal } = {},
): Promise<MutationResult> {
  const budget = options.budgetMs ?? DEFAULT_MUTATION_BUDGET_MS;
  const started = runner.now();
  const content = new Map(files.map((f) => [f.path, f]));
  const outcomes: MutantOutcome[] = [];
  let outOfTime = false;
  for (const mutant of mutants) {
    options.signal?.throwIfAborted();
    const file = content.get(mutant.file);
    const left = budget - (runner.now() - started);
    if (!file || left <= 0) {
      outOfTime ||= left <= 0;
      outcomes.push({ ...mutant, status: "not-run", blocking: false });
      continue;
    }
    let result: Awaited<ReturnType<MutationRunner["test"]>>;
    try {
      await runner.plant(mutant.file, applyMutant(file.content, mutant));
      result = await runner.test(left);
    } finally {
      await runner.restore(mutant.file);
    }
    outcomes.push({
      ...mutant,
      status:
        result.status === "failed"
          ? "killed"
          : result.status === "timeout"
            ? "timeout"
            : "survived",
      ...(result.status === "failed" && result.check ? { killedBy: result.check } : {}),
      blocking: false,
    });
  }
  // A survivor blocks while its file's score is under the file's threshold.
  for (const outcome of outcomes) {
    if (outcome.status !== "survived" || mode !== "required") continue;
    if (content.get(outcome.file)?.before === undefined) continue;
    const ran = outcomes.filter(
      (o) => o.file === outcome.file && (o.status === "killed" || o.status === "survived"),
    );
    const killed = ran.filter((o) => o.status === "killed").length;
    outcome.blocking = (killed / ran.length) * 100 < thresholdFor(outcome.file, options.thresholds);
  }
  const ran = outcomes.filter((o) => o.status === "killed" || o.status === "survived");
  const notes = [
    ...(outOfTime
      ? [`time budget of ${Math.round(budget / 1000)}s reached; the remaining mutants did not run`]
      : []),
    ...(!mutants.length ? ["no mutable line was added"] : []),
  ];
  return {
    schemaVersion: 1,
    mode,
    tests,
    mutants: outcomes,
    score: ran.length
      ? Math.round((ran.filter((o) => o.status === "killed").length / ran.length) * 100)
      : null,
    ...(notes.length ? { note: notes.join("; ") } : {}),
  };
}
