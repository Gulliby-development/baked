import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { rowDataPaths } from "../workflows/acceptance-rows.js";
import { stripComments } from "../workflows/quality/code-mask.js";
import { isTestCodePath } from "../workflows/quality/duplication.js";
import { propertyTestKind } from "../workflows/quality/properties.js";
import type { Spec } from "../workflows/schemas.js";
import { toolchainCommand } from "../workflows/toolchain.js";
import type { Check, Task } from "../workflows/types.js";
import { caseEvidence } from "./criteria-evidence.js";

/**
 * The cases the criteria spell out, walked against the test files a task wrote (#1250). Bench
 * round 28: leaguetab's tests left out the table case "1, 2=, 2=, 4" and cochange-update's the
 * `--path src/cli` and `--path SRC` no-match cases; a model reviewer was the first to read them,
 * and each correction cost 0.2M to 0.5M tokens. The host now names such a case to the task that
 * writes the tests, inside its attempt.
 *
 * Ownership rules: a criterion the plan gives to most tasks is about the whole repository (#1366);
 * a case shared by several test tasks belongs to one of them (#1597); and a case another task owns
 * is never demanded of this one: text of a document another task writes, a test name a sibling
 * task's description names, or anything a task limited to a few changed lines does not name
 * (#1771, `ownedElsewhere`); nor is a case a test file another task writes already tests (#1886,
 * `siblingTestPaths`).
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
  /** The criterion is a property: a test draws its values from a strategy (#1807). */
  generated?: true;
}

/** Quoted spans: "...", `...` and the typographic double quotes. */
const QUOTED = /"((?:\\[^\n]|[^"\\\n])+)"|`([^`\n]+)`|\u201c([^\u201d\n]+)\u201d/g;
/** A placeholder the test fills with a concrete value: `<file>`, `{name}`, `...`. */
const PLACEHOLDER = /<[^<>\s][^<>]*>|\{[^{}]+\}|\.\.\.|\u2026/g;

/** One quoted span of a criterion text: its literal, whether it is a code span, and where. */
export interface QuotedSpan {
  literal: string;
  /** The span with its quotes. */
  raw: string;
  code: boolean;
  index: number;
}

const DOUBLE_QUOTED = /"((?:\\[^\n]|[^"\\\n])+)"|\u201c([^\u201d\n]+)\u201d/g;

/**
 * The quoted spans of a text, code spans first (#1790). A double quote inside a code span
 * (`` `{"a":1}` ``) is code, never the start of a quoted span, and a line whose backticks do not
 * pair (an odd count, or a span that starts or ends in a space) has no code spans the host can
 * trust, so none are guessed there: R53 jsonsplice paired the closing backtick of one span with the
 * opening one of the next and demanded the prose between.
 */
export function quotedSpans(text: string): QuotedSpan[] {
  const spans: QuotedSpan[] = [];
  let masked = "";
  let offset = 0;
  for (const line of text.split("\n")) {
    const code = [...line.matchAll(/`([^`]+)`/g)];
    // An odd count, or a span that starts or ends in a space (` at character 3`), means the
    // backticks pair across a span: the line's code spans are not guessed.
    const paired =
      (line.match(/`/g) ?? []).length % 2 === 0 &&
      code.every((m) => (m[1] ?? "") === (m[1] ?? "").trim());
    let kept = line;
    if (paired)
      for (const m of code) {
        const at = m.index ?? 0;
        spans.push({ literal: (m[1] ?? "").trim(), raw: m[0], code: true, index: offset + at });
        kept = kept.slice(0, at) + " ".repeat(m[0].length) + kept.slice(at + m[0].length);
      }
    masked += `${kept}\n`;
    offset += line.length + 1;
  }
  for (const match of masked.matchAll(DOUBLE_QUOTED)) {
    const literal = (match[1] ?? match[2] ?? "").trim();
    // A span across a backtick crossed a code span the host could not pair.
    if (!literal.includes("`"))
      spans.push({ literal, raw: match[0], code: false, index: match.index ?? 0 });
  }
  return spans.sort((a, b) => a.index - b.index);
}

/** A requirement or criterion id: `FR-005`, `AC-011`, `NFR-001`. */
const SPEC_ID = /^(?:AC|FR|NFR|SC)-\d{1,6}$/;
/**
 * A name expression of the code under test: `[src, itemIndex]`, `root.items[itemIndex].value`.
 * It has a bracket, names only identifiers and holds no digit or quote, so no test spells it.
 */
const NAME_EXPRESSION =
  /^(?=[^\d"'`]*$)(?=.*\[)(?:\[\s*[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*\s*\]|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\s*[A-Za-z_$][\w$.]*\s*\])*)$/;

/** A pointer or reference type a criterion names: `*base.Error`, `&Config` (#1820). */
const TYPE_REFERENCE = /^[*&]\s*[A-Za-z_]\w*(?:(?:\.|::)[A-Za-z_]\w*)*$/;
/** The shape of a token in prose, made of metavariables: `PARTxCOUNT`, `ROWS:COLS` (#1820). */
const SHAPE_WORDS = /^[A-Z]{2,}(?:[x\u00d7:,/-][A-Z]{2,})+$/;

/**
 * Prose labels are for the reviewer, not strings a test must repeat (#1565), and neither are a
 * spec id or a name expression of the code under test (#1790), nor a type, a field or a function
 * prefix the criterion names to describe the test (#1820, R55 youngkit-update: `*base.Error`,
 * `Msg`, "8 `Test` functions", the token shape `PARTxCOUNT`). A single capitalised word is a case
 * only where the criterion quotes it as a value ("prints `Usage`").
 */
function literalCase(literal: string, code = false, value = false): boolean {
  const concrete = literal.replace(PLACEHOLDER, "");
  if (concrete.replace(/[^\p{L}\p{N}_]/gu, "").length < 2) return false;
  const trimmed = concrete.trim();
  if (SPEC_ID.test(trimmed) || NAME_EXPRESSION.test(trimmed)) return false;
  if (TYPE_REFERENCE.test(trimmed) || SHAPE_WORDS.test(trimmed)) return false;
  return (
    value ||
    /\d|(?:^|\s)--?[A-Za-z]|[=<>:+*%{}[\]]/.test(concrete) ||
    (code && identifierLike(concrete))
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
    // The arguments of a Python check run by an interpreter path: `.venv/bin/python -m ruff` (#1762).
    String.raw`-m\s+` + TOOL,
    String.raw`(?:mvn|mvnw|gradle|gradlew|\.\/gradlew|\.\/mvnw)\b.*\b(?:test|verify|check|build)\b`,
  ].join("|")})`,
);

/** What else decides which quoted literals are cases (#1366). */
type CaseTask = Pick<Task, "criterionIds"> &
  Partial<
    Pick<Task, "id" | "description" | "writes" | "dependsOn" | "sizingSlice" | "rows" | "rowTest">
  >;

export interface CaseContext {
  /**
   * The run's checks: a literal that is one of their commands is checked by the host. Required,
   * so that no caller prices or walks a host command as a case (#1762).
   */
  checks: readonly Pick<Check, "executable" | "args">[];
  /** The plan's tasks: a criterion most of them carry is about the whole repository. */
  tasks?: readonly CaseTask[];
  /** Pricing has always counted broad criteria; only the task-end walk exempts them. */
  includeBroad?: boolean;
  /**
   * The refusal line for a case the source contradicts, or null: with `caseSourceProbe: "on"` the
   * host runs the criterion's command before it refuses the task for its expected output (#1836).
   */
  probe?: (found: CriterionCase, root: string) => Promise<string | null>;
}

/**
 * The spellings a spec may quote for one check: the full command, the command it launches
 * (`cmd /c mvn verify` as `mvn verify`, #1507), and the arguments alone when they name more than a
 * bare subcommand (`-m ruff check .` and `ruff check .` after "python.exe with", #1762).
 */
function checkSpellings(check: Pick<Check, "executable" | "args">): {
  commands: string[][];
  args: string[][];
} {
  const { program, args } = toolchainCommand(check.executable, check.args);
  const tails = [args, ...(args[0] === "-m" ? [args.slice(1)] : [])];
  return {
    commands: [
      [check.executable, ...check.args],
      [program, ...args],
    ],
    args: tails.filter((tail) => tail.length >= 2 || (tail.length === 1 && tail !== args)),
  };
}

/** Whether a quoted literal is a command of the project's checks rather than a case. */
export function isCheckCommand(literal: string, checks: CaseContext["checks"] = []): boolean {
  const spelled = literal.trim().replace(/\s+/g, " ");
  const words = spelled.split(" ");
  // A check quoted with extra flags (`vendor/bin/phpunit --testdox`) is still the check.
  const runs = (command: string[]) =>
    command.length <= words.length &&
    command.every((word, i) => words[i] === word) &&
    words.slice(command.length).every((word) => word.startsWith("-"));
  return (
    CHECK_COMMAND.test(spelled) ||
    checks.some((check) => {
      const { commands, args } = checkSpellings(check);
      return commands.some(runs) || args.some((tail) => tail.join(" ") === spelled);
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
  context: CaseContext,
): CriterionCase[] {
  const cases: CriterionCase[] = [];
  const seen = new Set<string>();
  const sets = closedSets(spec);
  let bound = new Set<string>();
  const add = (criterionId: string, literal: string, word?: true, source = "", expected = "") => {
    const parts = boundFree(literal, bound);
    if (parts) {
      for (const part of parts) add(criterionId, part, word, source, expected);
      return;
    }
    const values = caseValues(literal, source, expected, task);
    if (!values.includes(literal)) {
      for (const value of values) add(criterionId, value, word);
      return;
    }
    const key = `${criterionId}:${normalizeLiteral(literal)}`;
    if (seen.has(key) || isCheckCommand(literal, context.checks)) return;
    seen.add(key);
    const generated = spec.criteria.find((c) => c.id === criterionId)?.property !== undefined;
    cases.push({
      criterionId,
      literal,
      ...(word ? { word } : {}),
      ...(generated ? { generated: true as const } : {}),
    });
  };
  const tasks = context.tasks ?? [];
  const broad = (id: string): boolean =>
    tasks.length >= 3 && tasks.filter((t) => t.criterionIds.includes(id)).length * 2 > tasks.length;
  for (const criterion of spec.criteria) {
    if (!task.criterionIds.includes(criterion.id) || criterion.method !== "automated") continue;
    bound = boundLabels(`${criterion.given}\n${criterion.when}`);
    for (const [field, text] of [criterion.given, criterion.when, criterion.then].entries()) {
      const table = tableInputs(text);
      for (const span of quotedSpans(table.prose)) {
        const before = table.prose.slice(0, span.index);
        if (!literalCase(span.literal, span.code, VALUE_CONTEXT.test(before))) continue;
        add(criterion.id, span.literal, undefined, before, criterion.then);
      }
      for (const input of table.inputs)
        add(criterion.id, input.literal, undefined, input.source, input.expected);
      for (const member of enumeratedMembers(text, sets, `${criterion.id}:${field}`))
        add(criterion.id, member, true);
    }
  }
  const elsewhere = ownedElsewhere(spec, task, tasks);
  const owned = partitionCases(cases, task, tasks).filter((c) => !elsewhere(c));
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

/** A label: `E4`, `DOC1`, `row_2`, or an all-capitals name such as `DOC`. */
const LABEL = String.raw`(?:[A-Za-z][A-Za-z_]*\d+|[A-Z]{2,}\d*)`;
/** A run of labels: "E1 through E9", "E1..E9", "E1-E9", "E1 to E9". */
const LABEL_RANGE = /\b([A-Za-z][A-Za-z_]*)(\d+)\s*(?:through|thru|to|\.\.|-|\u2013)\s*\1(\d+)\b/g;
/** A label the text defines: "DOC1 is the document", "DOC1 = <ul>...", "a document called DOC1". */
const LABEL_DEFINED = new RegExp(
  String.raw`\b(${LABEL})\s*(?:is|are|=|:=|denotes|refers to|stands for)\b|\b(?:called|named|labell?ed)\s+[\x60"']?(${LABEL})\b`,
  "g",
);

/**
 * The labels a criterion's Given or When binds to values the test builds (#1663): the elements
 * "E1 through E9" of a document, "DOC1 is the document". A test reaches them by index or by a
 * variable of its own, so they are not literals it must spell. R50 selwhy refused 8 of 24 test
 * tasks, 61 items, for such labels.
 */
function boundLabels(text: string): Set<string> {
  const labels = new Set<string>();
  for (const match of text.matchAll(LABEL_RANGE)) {
    const from = Number(match[2]);
    const to = Number(match[3]);
    if (to < from || to - from > 100) continue;
    for (let n = from; n <= to; n++) labels.add(`${match[1]}${n}`);
  }
  for (const match of text.matchAll(LABEL_DEFINED)) labels.add(match[1] ?? match[2] ?? "");
  labels.delete("");
  return labels;
}

/** A call expression: `Position("nth-child", E4)`, `Select(Parse("b, a"), doc)`. */
const EXPRESSION = /^[A-Za-z_][\w.:]*!?\s*\([\s\S]*\)$/;
const ARG_NUMBER = /(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g;
/** A list literal of numbers and strings only. */
const ARG_LIST =
  /\[\s*(?:-?\d+(?:\.\d+)?|"[^"\n]*"|'[^'\n]*')(?:\s*,\s*(?:-?\d+(?:\.\d+)?|"[^"\n]*"|'[^'\n]*'))*\s*\]/g;

/**
 * The literals a test must hold for a case that is an expression or names bound labels, or null
 * when the case stands as written (#1663). An expression asks for its literal arguments, the
 * quoted strings and numbers, not its spelling; a bound label is left out.
 */
function boundFree(literal: string, bound: ReadonlySet<string>): string[] | null {
  const text = literal.trim();
  if (EXPRESSION.test(text)) {
    // A list of values is one argument: `Join([3,0,-2])` asks for `[3,0,-2]`.
    const lists = [...text.matchAll(ARG_LIST)].map((m) => m[0]);
    const rest = text.replace(ARG_LIST, " ");
    const strings = [...rest.matchAll(QUOTED)].map((m) => (m[1] ?? m[2] ?? m[3] ?? "").trim());
    const numbers = [...rest.replace(QUOTED, " ").matchAll(ARG_NUMBER)].map((m) => m[0]);
    return [...lists, ...strings, ...numbers].filter((value) => literalCase(value, true, true));
  }
  if (!bound.size) return null;
  const words = text.split(/(\s+)/);
  const kept = words.filter((word) => !bound.has(word.replace(/^[\x60"'(]+|[\x60"'),.;:]+$/g, "")));
  if (kept.length === words.length) return null;
  const rest = kept.join("").replace(/\s+/g, " ").trim();
  return rest.replace(/[^\p{L}\p{N}_]/gu, "").length >= 2 ? [rest] : [];
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

/**
 * A project document a criterion can describe: a README, changelog or usage guide, or a page under
 * `docs/`. Input files a test reads (`content/post.md`, `input.txt`) are not documents here.
 */
const DOCUMENT =
  /(?<![\w./-])((?:[\w.-]+\/)*(?:README|CHANGELOG|CONTRIBUTING|USAGE|HISTORY)(?:\.[A-Za-z]{1,8})?|(?:[\w.-]+\/)*docs?\/(?:[\w.-]+\/)*[\w.-]+\.(?:md|mdx|markdown|rst|adoc|txt))(?![\w/-])/gi;
/**
 * A description that limits the edit: "change exactly three lines", "edit only 2 existing lines",
 * "touch nothing else". An edit verb is required, so "prints only one line" is not a limit.
 */
const RESTRICTED_EDIT = new RegExp(
  String.raw`\b(?:chang|edit|modif|updat|touch|replac|rewrit)\w*\s+(?:(?:exactly|only|at most)\s+(?:\d+|one|${NUMBER_WORDS.join("|")})\s+(?:[a-z]+\s+)?lines?\b|nothing else\b)`,
  "i",
);

/** Whether a written path is the document a criterion names; a bare `README` is any README. */
const sameFile = (written: string, named: string): boolean => {
  const a = written.replaceAll("\\", "/").toLowerCase();
  const b = named.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  const stem = b.includes(".")
    ? undefined
    : new RegExp(`(?:^|/)${escapeRegex(b)}(?:\\.[a-z]{1,8})?$`);
  return a === b || a.endsWith(`/${b}`) || (stem?.test(a) ?? false);
};

/**
 * The cases another planned task owns (#1771), which this task's walk must not demand. Bench round
 * 52, grundykit T006 ("change exactly three lines and nothing else" in two test files) was refused
 * for fragments of a README paragraph and for test names that sibling tasks write; it added them,
 * the review flagged the extra lines, and a corrective reverted them (258k tokens). A case is owned
 * elsewhere when its criterion's Given or When describes a document this task does not write and
 * another task does; when it is an identifier another test-writing task's description names and
 * this one's does not; or when this task's description limits the edit and does not name it.
 */
function ownedElsewhere(
  spec: SpecText,
  task: CaseTask,
  tasks: readonly CaseTask[],
): (c: CriterionCase) => boolean {
  const own = task.description ?? "";
  const others = tasks.filter((t) => t !== task && (!task.id || t.id !== task.id));
  const writes = (t: CaseTask, path: string) =>
    (t.writes ?? []).some((w) => w.action !== "delete" && sameFile(w.path, path));
  const documented = new Set(
    spec.criteria
      .filter((criterion) =>
        [...`${criterion.given}\n${criterion.when}`.matchAll(DOCUMENT)].some((match) => {
          const path = match[1] ?? "";
          return !writes(task, path) && others.some((t) => writes(t, path));
        }),
      )
      .map((criterion) => criterion.id),
  );
  const restricted = RESTRICTED_EDIT.test(own);
  const named = (c: CriterionCase, text: string) =>
    !missingCases([{ ...c, word: true }], [text]).length;
  return (c) =>
    documented.has(c.criterionId) ||
    (restricted && !named(c, own)) ||
    (identifierLike(c.literal) &&
      !named(c, own) &&
      others.some(
        (t) =>
          t.writes &&
          writtenTestPaths({ writes: t.writes }).length &&
          named(c, t.description ?? ""),
      ));
}

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
function tableInputs(text: string): {
  inputs: { literal: string; source: string; expected: string }[];
  prose: string;
} {
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
  const inputs: { literal: string; source: string; expected: string }[] = [];
  rows.forEach(({ cells }, index) => {
    if (cells.every((cell) => SEPARATOR_CELL.test(cell))) return;
    const next = rows[index + 1]?.cells;
    if (next?.every((cell) => SEPARATOR_CELL.test(cell))) return;
    const raw = cells[0] ?? "";
    const push = (literal: string, source = "") =>
      inputs.push({ literal, source, expected: cells.slice(1).join(" ") });
    if (HEADER_CELL.test(raw.replace(/^[`"\u201c]|[`"\u201d]$/g, ""))) return;
    if (/^[A-Za-z_]\w*\s*=(?!=)/.test(raw)) {
      push(raw);
      return;
    }
    const spans = quotedSpans(raw);
    if (spans.length) {
      for (const span of spans) {
        // A role annotation (`...` as `url`) names the parameter, not another input.
        if (/\bas\s*$/i.test(raw.slice(0, span.index))) continue;
        if (literalCase(span.literal, span.code, spans.length > 1 || raw !== span.raw))
          push(span.literal, raw.slice(0, span.index));
      }
    } else if (literalCase(raw)) push(raw);
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

/** Scope and coverage requirements are not test inputs. Assignments name their values (#1629). */
function caseValues(literal: string, source: string, expected: string, task: CaseTask): string[] {
  const sentence = source.split(/[.!?\n]/).at(-1) ?? "";
  const valueContext = VALUE_CONTEXT.test(source);
  if (!valueContext && /^\d+$/.test(literal) && /\b(?:at least|minimum|count)\b/i.test(sentence))
    return [];
  if (/\b(?:at least|minimum|count)\b[^\n]*\d+[^\n]*\btests?\b/i.test(literal)) return [];
  const path = literal.replace(/\\/g, "/").replace(/^\.\//, "");
  const paths = path.split(/\s*[,;]\s*/);
  if (
    !valueContext &&
    paths.every(
      (p) =>
        task.writes?.some((w) => w.path.replace(/\\/g, "/") === p) ||
        /^(?:\.?\.?\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]\w*$/.test(p),
    )
  )
    return [];
  const assignments = [...literal.matchAll(/(?:^|[,;]\s*)([A-Za-z_]\w*)\s*=\s*(?!=)/g)];
  if (assignments[0]?.index === 0) {
    return assignments.flatMap((match, index) => {
      const key = match[1] ?? "";
      const value = literal
        .slice(match.index + match[0].length, assignments[index + 1]?.index)
        .trim();
      // A field/value expectation can be asserted as a property without spelling `field=value`.
      if (new RegExp(`\\b${key}\\b`).test(expected) && /^(?:true|false|\d+)$/.test(value))
        return [];
      return literalCase(value, true, true) ? [value] : [];
    });
  }
  return [literal];
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

/**
 * A decoded criterion literal decoded once more when it still holds `\n`, `\t` or `\r` and no
 * other escape: R57 front T003 quoted an output block as `STEP  ACTION\\n0`, the host message's
 * own escaping of a line break (#1846). The test may hold either spelling.
 */
function decodedTwice(once: string): string {
  return /\\[ntr]/.test(once) && !RAW_ESCAPE.test(once.replace(/\\[ntr]/g, ""))
    ? normalizeLiteral(once)
    : once;
}

/**
 * Adjacent string literals and the elements of a list of strings, joined as the program sees
 * them: `"a\n" + "b"` becomes `a` and `b` on two lines, `["x", "y"]` two lines `x` and `y`.
 */
function joinedStrings(unescaped: string): string {
  return unescaped
    .replace(/(["'`])[ \t]*,[ \t]*\r?\n?[ \t]*(?:[@$]|[rbfu]{1,2})?\1/gi, "\n")
    .replace(
      /(["'`])[ \t]*(?:\+|\.|\.\.)?[ \t]*\r?\n?[ \t]*(?:\+|\.|\.\.)?[ \t]*(?:[@$]|[rbfu]{1,2})?\1/gi,
      "",
    );
}

/**
 * Whether a test holds a multi-line literal (#1846), or null for a single line: every line, in
 * order and next to each other, in the test's text or in its strings joined. R57 foundation T013
 * left out the middle line of `f 0644 a\n# c\nf 0600 a` and the walk accepted it, since each
 * token occurred somewhere in the file.
 */
function linesHeld(unescaped: string, literal: string): boolean | null {
  const lines = literal
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const placeholder = new RegExp(PLACEHOLDER.source);
  if (lines.length < 2 || lines.some((line) => placeholder.test(line))) return null;
  const pattern = new RegExp(
    lines
      .map((line) => line.split(/\s+/).map(escapeRegex).join("[ \\t]+"))
      .join("[ \\t]*\\r?\\n[ \\t]*"),
  );
  return pattern.test(unescaped) || pattern.test(joinedStrings(unescaped));
}

/** A row in tuple notation: `(6,d,1777,0777,"/tmp")`, three cells or more. */
const TUPLE = /^\(([^()]*,[^()]*,[^()]*)\)$/;

/**
 * Whether a test holds a row in the criterion's tuple notation (#1846), or null for another
 * literal: its cells in order within one statement or table line of the test (`InlineData(6,
 * "d", 1777, ...)`, `(6, 'd', 1777, ...)`, `"6  d  1777  0777  /tmp"`). R57 modeplan wrote the
 * rows as a table and the tuple only in a comment.
 */
function rowHeld(unescaped: string, literal: string): boolean | null {
  const body = TUPLE.exec(literal)?.[1];
  if (body === undefined) return null;
  const cells = [...body.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^,]+)/g)]
    .map((m) => (m[1] ?? m[2] ?? m[3] ?? "").trim())
    .filter(Boolean);
  if (cells.length < 3) return null;
  const cell = (value: string) => `(?<![\\p{L}\\p{N}_])${escapeRegex(value)}(?![\\p{L}\\p{N}_])`;
  // Within one statement: no blank line and no `;` between two cells, at most a few lines apart.
  const between = String.raw`(?:(?!\n[ \t]*\n)[^;]){0,240}?`;
  const pattern = new RegExp(cells.map(cell).join(between), "u");
  return pattern.test(unescaped) || pattern.test(joinedStrings(unescaped));
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A backslash before a character no escape layer decodes: `\1`, `\!`, `\0`. */
const RAW_ESCAPE = /\\[^ntr"'`\\ux]/;
const SEPARATOR = String.raw`[\s"'\x60,()[\]]+`;
/** Keep flags, paths, identifiers and signed numbers; discard grouping syntax and conjunctions. */
const SIGNIFICANT_TOKEN =
  /--?[A-Za-z][\w-]*|[\p{L}_$][\p{L}\p{N}_$]*(?:[./\\-][\p{L}\p{N}_$]+)*|-?\p{N}[\p{L}\p{N}_]*(?:\.\p{N}+)?|[!=<>]=+|[+*%]/gu;

/**
 * Whether one test file holds all significant tokens of a literal, in any order or grouping.
 * Placeholders stand for test-specific values; case and token boundaries still matter.
 */
export function testsHold(text: string, literal: string): boolean {
  const once = normalizeLiteral(literal);
  const twice = decodedTwice(once);
  return holds(text, literal, once) || (twice !== once && holds(text, literal, twice));
}

function holds(text: string, literal: string, decoded: string): boolean {
  const unescaped = normalizeLiteral(text);
  const normalized = metavariables(decoded);
  if (referenceHeld(text, unescaped, normalized.trim())) return true;
  const structured = structuredHeld(text, literal.trim(), normalized.trim());
  if (structured !== null) return structured;
  // A row in the criterion's tuple notation, a multi-line text: held as a whole, not by tokens
  // spread over the file (#1846).
  const row = rowHeld(unescaped, normalized.trim());
  if (row !== null) return row;
  // A literal with an escape no decoding layer knows is raw escape text, matched below (#1709).
  const lines = RAW_ESCAPE.test(literal) ? null : linesHeld(unescaped, normalized);
  if (lines !== null) return lines;
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
    (HEX_BYTES.test(normalized.trim()) && bytesHeld(text, normalized)) ||
    // A literal with an escape no decoding layer knows (`\1`, `\!`, `\0` in
    // `s/(a)/&\1\n\t\!\0/`) is raw escape text, as a C#, Java, Go or JavaScript string spells it
    // with every backslash doubled: decoding `\n` on the literal's side only would miss it (#1709).
    (RAW_ESCAPE.test(literal) &&
      text.replace(/\\/g, "").includes(literal.replace(/\\/g, "").trim())) ||
    // Formatters change whitespace and quote style inside lists and expressions.
    (/[[\](]/.test(normalized) && testsHoldCompact(unescaped, normalized)) ||
    (significant.length > 0 && significant.every((token) => held(escapeRegex(token))))
  );
}

/**
 * The upper-case metavariables of a usage line or message: `--baseline FILE <dir>`, `wrote 1
 * finding to FILE`. A test passes a temporary path where the criterion says FILE, so they are
 * placeholders like `<dir>` (#1807): an upper-case word after a flag or a preposition, unless
 * the literal is nothing else.
 */
const METAVARIABLE =
  /(?<=(?:(?:^|\s)--?[A-Za-z][\w-]*|\b(?:to|from|into|in|at|of|for|with))\s+)(?:FILES?|DIR|DIRECTORY|PATH|NAME|URL|NUM|COUNT|VALUE|KEY|PORT|HOST|PATTERN|ARGS?)(?![\w>}-])/g;
function metavariables(literal: string): string {
  const marked = literal.replace(METAVARIABLE, (word) => `<${word}>`);
  return marked.replace(PLACEHOLDER, "").replace(/[^\p{L}\p{N}_]/gu, "") ? marked : literal;
}

/**
 * A qualified test or member name: a `Class.method` (camelCase, PascalCase or snake_case member,
 * so `README.md` and `config.yaml` stay paths), a Rust `module::test`, a Go `TestX/subtest`.
 */
function qualifiedName(literal: string): string[] | null {
  const ident = String.raw`[A-Za-z_$][\w$]*`;
  if (new RegExp(`^${ident}(?:::${ident})+$`).test(literal)) return literal.split("::");
  if (/^Test[A-Z_]\w*(?:\/[\w-]+)+$/.test(literal)) return literal.split("/");
  if (!new RegExp(`^[A-Z][\\w$]*(?:\\.${ident})+$`).test(literal)) return null;
  const parts = literal.split(".");
  const member = parts.at(-1) ?? "";
  return /[a-z][A-Z]|_|^[A-Z][a-z]/.test(member) && member.length >= 3 ? parts : null;
}
/** A regex a test writes as its own literal, anchored or with a class or escape: `^[a-z]{7}$`. */
const PATTERN_LITERAL = /^\^.*\$$|^\^.*[[\\]|[[\\].*\$$/;
/** A base URL a test extends with a path: `https://sho.rt/`. */
const URL_BASE = /^[a-z][a-z\d+.-]*:\/\/[^\s/]+(?:\/[^\s]*)?\/$/i;

/**
 * A literal that names something a test spells in parts or extends (#1807): a qualified test name
 * is held by its last two segments as words (R54 propdrift `PropdriftTest.validates...`: a JUnit
 * class and its method, likewise a C# `Class.Method`, a Rust `module::test`, a Go `TestX/sub`); a
 * regex by its body, which a test writes inside `/.../` or a raw string; a base URL by any URL it
 * begins.
 */
function referenceHeld(text: string, unescaped: string, literal: string): boolean {
  const qualified = qualifiedName(literal);
  if (qualified) {
    const segments = qualified.slice(-2);
    return segments.every((segment) =>
      new RegExp(`(?<![\\w$])${escapeRegex(segment)}(?![\\w$])`).test(unescaped),
    );
  }
  if (PATTERN_LITERAL.test(literal)) {
    const body = literal.replace(/^\^/, "").replace(/\$$/, "");
    return body.length >= 3 && (text.includes(body) || unescaped.includes(body));
  }
  if (URL_BASE.test(literal)) return unescaped.includes(literal);
  return false;
}

/**
 * The scalar leaves of a JSON value that holds a string or an object: `{"op":"params","segs":
 * [{"Lit":"a"}]}` gives `params` and `a`, `[2,"","no such route"]` gives `2` and `no such route`.
 * Null for anything else, a list of numbers among them, which keeps its own spelling. An object
 * with no non-empty string leaf is held by its keys and an empty string instead (#1846, R57
 * foundation `{"flags":[],"values":{"--umask":""},"args":[]}`): there the keys are the content.
 */
const EMPTY_STRING = Symbol("empty string");
function jsonLeaves(literal: string): (string | number | typeof EMPTY_STRING)[] | null {
  if (!/^[[{"]/.test(literal)) return null;
  let value: unknown;
  try {
    value = JSON.parse(literal);
  } catch {
    return null;
  }
  const leaves: (string | number)[] = [];
  const keys: string[] = [];
  let structured = false;
  let empty = false;
  const walk = (node: unknown) => {
    if (typeof node === "string") {
      structured = true;
      if (node.trim()) leaves.push(node);
      else empty = true;
    } else if (typeof node === "number") leaves.push(node);
    else if (Array.isArray(node)) for (const item of node) walk(item);
    else if (node && typeof node === "object") {
      structured = true;
      for (const [key, item] of Object.entries(node)) {
        if (key.trim()) keys.push(key);
        walk(item);
      }
    }
  };
  walk(value);
  if (!structured) return null;
  if (leaves.some((leaf) => typeof leaf === "string")) return leaves;
  const named = [...keys, ...leaves];
  return named.length ? (empty ? [...named, EMPTY_STRING] : named) : null;
}

/** An HTTP request line: `GET /links/test_1/stats`. */
const REQUEST_LINE = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\/\S*)$/;
/** An HTTP header line: `Location: https://example.com/a`, `Content-Type: text/plain`. */
const HEADER_LINE =
  /^((?:[A-Z][a-z]*-)+[A-Z][A-Za-z]*|Location|Allow|Vary|ETag|Host|Accept|Authorization|Cookie|Server|Link|Expires|Age|Refresh):\s*(\S.*)$/;

/**
 * A case a test holds in its own structure (#1820), or null when the literal is none of these. A
 * JSON value is held by its scalar leaves, since a test builds it with constructors (R55
 * routeshadow, Rust: `{"op":"subset","x":{"Lit":"a"},...}` as `subset(&Seg::Lit("a".into()), ...)`;
 * its keys and punctuation are the spec's notation). A request line is held by its path and, for
 * any method but GET, the method; a header line by its value and its name in any letter case
 * (`res.headers.get("location")`).
 */
function structuredHeld(text: string, literal: string, normalized: string): boolean | null {
  const leaves = jsonLeaves(literal);
  if (leaves)
    return leaves.every((leaf) =>
      leaf === EMPTY_STRING
        ? /""|''|\bString\.Empty\b|\bstring\.Empty\b|\bString::new\(\)|\bstr\(\)/.test(text)
        : typeof leaf === "number"
          ? new RegExp(`(?<![\\w.])${escapeRegex(String(leaf))}(?![\\w.])`).test(text)
          : // A name leaf may follow a type (`Ty.Int`, `Ty::Int`) or take the language's case (`Params`).
            (/^[A-Za-z_]\w*$/.test(leaf) &&
              new RegExp(`(?<![\\w$])${escapeRegex(leaf)}(?![\\w$])`, "i").test(text)) ||
            testsHold(text, leaf),
    );
  const request = REQUEST_LINE.exec(normalized);
  if (request)
    return (
      // The test joins the path to a base URL: `new Request("http://localhost/test_1")`.
      new RegExp(`${escapeRegex(request[2] ?? "")}(?![\\w./-])`).test(normalizeLiteral(text)) &&
      (request[1] === "GET" || new RegExp(`\\b${request[1]}\\b`, "i").test(text))
    );
  const header = HEADER_LINE.exec(normalized);
  if (header)
    return (
      new RegExp(escapeRegex(header[1] ?? ""), "i").test(text) && testsHold(text, header[2] ?? "")
    );
  return null;
}

/**
 * Whether a test holds a command line by its arguments (#1820, R55 youngkit-update: `youngkit rank
 * 4,3x2,1` where the Go test calls `run([]string{"rank", "4,3x2,1"})`): the first word is the
 * project's own program, which a test of the entry function never names.
 */
function programHeld(text: string, literal: string, programs: ReadonlySet<string>): boolean {
  const [first, ...rest] = normalizeLiteral(literal).trim().split(/\s+/);
  return Boolean(first && programs.has(first) && rest.length && testsHold(text, rest.join(" ")));
}

/**
 * The names a project's own program goes by, from its manifests: the Cargo package and its bins,
 * the Go module's last path segment, the npm package and its bins, the Python project and its
 * scripts, the Maven artifact, the Gradle root project, the .NET project files.
 */
export async function programNames(root: string): Promise<Set<string>> {
  const read = (path: string) => readFile(join(root, path), "utf8").catch(() => "");
  const names = new Set<string>();
  const add = (name: string | undefined) => {
    const base = name?.trim().split("/").at(-1);
    if (base && /^[\w.-]+$/.test(base)) names.add(base);
  };
  const [cargo, gomod, npm, pyproject, pom, gradle, gradleKts] = await Promise.all([
    read("Cargo.toml"),
    read("go.mod"),
    read("package.json"),
    read("pyproject.toml"),
    read("pom.xml"),
    read("settings.gradle"),
    read("settings.gradle.kts"),
  ]);
  for (const m of cargo.matchAll(/^\s*name\s*=\s*"([^"]+)"/gm)) add(m[1]);
  add(/^module\s+(\S+)/m.exec(gomod)?.[1]);
  try {
    const manifest = JSON.parse(npm || "{}") as {
      name?: string;
      bin?: string | Record<string, string>;
    };
    add(manifest.name);
    if (manifest.bin && typeof manifest.bin === "object")
      for (const key of Object.keys(manifest.bin)) add(key);
  } catch {}
  add(/^\s*name\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1]);
  const scripts = /^\[project\.scripts\]([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(pyproject)?.[1] ?? "";
  for (const m of scripts.matchAll(/^\s*"?([\w.-]+)"?\s*=/gm)) add(m[1]);
  add(
    /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(
      pom.replace(/<parent>[\s\S]*?<\/parent>/, ""),
    )?.[1],
  );
  add(/rootProject\.name\s*=\s*["']([^"']+)["']/.exec(gradle + gradleKts)?.[1]);
  for (const dir of ["", "src/"]) {
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries)
      if (entry.isFile() && entry.name.endsWith(".csproj"))
        add(entry.name.slice(0, -".csproj".length));
      else if (
        dir === "src/" &&
        entry.isDirectory() &&
        existsSync(join(root, dir, entry.name, `${entry.name}.csproj`))
      )
        add(entry.name);
  }
  return names;
}

/**
 * Whether a property test holds a case whose values its strategies draw (#1807, R54 expenses-py:
 * `2024-01-02`, `--from 2024-01-02`, `--category fOoD`): every flag of the literal is in the file,
 * and every other word is, in any letter case; dates and numbers are generated.
 */
function propertyHeld(text: string, literal: string): boolean {
  const tokens = normalizeLiteral(literal).match(SIGNIFICANT_TOKEN) ?? [];
  const words = tokens.filter((t) => !/^-?\p{N}/u.test(t) && t !== "and" && t !== "or");
  return words.every((t) =>
    new RegExp(
      `(?<![\\p{L}\\p{N}_-])${escapeRegex(t)}(?![\\p{L}\\p{N}_-])`,
      t.startsWith("-") ? "u" : "iu",
    ).test(text),
  );
}

/** Spaced hex bytes, as a criterion describes binary input: `7B FF 0A`. */
const HEX_BYTES = /^[\da-f]{2}(?:[\s,]+[\da-f]{2})+$/i;
const BYTE_ESCAPES: Record<string, string> = {
  "09": "\\\\t",
  "0a": "\\\\n",
  "0d": "\\\\r",
  "00": "\\\\0",
};

/**
 * Whether a test holds spaced hex bytes the way its toolchain spells them (#1790): `0x7b, 0xff`
 * in TypeScript, Go, Rust, C#, Java and Kotlin (also with `(byte)` casts and `.toByte()`),
 * `\x7b\xff\n` (or `{\xff\n`) in a Python or Rust byte string, decimal values in a list, or one
 * hex string such as `"7bff0a"`.
 */
function bytesHeld(text: string, literal: string): boolean {
  const bytes = literal
    .trim()
    .split(/[\s,]+/)
    .map((b) => b.toLowerCase());
  const one = (b: string) =>
    `(?:0x0*${b}\\b|\\\\x${b}|${Number.parseInt(b, 16)}\\b${BYTE_ESCAPES[b] ? `|${BYTE_ESCAPES[b]}` : ""})`;
  const between = String.raw`(?:[\s,]|\(\s*(?:byte|u8)\s*\)|\.to(?:U)?Byte\(\))*`;
  const listed = new RegExp(`(?<![\\w.])${bytes.map(one).join(between)}`, "i");
  // A byte string may mix printable characters with escapes (`b"{\xff\n"` for 7B FF 0A).
  const decoded = bytes.map((b) => String.fromCharCode(Number.parseInt(b, 16))).join("");
  const compact = bytes.join("");
  return (
    listed.test(text) ||
    normalizeLiteral(text).includes(decoded) ||
    (bytes.length >= 3 && new RegExp(compact, "i").test(text.replace(/[\s_]/g, ""))) ||
    new RegExp(`["']${compact}["']`, "i").test(text)
  );
}

function testsHoldCompact(text: string, literal: string): boolean {
  const compact = (value: string) => value.replace(/[\s"'`]/g, "");
  return new RegExp(
    `(?<![\\p{L}\\p{N}_$./-])${escapeRegex(compact(literal))}(?![\\p{L}\\p{N}_$./\\\\-])`,
    "u",
  ).test(compact(text));
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
  context: CaseContext,
): ((root: string) => Promise<string[]>) | undefined {
  const paths = [...writtenTestPaths(task), ...rowDataPaths(task)];
  const cases = spec ? criterionCases(spec, task, context) : [];
  if (!paths.length || !cases.length) return undefined;
  const siblings = siblingTestPaths(task, context.tasks ?? [], paths);
  return async (root) => {
    const programs = await programNames(root);
    const read = (list: readonly string[]) =>
      Promise.all(
        list.map(async (path) => {
          const text = await readFile(join(root, path), "utf8").catch(() => "");
          return {
            text,
            code: stripComments(path, text),
            evidence: caseEvidence(path, text),
            // A fallback that fakes the library draws nothing.
            property: ![null, "shim"].includes(propertyTestKind(path, text)),
          };
        }),
      );
    type Read = Awaited<ReturnType<typeof read>>;
    const unheld = (list: CriterionCase[], files: Read) =>
      missingCases(
        list,
        files.map((file) => file.evidence),
      ).filter(
        (c) =>
          !files.some(
            (file) =>
              ((file.property || c.generated) && propertyHeld(file.evidence, c.literal)) ||
              programHeld(file.evidence, c.literal, programs),
          ),
      );
    const files = await read(paths);
    let missing = unheld(cases, files);
    // A case a sibling's test file already tests is not demanded again (#1886).
    if (missing.length && siblings.length) {
      const others = await read(siblings);
      const open = new Set(unheld(missing, others));
      missing = missing.filter((c) => open.has(c));
    }
    return Promise.all(
      missing.map(
        async (c) =>
          (await context.probe?.(c, root)) ??
          (missingCases(
            [c],
            files.map((file) => file.text),
          ).length
            ? `${c.criterionId} names ${JSON.stringify(c.literal)}, and no test file this task writes (${paths.join(", ")}) contains it.`
            : missingCases(
                  [c],
                  files.map((file) => file.code),
                ).length
              ? `${c.criterionId} names ${JSON.stringify(c.literal)}, found only in a comment in ${paths.join(", ")}. A comment tests nothing: use it as a test input or expected value.`
              : `${c.criterionId} names ${JSON.stringify(c.literal)}, found only in an assertion message in ${paths.join(", ")}. Use it as a test input or expected value; the message alone is a decoy.`),
      ),
    );
  };
}

/**
 * The test files the plan's other tasks write, and their host-written row data (#1886). A case one
 * of them already tests, by the
 * same evidence as the task's own files (comments and assertion messages do not count), is held:
 * R57 expenses-py T009 was refused for six CLI argument strings that T007's `tests/test_cli.py`
 * tested (about 435k tokens after the refusal), md-site T009 for four URL schemes the sibling
 * property test drew, url-shortener T004 for a code its sibling test spelled. The file must exist
 * in the attempt's workspace; one a sibling has not written yet holds nothing.
 */
function siblingTestPaths(
  task: CaseTask,
  tasks: readonly CaseTask[],
  own: readonly string[],
): string[] {
  const mine = new Set(own);
  const paths = new Set<string>();
  for (const other of tasks) {
    if (other === task || (task.id !== undefined && other.id === task.id)) continue;
    // The host-written row data of a rows task holds its cases, as the task's own does.
    for (const path of [
      ...(other.writes ? writtenTestPaths({ writes: other.writes }) : []),
      ...rowDataPaths(other),
    ])
      if (!mine.has(path)) paths.add(path);
  }
  return [...paths];
}

/** What a review finding says it is about, as a corrective's case walk reads it. */
export interface RepairFinding {
  criterionIds?: unknown;
  requirementIds?: unknown;
  file?: unknown;
}

/**
 * The criteria whose cases a corrective owes: the ones its findings name, by criterion, by
 * requirement or, for a finding that names neither, by the planned tasks that write the file it
 * names (#1790). A repair of a whole
 * feature carries every criterion, and R53 jsonsplice T010, correcting one offset bug, was refused
 * for the rows of a parser slice it never touched. A corrective whose findings name none of its
 * criteria keeps them all.
 */
export function repairCaseTask<T extends Pick<Task, "criterionIds">>(
  task: T,
  findings: readonly RepairFinding[],
  spec: SpecText | null | undefined,
  tasks: readonly Pick<Task, "origin" | "writes" | "criterionIds">[],
): T {
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const named = new Set<string>();
  for (const finding of findings) {
    for (const id of list(finding.criterionIds)) named.add(id);
    const requirements = list(finding.requirementIds);
    for (const criterion of spec?.criteria ?? [])
      if (criterion.requirementIds.some((id) => requirements.includes(id))) named.add(criterion.id);
    const file = typeof finding.file === "string" ? finding.file.replaceAll("\\", "/") : undefined;
    // The file is a fallback: a shared file's writers carry criteria the finding is not about.
    if (file && !list(finding.criterionIds).length && !requirements.length)
      for (const planned of tasks)
        if (planned.origin === "planned" && planned.writes.some((w) => w.path === file))
          for (const id of planned.criterionIds) named.add(id);
  }
  const owned = task.criterionIds.filter((id) => named.has(id));
  return owned.length ? { ...task, criterionIds: owned } : task;
}
