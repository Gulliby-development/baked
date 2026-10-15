/**
 * Class sweep for robustness findings (#1160). Reviewers report the first reproduced case of an
 * input-robustness defect, and its correction repairs that one site: cfgtrace a657dc4d got a
 * 5,000-digit integer in `run()`, then the same ValueError in `resolve_layers()` and `validate()`,
 * then RecursionError in the reference resolver, the TOML parser and the JSON parser, one review
 * round each, and its correctives cost 29 percent of the run. With the policy field `classSweep`
 * the corrective of such a finding gets the battery of input shapes and the host's list of the
 * entry points next to the reported one, and may write them, so one task covers the class.
 *
 * The second class is test style (#1191): aclvet 5684de0e's convergence found that the
 * performance tests built their inputs with loops instead of static fixtures, and its correction
 * fixed `check_test.go` only; the next review found the same in the sibling `diff_test.go` (641k
 * tokens). A test-style finding's corrective may write every planned test file of its kind in the
 * same directory and is told to check each of them.
 */
import { isCodePath } from "../workflows/check-policy.js";
import { changeReach } from "../workflows/invalidation.js";
import type { Review } from "../workflows/schemas.js";
import { namesPath } from "../workflows/task-graph.js";
import { isTestPath } from "../workflows/test-integrity.js";
import type { Task } from "../workflows/types.js";

type Finding = Review["findings"][number];

/** The input shapes of the battery, each with the wording that shows a finding is of it. */
const SHAPES: { shape: string; probe: string; pattern: RegExp }[] = [
  {
    shape: "deep nesting",
    probe: "nesting or chained references a few thousand levels deep",
    pattern:
      /RecursionError|maximum recursion depth|recursion limit|stack ?overflow|too deep|deep(?:ly)? nest|nesting depth|chained references/i,
  },
  {
    shape: "huge numbers",
    probe: "integers with thousands of digits and values past the 64-bit range",
    pattern:
      /integer string conversion|digit limit|huge (?:integer|number)|[\d,]{3,}[- ]digits?|OverflowError|integer overflow/i,
  },
  {
    shape: "long input",
    probe:
      "very long lines, keys, strings and lists (hundreds of thousands of characters or items)",
    pattern:
      /very long (?:input|line|key|string|list)|[\d,]{4,}[- ](?:segment|character|char|byte|element|item|key|line)s?\b/i,
  },
  {
    shape: "invalid encoding",
    probe: "bytes that are not valid UTF-8 and a byte-order mark",
    pattern: /UnicodeDecodeError|non-UTF-?8|invalid UTF-?8|invalid byte sequence/i,
  },
  {
    shape: "empty input",
    probe: "an empty file, an empty string and input of only whitespace",
    pattern: /\bempty (?:input|file|string|document|stdin)\b/i,
  },
];

/** The robustness shapes a finding shows, from its claim, impact and reproduction; empty when none. */
export function robustnessShapes(finding: Pick<Finding, "claim" | "impact" | "repro">): string[] {
  const text = [finding.claim, finding.impact, finding.repro?.actual ?? ""].join("\n");
  return SHAPES.filter((s) => s.pattern.test(text)).map((s) => s.shape);
}

/** The most test files a test-style sweep names: past that the list stops being a checklist. */
const MAX_TEST_FILES = 12;

/**
 * The most entry points a robustness sweep names. cfgtrace eff0ebe7 listed 12 against 5 shapes,
 * about 60 probes for one attempt: its corrective ran three attempts for 3.96M tokens, 40 percent
 * of the run, and stopped on its caps before the sweep was done (#1226).
 */
const MAX_ENTRY_POINTS = 5;

/**
 * Whether a planned file is tied to a reported one: it imports a reported file, a reported file
 * imports it, or it is named by the text of the findings' criteria. Read from the run's files
 * under `root`; a file that cannot be read is not tied.
 */
export function sweepRelation(
  root: string,
  named: readonly string[],
  criteria: string,
): (path: string) => boolean {
  const reported = new Set(named);
  const reading = (path: string) =>
    ({ writes: [{ path, action: "modify" }], readHints: [] }) as unknown as Task;
  return (path) =>
    reported.has(path) ||
    changeReach(root, reading(path), reported) === "imports" ||
    named.some((file) => changeReach(root, reading(file), new Set([path])) === "imports") ||
    namesPath(criteria, path);
}

/**
 * The planned code files a sweep covers: the source files (not tests) of the approved graph that
 * tasks of `profileId` write, in the same top-level directory as a file the findings name. With
 * `related`, only the files it ties to a reported one (#1226). A finding without a file sweeps
 * the files of the task it corrects.
 */
export function sweepEntryPoints(
  findings: Pick<Finding, "file">[],
  root: { tasks: Task[] },
  profileId: string,
  base: Task,
  related: (path: string) => boolean = () => true,
): string[] {
  const source = (path: string) => isCodePath(path) && !isTestPath(path);
  const top = (path: string) => (path.includes("/") ? path.slice(0, path.indexOf("/") + 1) : "");
  const named = findings.map((f) => f.file).filter((f): f is string => Boolean(f));
  const dirs = new Set(named.map(top));
  const candidates = named.length
    ? root.tasks
        .filter((t) => t.profileId === profileId)
        .flatMap((t) => t.writes.filter((w) => w.action !== "delete").map((w) => w.path))
        .filter((path) => dirs.has(top(path)) && related(path))
    : base.writes.filter((w) => w.action !== "delete").map((w) => w.path);
  return [...new Set([...named, ...candidates])].filter(source).slice(0, MAX_ENTRY_POINTS);
}

/**
 * The last step of a sweeping correction: the reported shapes at every entry point, the other
 * shapes of the battery only where the defect was reported, so one attempt can finish it.
 */
export function sweepStep(
  shapes: string[],
  entryPoints: string[],
  reportedFiles: string[] = [],
): string {
  const reported = new Set(shapes);
  const where = reportedFiles.length ? reportedFiles.join(", ") : "the reported entry point";
  const battery = SHAPES.map((s) =>
    reported.has(s.shape)
      ? `- ${s.shape} (reported, every entry point): ${s.probe}`
      : `- ${s.shape} (only ${where}): ${s.probe}`,
  ).join("\n");
  const files = entryPoints.length
    ? `\nEntry points to sweep (the host's list of planned source files tied to the reported one by an import or a criterion):\n${entryPoints.map((p) => `- ${p}`).join("\n")}`
    : "";
  return `\n\nClass sweep: the review shows one case of an input-robustness defect, and the same class usually sits at the entry points that share its code. Before you finish, run each reported input shape below with run_probe against the public functions of every entry point, and each other shape once against ${where}, the way the reported case was run; probe only what the list names. Fix every case that crashes, hangs or gives the wrong error, so the input is rejected with the documented error or handled, and add one regression test per entry point you fix.\n${battery}${files}`;
}

/** Wording of a finding about how a test file is written rather than what the code does (#1191). */
const TEST_STYLE =
  /\bgenerat(?:or|ors|ed|es|ing)\b|\bfixtures?\b|\b(?:arithmetic )?loops?\b|hard-?coded|static (?:example|input|fixture)s?|\bomits?\b[^.]*\bcases?\b|\bmissing\b[^.]*\bcases?\b|\bcovers? \w+ only\b|\bonly covers?\b|\bexact (?:stdout|stderr|output|exit code)/i;

/** The class a finding sweeps under `classSweep`, or null: robustness first, then test style. */
export function sweepClass(
  finding: Pick<Finding, "claim" | "impact" | "repro" | "file">,
): "robustness" | "tests" | null {
  if (robustnessShapes(finding).length) return "robustness";
  if (
    finding.file &&
    isTestPath(finding.file) &&
    TEST_STYLE.test(`${finding.claim}\n${finding.impact}`)
  )
    return "tests";
  return null;
}

/**
 * The planned test files a test-style sweep covers: those that tasks of `profileId` write in the
 * same directory as a test file the findings name, with the same extension.
 */
export function sweepTestFiles(
  findings: Pick<Finding, "file">[],
  root: { tasks: Task[] },
  profileId: string,
): string[] {
  const dir = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
  const ext = (path: string) => path.slice(path.lastIndexOf("."));
  const named = findings.map((f) => f.file).filter((f): f is string => Boolean(f && isTestPath(f)));
  const kinds = new Set(named.map((path) => `${dir(path)}\n${ext(path)}`));
  const siblings = root.tasks
    .filter((t) => t.profileId === profileId)
    .flatMap((t) => t.writes.filter((w) => w.action !== "delete").map((w) => w.path))
    .filter((path) => isTestPath(path) && kinds.has(`${dir(path)}\n${ext(path)}`));
  return [...new Set([...named, ...siblings])].slice(0, MAX_TEST_FILES);
}

/** The last step of a test-style sweep: the same defect looked for in every sibling test file. */
export function testSweepStep(files: string[]): string {
  const list = files.length
    ? `\nTest files to sweep (the host's list of planned test files of the same kind next to the reported one):\n${files.map((p) => `- ${p}`).join("\n")}`
    : "";
  return `\n\nClass sweep: the review shows the defect in one test file, and sibling test files written the same way usually share it (inputs built by loops or generators instead of static fixtures, a protocol or case the criteria name left out, outputs not checked exactly). Before you finish, read each test file below, fix the same defect wherever it occurs, and make every case the criteria name appear in a test with the exact expected output and exit code.${list}`;
}
