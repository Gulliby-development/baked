/**
 * The mutation gate (#636): small faults planted in the lines a run added, one at a time, with
 * the project's test checks run against each. A mutant the tests do not notice ("survived") means
 * the new tests assert too little. Under `required` a surviving mutant is a blocking finding the
 * run corrects with a test that kills it; under `advisory` survivors are notes in the run report.
 * The built-in engine needs no tool on the machine; an ecosystem tool the project has installed
 * (`mutation-tools.ts`) runs instead and its report maps to the same result. A gate that runs out
 * of its time budget is inconclusive for the mutants it did not run, never a failure.
 */
import { staticToolOf } from "../static-tools.js";
import { toolchainCommand } from "../toolchain.js";
import { isNonCodeLine, maskNonCode } from "./code-mask.js";
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
/** The shortest time one mutant's tests get, however fast the green suite is. */
export const MIN_MUTANT_DEADLINE_MS = 20_000;

/**
 * How long one mutant's tests may run: three times the green suite plus 10 seconds, at least
 * 20 seconds. A mutant that makes the suite loop forever then costs seconds instead of the whole
 * budget (#1534).
 */
export function mutantDeadlineMs(greenMs: number): number {
  return Math.max(MIN_MUTANT_DEADLINE_MS, Math.ceil(3 * greenMs + 10_000));
}

export interface Mutant {
  id: string;
  file: string;
  /** 1-based. */
  line: number;
  operator: string;
  original: string;
  mutated: string;
  /** What changed, when the mutated text is not one line (a tool's mutant of a block or bytecode). */
  description?: string;
  /** The acceptance criterion an agent-proposed mutant targets. */
  criterionId?: string;
}

export interface MutantOutcome extends Mutant {
  /** `equivalent`: a survivor the equivalence check found cannot change behavior; it is not scored. */
  status: "killed" | "survived" | "timeout" | "not-run" | "equivalent";
  /** The test check that failed on the mutant, for a killed one. */
  killedBy?: string;
  /** Whether a survivor blocks: the mode is `required`, the baseline is known, the file is under its threshold. */
  blocking: boolean;
  /** Why the equivalence check judged the survivor equivalent. */
  equivalence?: string;
}

/** What made the mutants: the built-in operators or an installed ecosystem tool. */
export type MutationEngine =
  | "built-in"
  | "stryker"
  | "mutmut"
  | "cargo-mutants"
  | "pit"
  | "go-mutesting";

export interface MutationResult {
  schemaVersion: 1;
  mode: MutationMode;
  /** Absent in results written before tools were supported: the built-in engine. */
  engine?: MutationEngine;
  /** The checks run against each mutant. */
  tests: string[];
  mutants: MutantOutcome[];
  /** Killed or timed-out of run mutants, in percent; null when none ran. */
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

/** One entry per group before taking another from the same group. */
function interleave<T>(groups: T[][]): T[] {
  const out: T[] = [];
  for (let round = 0; groups.some((group) => round < group.length); round++)
    for (const group of groups) {
      const item = group[round];
      if (item !== undefined) out.push(item);
    }
  return out;
}

/**
 * Reserve an equal share for each file before redistributing unused capacity. Larger additions
 * go first when the cap cannot cover every file. Costs are one mutant or a numbered line's text.
 */
function fileShares<T>(
  files: { path: string; size: number; items: T[] }[],
  budget: number,
  cost: (item: T) => number,
): { path: string; items: T[] }[] {
  const groups = files
    .filter((file) => file.items.length)
    .sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => ({ ...file, index: 0, spent: 0, selected: [] as T[] }));
  const share = Math.floor(budget / groups.length);
  let left = budget;
  const take = (group: (typeof groups)[number], item: T) => {
    group.selected.push(item);
    group.index++;
    group.spent += cost(item);
    left -= cost(item);
  };
  for (const group of groups)
    for (const item of group.items) {
      if (group.spent + cost(item) > share) break;
      take(group, item);
    }
  while (left > 0) {
    // A short file gives its unused share to the least represented file that can still fit.
    let next: (typeof groups)[number] | undefined;
    for (const group of groups) {
      const item = group.items[group.index];
      if (item !== undefined && cost(item) <= left && (!next || group.spent < next.spent))
        next = group;
    }
    if (!next) break;
    const item = next.items[next.index];
    if (item !== undefined) take(next, item);
  }
  return groups.map((group) => ({ path: group.path, items: group.selected }));
}

/** Mutants on the lines each changed non-test code file gained, spread round-robin and capped. */
export function generateMutants(files: ChangedFile[], max = MAX_MUTANTS): Mutant[] {
  const perFile: { path: string; size: number; items: Mutant[] }[] = [];
  for (const file of files) {
    if (isTestCodePath(file.path)) continue;
    const perLine: Mutant[][] = [];
    let size = 0;
    const lines = file.content.split("\n");
    const code = maskNonCode(file.path, file.content).split("\n");
    for (const index of [...addedLines(file.before, file.content)].sort((a, b) => a - b)) {
      const original = lines[index] ?? "";
      const masked = code[index] ?? "";
      if (isNonCodeLine(masked) || SKIP_LINE.test(original)) continue;
      size += original.length;
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
    // Prefer distinct lines inside each file, even when a line supports several operators.
    perFile.push({ path: file.path, size, items: interleave(perLine) });
  }
  // Rotate files during execution too, so a deadline does not favor the first file's share.
  const out = interleave(fileShares(perFile, max, () => 1).map((file) => file.items));
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
  const launched = toolchainCommand(check.executable, check.args);
  const build = buildToolRunsTests(launched.program, launched.args);
  if (build !== null) return build;
  // A linter or formatter run on test files is no test run: `solhint 'test/**'`, `scalafmt --test` (#2110).
  if (staticToolOf(launched.program, launched.args)) return false;
  // Pint's `--test` is its check mode, not a test run (#1491); node and deno take `--test` to run tests.
  const flag = (arg: string) => arg === "--test" && !/^(?:node|deno)$/.test(launched.program);
  const text = [check.id, check.executable, ...check.args.filter((arg) => !flag(arg))]
    .join(" ")
    .toLowerCase();
  return /\b(?:test|tests|pytest|unittest|vitest|jest|mocha|ava|tap|phpunit|pest|rspec|busted|bats|ctest|nextest)\b/.test(
    text,
  );
}

/**
 * For a Maven or Gradle invocation, whether it runs a lifecycle phase or task that includes the
 * tests: `mvn test` or `verify` (also package and install), `gradle test` or `check` (also build),
 * unless the arguments skip them; null for any other program (#844: the mutation gate found no
 * test check in a Maven project checked by `mvn verify`).
 */
function buildToolRunsTests(tool: string, args: string[]): boolean | null {
  const phases =
    tool === "mvn" || tool === "mvnw"
      ? ["test", "verify", "package", "install"]
      : tool === "gradle" || tool === "gradlew"
        ? ["test", "check", "build"]
        : null;
  if (!phases) return null;
  if (!args.some((arg) => phases.includes(arg.toLowerCase().replace(/^:/, "")))) return false;
  return !args.some(
    (arg, i) =>
      /^-D(?:skipTests|maven\.test\.skip)(?:=true)?$/i.test(arg) ||
      ((arg === "-x" || arg === "--exclude-task") && /^:?test$/i.test(args[i + 1] ?? "")),
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
 * How long the test checks take on green code: for each, its slowest passing run recorded in the
 * run (a run of a test subset is faster), summed; undefined while any of them has not passed.
 */
export function greenSuiteMs(
  results: { check_id: string; status: string; duration_ms: number }[],
  checks: string[],
): number | undefined {
  let total = 0;
  for (const check of checks) {
    const passed = results.filter((r) => r.check_id === check && r.status === "passed");
    if (!passed.length) return undefined;
    total += Math.max(...passed.map((r) => r.duration_ms));
  }
  return checks.length ? total : undefined;
}

/**
 * Plants each mutant, runs the tests and restores the file before the next one. The original is
 * restored in a `finally`, so an error or cancellation never leaves a mutant behind. Each mutant's
 * tests get `mutantDeadlineMs` of the green suite's duration (`greenMs`, else the slowest mutant
 * run that finished so far), never more than the budget left.
 */
export async function runMutants(
  mode: MutationMode,
  mutants: Mutant[],
  files: ChangedFile[],
  tests: string[],
  runner: MutationRunner,
  options: {
    budgetMs?: number;
    /** How long the test checks take without a mutant, when known. */
    greenMs?: number;
    thresholds?: Record<string, number>;
    signal?: AbortSignal;
  } = {},
): Promise<MutationResult> {
  const budget = options.budgetMs ?? DEFAULT_MUTATION_BUDGET_MS;
  const started = runner.now();
  // A run that finished took about as long as the suite (a killed one may stop early).
  let slowest = 0;
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
      const green = options.greenMs ?? (slowest > 0 ? slowest : undefined);
      const before = runner.now();
      result = await runner.test(
        green === undefined ? left : Math.min(left, mutantDeadlineMs(green)),
      );
      if (result.status !== "timeout") slowest = Math.max(slowest, runner.now() - before);
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
  const notes = [
    ...(outOfTime
      ? [`time budget of ${Math.round(budget / 1000)}s reached; the remaining mutants did not run`]
      : []),
    ...(!mutants.length ? ["no mutable line was added"] : []),
  ];
  return scoreMutants(
    {
      schemaVersion: 1,
      mode,
      engine: "built-in",
      tests,
      mutants: outcomes,
      score: null,
      ...(notes.length ? { note: notes.join("; ") } : {}),
    },
    files,
    options.thresholds,
  );
}

/**
 * The result with its score and blocking survivors set from its mutants' statuses: a survivor
 * blocks while its file's score is under the file's threshold. A mutant whose tests timed out was
 * detected (the suite noticed it, as mutation tools count it) and scores with the killed ones;
 * equivalent and not-run mutants are not scored.
 */
export function scoreMutants(
  result: MutationResult,
  files: ChangedFile[],
  thresholds: Record<string, number> | undefined,
): MutationResult {
  const known = new Map(files.map((f) => [f.path, f.before !== undefined]));
  const detected = (o: MutantOutcome) => o.status === "killed" || o.status === "timeout";
  const ran = (o: MutantOutcome) => detected(o) || o.status === "survived";
  const mutants = result.mutants.map((outcome) => {
    if (outcome.status !== "survived" || result.mode !== "required" || !known.get(outcome.file))
      return { ...outcome, blocking: false };
    const inFile = result.mutants.filter((o) => o.file === outcome.file && ran(o));
    const killed = inFile.filter(detected).length;
    return {
      ...outcome,
      blocking: (killed / inFile.length) * 100 < thresholdFor(outcome.file, thresholds),
    };
  });
  const scored = mutants.filter(ran);
  return {
    ...result,
    mutants,
    score: scored.length
      ? Math.round((scored.filter(detected).length / scored.length) * 100)
      : null,
  };
}

/** Survivors the equivalence check judges per gate; the others stay findings until a later gate. */
export const MAX_EQUIVALENCE_CHECKS = 8;
/** Verdicts of the equivalence check, by mutant and file content, so a later gate asks again only for new mutants. */
export const QUALITY_MUTATION_EQUIVALENCE = "quality/mutation-equivalence.json";
/** The agent's mutants of the run's latest code, kept until the code changes. */
export const QUALITY_MUTATION_PROPOSALS = "quality/mutation-proposals.json";
/** Agent-proposed mutants per criterion and per gate. */
const MAX_PROPOSED_PER_CRITERION = 3;
const MAX_PROPOSED = 12;
/** Text of the added lines an agent is shown to propose mutants on. */
const MAX_PROPOSAL_INPUT_CHARS = 24_000;

/** The lines each changed non-test code file gained, numbered, for the agent that proposes mutants. */
export function proposalFiles(files: ChangedFile[]): { path: string; lines: string[] }[] {
  const perFile: { path: string; size: number; items: string[] }[] = [];
  for (const file of files) {
    if (isTestCodePath(file.path)) continue;
    const text = file.content.split("\n");
    const code = maskNonCode(file.path, file.content).split("\n");
    const lines: string[] = [];
    for (const index of [...addedLines(file.before, file.content)].sort((a, b) => a - b)) {
      const line = text[index] ?? "";
      if (isNonCodeLine(code[index]) || SKIP_LINE.test(line)) continue;
      const entry = `${index + 1}: ${line}`;
      lines.push(entry);
    }
    perFile.push({
      path: file.path,
      size: lines.reduce((sum, line) => sum + line.length, 0),
      items: lines,
    });
  }
  return fileShares(perFile, MAX_PROPOSAL_INPUT_CHARS, (line) => line.length)
    .filter((file) => file.items.length)
    .map((file) => ({ path: file.path, lines: file.items }));
}

/**
 * The proposals that change one line the run added, as it is in the file, into a different line;
 * at most three per criterion, numbered after the operator mutants. Indentation is the file's.
 */
export function proposedMutants(
  proposals: {
    criterionId: string;
    file: string;
    line: number;
    original: string;
    mutated: string;
  }[],
  files: ChangedFile[],
  existing: Mutant[],
): Mutant[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const perCriterion = new Map<string, number>();
  const masked = new Map<string, string[]>();
  const seen = new Set(existing.map((m) => `${m.file}:${m.line}:${m.mutated.trim()}`));
  const out: Mutant[] = [];
  for (const proposal of proposals) {
    const file = byPath.get(proposal.file);
    if (!file || isTestCodePath(file.path) || out.length >= MAX_PROPOSED) continue;
    if (!addedLines(file.before, file.content).has(proposal.line - 1)) continue;
    // A line inside a docstring, a multi-line string or a comment is prose, not code (#1521).
    const code = masked.get(file.path) ?? maskNonCode(file.path, file.content).split("\n");
    masked.set(file.path, code);
    if (isNonCodeLine(code[proposal.line - 1])) continue;
    const original = file.content.split("\n")[proposal.line - 1] ?? "";
    const mutated = proposal.mutated.trim();
    if (original.trim() !== proposal.original.trim() || mutated === original.trim()) continue;
    if (
      mutated.includes("\n") ||
      (perCriterion.get(proposal.criterionId) ?? 0) >= MAX_PROPOSED_PER_CRITERION
    )
      continue;
    const indented = (/^\s*/.exec(original)?.[0] ?? "") + mutated;
    const key = `${file.path}:${proposal.line}:${mutated}`;
    if (seen.has(key)) continue;
    seen.add(key);
    perCriterion.set(proposal.criterionId, (perCriterion.get(proposal.criterionId) ?? 0) + 1);
    out.push({
      id: `M${existing.length + out.length + 1}`,
      file: file.path,
      line: proposal.line,
      operator: "agent",
      original,
      mutated: indented,
      criterionId: proposal.criterionId,
    });
  }
  return out;
}
