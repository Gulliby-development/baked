import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchedCommand } from "../workflows/launcher.js";
import { isTestCodePath } from "../workflows/quality/duplication.js";
import type { Spec } from "../workflows/schemas.js";
import type { Check, Task } from "../workflows/types.js";

/**
 * The cases the criteria spell out, walked against the test files a task wrote (#1250). Bench
 * round 28: leaguetab's tests left out the table case "1, 2=, 2=, 4" and cochange-update's the
 * `--path src/cli` and `--path SRC` no-match cases; a model reviewer was the first to read them,
 * and each correction cost 0.2M to 0.5M tokens. The host now names such a case to the task that
 * writes the tests, inside its attempt.
 */

/**
 * One case of a criterion: a quoted message, argument spelling or input, a member of an
 * enumerated set, or the input cell of a table row (#1482).
 */
export interface CriterionCase {
  criterionId: string;
  literal: string;
  /** A set member is a whole word: `f16` is not found inside `bf16`. */
  word?: true;
}

/** Quoted spans: "...", `...` and the typographic double quotes. */
const QUOTED = /"((?:\\[^\n]|[^"\\\n])+)"|`([^`\n]+)`|\u201c([^\u201d\n]+)\u201d/g;
/** A placeholder the test fills with a concrete value: `<file>`, `{name}`, `...`. */
const PLACEHOLDER = /<[^<>\s][^<>]*>|\{[^{}]+\}|\.\.\.|\u2026/g;

/** Prose labels are for the reviewer, not strings a test must repeat (#1565). */
function literalCase(literal: string, code = false, value = false): boolean {
  const concrete = literal.replace(PLACEHOLDER, "");
  if (concrete.replace(/[^\p{L}\p{N}_]/gu, "").length < 2) return false;
  return (
    value ||
    /\d|(?:^|\s)--?[A-Za-z]|[=<>:+*%{}[\]]/.test(concrete) ||
    (code && (identifierLike(concrete) || /^[A-Z][a-z]\w*$/.test(concrete)))
  );
}

/** A quoted output or argument value can be plain English, unlike a quoted scenario label. */
const VALUE_CONTEXT =
  /\b(?:prints?|outputs?|returns?|emits?|says?|equals?|contains?|lists?|(?:message|text|argument|value|input|spelling|stderr|stdout)(?:\s+(?:is|of))?)\s*[:=]?\s*$/i;

/** The prefixes that run a tool from the project's environment: `npx`, `uv run`, `python -m`. */
const RUNNER = String.raw`(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn(?:\s+dlx)?|uv\s+run|poetry\s+run|pipenv\s+run|hatch\s+run|pdm\s+run|python3?\s+-m)\s+)?`;
const TOOL = String.raw`(?:pytest|unittest|mypy|ruff|black|isort|flake8|pylint|pyright|tox|nox|tsc|eslint|biome|prettier|vitest|jest|mocha|golangci-lint)\b`;
/**
 * A quoted command of the project's own checks: the test, type check, lint, build or format
 * commands of the usual runners, also run through `npx`, `bunx`, `pnpm exec`, `uv run`,
 * `poetry run` or `python -m` (#1427). The host runs those as checks; a test file does not
 * contain them.
 */
const CHECK_COMMAND = new RegExp(
  `^(?:${[
    String.raw`(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|type-check|lint|build|check|format|fmt)\b`,
    String.raw`(?:cargo|go|dotnet)\s+(?:test|build|vet|clippy|fmt|check|format)\b`,
    String.raw`deno\s+(?:test|lint|fmt|check)\b`,
    String.raw`node\s+--test\b`,
    String.raw`make\s+(?:test|check|lint|build)\b`,
    RUNNER + TOOL,
    String.raw`(?:mvn|mvnw|gradle|gradlew|\.\/gradlew|\.\/mvnw)\b.*\b(?:test|verify|check|build)\b`,
  ].join("|")})`,
);

/** What else decides which quoted literals are cases (#1366). */
type CaseTask = Pick<Task, "criterionIds"> &
  Partial<
    Pick<Task, "id" | "description" | "writes" | "dependsOn" | "sizingSlice" | "rows" | "rowTest">
  >;

export interface CaseContext {
  /** The run's checks: a literal that is one of their commands is checked by the host. */
  checks?: readonly Pick<Check, "executable" | "args">[];
  /** The plan's tasks: a criterion most of them carry is about the whole repository. */
  tasks?: readonly CaseTask[];
  /** Pricing has always counted broad criteria; only the task-end walk exempts them. */
  includeBroad?: boolean;
}

/** Whether a quoted literal is a command of the project's checks rather than a case. */
export function isCheckCommand(literal: string, checks: CaseContext["checks"] = []): boolean {
  const spelled = literal.trim().replace(/\s+/g, " ");
  return (
    CHECK_COMMAND.test(spelled) ||
    checks.some((check) => {
      // A check behind a launcher (`cmd /c mvn verify`) is quoted as the command it runs (#1507).
      const { program, args } = launchedCommand(check.executable, check.args);
      return (
        [check.executable, ...check.args].join(" ") === spelled ||
        [program, ...args].join(" ") === spelled
      );
    })
  );
}

/**
 * The quoted literals of the automated criteria a task covers, each once. A command of the
 * project's checks is not a case, and neither is a literal of a criterion the plan gives to more
 * than half of its tasks (with three or more): md-site 7b362eb4 (bench round 36) refused a front
 * matter property test twice for not containing `bun run typecheck` and `bun run lint`, quoted by
 * a repository-level criterion the plan gave to all six code and test tasks, and the run stopped
 * `invalid_output` after 1.33M tokens (#1366).
 */
export function criterionCases(
  spec: SpecText,
  task: CaseTask,
  context: CaseContext = {},
): CriterionCase[] {
  const cases: CriterionCase[] = [];
  const seen = new Set<string>();
  const sets = closedSets(spec);
  const add = (criterionId: string, literal: string, word?: true) => {
    const key = `${criterionId}:${normalizeLiteral(literal)}`;
    if (seen.has(key) || isCheckCommand(literal, context.checks)) return;
    seen.add(key);
    cases.push({ criterionId, literal, ...(word ? { word } : {}) });
  };
  const tasks = context.tasks ?? [];
  const broad = (id: string): boolean =>
    tasks.length >= 3 && tasks.filter((t) => t.criterionIds.includes(id)).length * 2 > tasks.length;
  for (const criterion of spec.criteria) {
    if (!task.criterionIds.includes(criterion.id) || criterion.method !== "automated") continue;
    for (const [field, text] of [criterion.given, criterion.when, criterion.then].entries()) {
      const table = tableInputs(text);
      for (const match of table.prose.matchAll(QUOTED)) {
        const literal = (match[1] ?? match[2] ?? match[3] ?? "").trim();
        if (
          !literalCase(
            literal,
            match[2] !== undefined,
            VALUE_CONTEXT.test(table.prose.slice(0, match.index)),
          )
        )
          continue;
        add(criterion.id, literal);
      }
      for (const input of table.inputs) add(criterion.id, input);
      for (const member of enumeratedMembers(text, sets, `${criterion.id}:${field}`))
        add(criterion.id, member, true);
    }
  }
  const owned = partitionCases(cases, task, tasks);
  const applicable = owned.filter((c) => {
    const carriers = tasks.filter(
      (t) =>
        t.criterionIds.includes(c.criterionId) &&
        t.writes &&
        writtenTestPaths({ writes: t.writes }).length,
    );
    const scoped =
      task.id &&
      tasks.some((t) => t.id === task.id) &&
      carriers.length > 1 &&
      carriers.some(
        (t) =>
          t.sizingSlice ||
          cases.some(
            (row) =>
              row.criterionId === c.criterionId &&
              !missingCases([row], [t.description ?? ""]).length,
          ),
      );
    return context.includeBroad || !broad(c.criterionId) || scoped;
  });
  return applicable.filter(
    (c, i) =>
      applicable.findIndex(
        (other) => normalizeLiteral(other.literal) === normalizeLiteral(c.literal),
      ) === i,
  );
}

/** Each shared case belongs to one test task. Unclaimed rows go to the last carrier (#1597). */
function partitionCases(
  cases: CriterionCase[],
  task: CaseTask,
  tasks: readonly CaseTask[],
): CriterionCase[] {
  // A corrective or a caller without a plan identity still checks its complete criterion.
  if (!task.id || !tasks.some((t) => t.id === task.id)) return cases;
  const ordered: CaseTask[] = [];
  const visited = new Set<CaseTask>();
  const visit = (t: CaseTask) => {
    if (visited.has(t)) return;
    visited.add(t);
    for (const id of t.dependsOn ?? []) {
      const dependency = tasks.find((other) => other.id === id);
      if (dependency) visit(dependency);
    }
    ordered.push(t);
  };
  for (const t of tasks) visit(t);
  const owners = new Map<CriterionCase, string | undefined>();
  for (const id of new Set(cases.map((c) => c.criterionId))) {
    const carriers = ordered.filter(
      (t) =>
        t.criterionIds.includes(id) && t.writes && writtenTestPaths({ writes: t.writes }).length,
    );
    if (carriers.length < 2 || !carriers.some((t) => t.id === task.id)) continue;
    const rows = cases.filter((c) => c.criterionId === id);
    const sliced = carriers.every(
      (t) => t.sizingSlice && t.sizingSlice.taskId === carriers[0]?.sizingSlice?.taskId,
    );
    const remaining: CriterionCase[] = [];
    for (const row of rows) {
      const named = carriers.filter((t) => !missingCases([row], [t.description ?? ""]).length);
      if (named.length === 1 || (named.length > 1 && !sliced)) owners.set(row, named[0]?.id);
      else remaining.push(row);
    }
    if (sliced) {
      // Shares describe case weight, not literal text. Divide the unnamed rows in plan order.
      const total = carriers.reduce((sum, t) => sum + (t.sizingSlice?.share ?? 0), 0);
      let share = 0;
      let start = 0;
      for (const [index, carrier] of carriers.entries()) {
        share += carrier.sizingSlice?.share ?? 0;
        const end =
          index === carriers.length - 1
            ? remaining.length
            : Math.floor((remaining.length * share) / total);
        for (const row of remaining.slice(start, end)) owners.set(row, carrier.id);
        start = end;
      }
    } else for (const row of remaining) owners.set(row, carriers.at(-1)?.id);
  }
  return cases.filter((c) => !owners.has(c) || owners.get(c) === task.id);
}

/** The parts of a spec that name a closed set: its prose, requirements and criteria. */
export type SpecText = Pick<Spec, "criteria"> &
  Partial<Pick<Spec, "problem" | "outcome" | "inScope" | "assumptions" | "requirements">>;

/** A list member that reads as an identifier of the domain: `bf16`, `e5m2`, `max_len`, `toFixed`. */
const IDENTIFIER = /^[A-Za-z][\w.+-]*$/;
/** The spec's own ids (`AC-001`, `FR-2`) and file names (`test_a.py`) are not cases of a set. */
const NOT_MEMBER = /^[A-Z]{1,4}-?\d+$|\.[A-Za-z]{1,4}$/;
const identifierLike = (word: string): boolean =>
  word.length >= 2 &&
  IDENTIFIER.test(word) &&
  /\d|_|[a-z][A-Z]/.test(word) &&
  !NOT_MEMBER.test(word);
/** "a, b, c", "a, b or c", "a and b": members joined by commas, with an optional last "and" or "or". */
const LIST =
  /(?<![\w.+-])[A-Za-z][\w.+-]*(?:(?:\s*,\s*|\s*,?\s+(?:and|or)\s+)(?:the\s+)?[A-Za-z][\w.+-]*)+/g;
const SPLIT = /\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+/;
const NUMBER_WORDS = [
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];
/** "all six formats", "each of the 4 modes": the count picks the set out. */
const ALL_OF =
  /\b(?:all|each of the|every one of the)\s+(\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+([a-z][\w-]*?)s?\b/gi;

interface ClosedSet {
  members: string[];
  source: string;
  text: string;
}

/** The lists of identifier members in a text; backticks and quotes around a member are dropped. */
function identifierLists(text: string): string[][] {
  const plain = text.replace(/[`"\u201c\u201d']/g, "");
  const lists: string[][] = [];
  for (const match of plain.matchAll(LIST)) {
    const members = match[0]
      .split(SPLIT)
      .map((m) => m.replace(/^the\s+/, "").replace(/[.]+$/, ""))
      .filter(Boolean);
    if (members.length >= 2 && members.every(identifierLike)) lists.push([...new Set(members)]);
  }
  return lists;
}

/**
 * The sets the spec spells out in full, three members or more: "the six formats f16, bf16, f32,
 * f64, e4m3 and e5m2". A criterion that names some of them, or "all six formats", asks for each.
 */
function closedSets(spec: SpecText): ClosedSet[] {
  const sources: [string, string][] = [
    ["problem", spec.problem ?? ""],
    ["outcome", spec.outcome ?? ""],
    ...(spec.inScope ?? []).map((t, i): [string, string] => [`inScope:${i}`, t]),
    ...(spec.assumptions ?? []).map((t, i): [string, string] => [`assumptions:${i}`, t]),
    ...(spec.requirements ?? []).map((r): [string, string] => [r.id, r.text]),
    ...spec.criteria.flatMap((c) =>
      [c.given, c.when, c.then].map((t, i): [string, string] => [`${c.id}:${i}`, t]),
    ),
  ];
  return sources.flatMap(([source, text]) =>
    identifierLists(text)
      .filter((members) => members.length >= 3)
      .map((members) => ({ members, source, text })),
  );
}

/**
 * The members of a closed set a criterion text asks for (#1482): a list of identifiers that the
 * spec spells out as a larger or equal set elsewhere, or "all N <things>" naming one such set.
 * fpbits analysis (bench round 41) left `Steps` untested for bf16, f32 and e5m2 although the
 * criterion named them, and the correction cost 735k tokens.
 */
function enumeratedMembers(text: string, sets: ClosedSet[], source: string): string[] {
  const others = sets.filter((set) => set.source !== source);
  const members: string[] = [];
  for (const list of identifierLists(text))
    if (others.some((set) => list.every((m) => set.members.includes(m)))) members.push(...list);
  for (const match of text.matchAll(ALL_OF)) {
    const word = (match[1] ?? "").toLowerCase();
    const count = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS.indexOf(word) + 2;
    const noun = (match[2] ?? "").toLowerCase();
    if (noun.length < 3) continue;
    const named = sets.filter(
      (set) => set.members.length === count && set.text.toLowerCase().includes(noun),
    );
    const distinct = new Set(named.map((set) => [...set.members].sort().join(",")));
    // Only a set the words pick out alone: two candidate sets leave the criterion to the review.
    if (distinct.size === 1 && named[0]) members.push(...named[0].members);
  }
  return [...new Set(members)];
}

/** The header words of a table's first column, and a separator row's cells. */
const HEADER_CELL =
  /^(?:inputs?|values?|cases?|args?|arguments?|commands?|given|when|expression|query|request)$/i;
const SEPARATOR_CELL = /^:?-{2,}:?$/;

/**
 * Split explicit input spans in the first cell, leaving context words out.
 * Standalone cells still need a concrete literal rather than a scenario label (#1565).
 * Return the remaining cells and prose for the usual quoted-span walk.
 */
function tableInputs(text: string): { inputs: string[]; prose: string } {
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.includes("|"))
    .map((line) => ({
      line,
      cells: line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim()),
    }))
    .filter(({ cells }) => cells.length >= 2);
  if (rows.length < 2) return { inputs: [], prose: text };
  const inputs: string[] = [];
  rows.forEach(({ cells }, index) => {
    if (cells.every((cell) => SEPARATOR_CELL.test(cell))) return;
    const next = rows[index + 1]?.cells;
    if (next?.every((cell) => SEPARATOR_CELL.test(cell))) return;
    const raw = cells[0] ?? "";
    if (HEADER_CELL.test(raw.replace(/^[`"\u201c]|[`"\u201d]$/g, ""))) return;
    const spans = [...raw.matchAll(QUOTED)];
    if (spans.length) {
      for (const span of spans) {
        // A role annotation (`...` as `url`) names the parameter, not another input.
        if (/\bas\s*$/i.test(raw.slice(0, span.index))) continue;
        const literal = (span[1] ?? span[2] ?? span[3] ?? "").trim();
        if (literalCase(literal, span[2] !== undefined, spans.length > 1 || raw !== span[0]))
          inputs.push(literal);
      }
    } else if (literalCase(raw)) inputs.push(raw);
  });
  const tableLines = new Map(rows.map((row) => [row.line, row.cells.slice(1).join(" | ")]));
  return {
    inputs,
    prose: text
      .split(/\r?\n/)
      .map((line) => tableLines.get(line) ?? line)
      .join("\n"),
  };
}

/** Decode one source or JSON escape layer, preserving intentional literal escape text (#1614). */
export function normalizeLiteral(source: string): string {
  return source.replace(
    /\\(?:u\{([\da-fA-F]{1,6})\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|([ntr"'`\\]))/g,
    (
      spelling: string,
      point: string | undefined,
      unicode: string | undefined,
      hex: string | undefined,
      simple: string | undefined,
    ) => {
      const digits = point ?? unicode ?? hex;
      if (digits !== undefined) {
        const value = Number.parseInt(digits, 16);
        return value <= 0x10ffff ? String.fromCodePoint(value) : spelling;
      }
      return simple === "n"
        ? "\n"
        : simple === "t"
          ? "\t"
          : simple === "r"
            ? "\r"
            : (simple ?? spelling);
    },
  );
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEPARATOR = String.raw`[\s"'\x60,()[\]]+`;
/** Keep flags, paths, identifiers and signed numbers; discard grouping syntax and conjunctions. */
const SIGNIFICANT_TOKEN =
  /--?[A-Za-z][\w-]*|[\p{L}_$][\p{L}\p{N}_$]*(?:[./\\-][\p{L}\p{N}_$]+)*|-?\p{N}[\p{L}\p{N}_]*(?:\.\p{N}+)?|[!=<>]=+|[+*%]/gu;

/**
 * Whether one test file holds all significant tokens of a literal, in any order or grouping.
 * Placeholders stand for test-specific values; case and token boundaries still matter.
 */
export function testsHold(text: string, literal: string): boolean {
  const unescaped = normalizeLiteral(text);
  const normalized = normalizeLiteral(literal);
  if (!normalized.replace(PLACEHOLDER, "")) return false;
  const tokens = normalized.replace(PLACEHOLDER, " ").match(SIGNIFICANT_TOKEN) ?? [];
  const significant = tokens.filter((token) => token !== "and" && token !== "or");
  // Keep exact spellings of punctuation-heavy values, including absolute and Windows paths.
  const exact = normalized
    .split(PLACEHOLDER)
    .map((part) =>
      part.trim()
        ? part.split(/\s+/).filter(Boolean).map(escapeRegex).join(SEPARATOR)
        : escapeRegex(part),
    )
    .join("[\\s\\S]*?");
  const held = (pattern: string) =>
    new RegExp(`(?<![\\p{L}\\p{N}_$./-])${pattern}(?![\\p{L}\\p{N}_$./\\\\-])`, "u").test(
      unescaped,
    );
  return (
    held(exact) ||
    (significant.length > 0 && significant.every((token) => held(escapeRegex(token))))
  );
}

/** The cases no text holds. */
export const missingCases = (cases: CriterionCase[], texts: string[]): CriterionCase[] =>
  cases.filter((c) => {
    const word = c.word
      ? new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(c.literal)}(?![A-Za-z0-9_])`)
      : undefined;
    return !texts.some((text) => (word ? word.test(text) : testsHold(text, c.literal)));
  });

/** The test files a task creates or modifies. */
export const writtenTestPaths = (task: Pick<Task, "writes">): string[] =>
  task.writes.filter((w) => w.action !== "delete" && isTestCodePath(w.path)).map((w) => w.path);

/**
 * The check a task's attempt runs before it is accepted: the criteria's cases its test files do
 * not hold, one line each. Undefined when the task writes no test file or its criteria quote
 * nothing.
 */
export function caseCheck(
  spec: SpecText | null | undefined,
  task: CaseTask & Pick<Task, "writes">,
  context: CaseContext = {},
): ((root: string) => Promise<string[]>) | undefined {
  const paths = [
    ...writtenTestPaths(task),
    ...(task.rows?.length && task.rowTest ? [task.rowTest.data] : []),
  ];
  const cases = spec ? criterionCases(spec, task, context) : [];
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
