import { describe, expect, test } from "bun:test";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec, Task, TaskGraph } from "../src/core/workflows/schemas.js";
import {
  exactTextChars,
  requestSections,
  SUPPLIED_TEXT_PER_CHAR,
  type SizingSample,
  sizePlan,
} from "../src/core/workflows/sizing.js";

// Bench round 67, srtvet-update 49685e9c (#2101): the brief gave the README section "## Cleaning
// spaces" verbatim (1,264 characters, backticks, two fenced blocks) and T005 compared it byte for
// byte in a Go test. The task was priced 285k-834k from its 14 cases and cost 1.64M tokens in one
// session, four check rounds over the string's quoting. With `sizing.suppliedDiff` a test that
// compares a supplied text exactly is priced by the text's characters when that is above its case
// price.

/** A section of about the srtvet size: prose, a fenced usage block and a fenced example. */
const SECTION = [
  "## Cleaning spaces",
  "",
  "`srtvet clean` replaces each unusual space in a cue's text with an ASCII space and reports it as `<U+XXXX>`.",
  "Tabs are shown as `<TAB>` and are replaced too. The file is rewritten only with `--write`.",
  "",
  "```text",
  "srtvet clean [--write] FILE...",
  "```",
  "",
  ...Array.from({ length: 11 }, (_, i) => `Cue ${i + 1}: a no-break space, U+00A0, becomes a space and is reported once per cue.`),
  "",
  "```console",
  "$ srtvet clean subs.srt",
  "subs.srt:3: <U+00A0> replaced",
  "subs.srt:7: <TAB> replaced",
  "# two cues changed",
  "```",
].join("\n");

const request = [
  "Add a clean command to srtvet.",
  "",
  "Add this section to README.md, exactly as written, after the Usage section:",
  "",
  "````markdown",
  SECTION,
  "````",
  "",
  "## Notes",
  "",
  "Keep the existing tests passing.",
].join("\n");

const criterion = (id: string, then: string) => ({
  id,
  requirementIds: ["FR-001"],
  given: "the repository after the change",
  when: "the documentation test reads README.md",
  then,
  method: "automated" as const,
});
const spec: Pick<Spec, "criteria"> = {
  criteria: [
    criterion("AC-005", "the Cleaning spaces section of README.md matches the requested text exactly"),
    criterion("AC-006", "the Cleaning spaces section mentions `--write`"),
  ],
};

const planned = (id: string, path: string, criterionIds: string[]): Task => ({
  id, title: `test ${path}`, description: `test ${path}`, requirementIds: ["FR-001"], criterionIds, dependsOn: [], profileId: "implementer",
  writes: [{ path, action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior",
});
const graph = (...tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "srtvet", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });

// Finished test tasks of 2-40 cases at 200k-824k: a whole-task price of a few hundred thousand.
const history: SizingSample[] = Array.from({ length: 40 }, (_, i) => ({
  runId: `t${i}`, taskId: "T004", kind: "test", action: "create", source: "project", files: 1, tokens: 200_000 + i * 16_000, model: null, criteria: 4, cases: 2 + (i % 40),
}));
const policy = (suppliedDiff?: boolean): RunPolicy => ({ ...defaultWorkflowPolicy, sizing: { maxAttemptTokens: 2_000_000, ...(suppliedDiff === undefined ? {} : { suppliedDiff }) } });

/** A documentation test of each language the round's briefs used. */
const LANGUAGES: [string, string][] = [
  ["csharp", "tests/App.Tests/DocsTests.cs"],
  ["go", "docs_test.go"],
  ["java", "src/test/java/app/DocsTest.java"],
  ["python", "tests/test_docs.py"],
  ["rust", "tests/docs.rs"],
  ["typescript", "tests/docs.test.ts"],
];

describe("sections of a request (#2101)", () => {
  test("a section quoted in a Markdown fence ends at the fence's close, not at its inner fences or a shell comment", () => {
    const sections = requestSections(request);
    expect(sections.get("cleaning spaces")).toBe([...SECTION].length);
    expect(sections.has("two cues changed")).toBe(false);
    expect(sections.get("notes")).toBe("## Notes\n\nKeep the existing tests passing.".length);
  });

  test("a section of the request itself ends at the next heading of its level", () => {
    const text = ["## A", "one", "### A1", "two", "## B", "three"].join("\n");
    expect(Object.fromEntries(requestSections(text))).toEqual({ a: "## A\none\n### A1\ntwo".length, a1: "### A1\ntwo".length, b: "## B\nthree".length });
  });

  test("only a criterion that compares exactly names a section", () => {
    expect(exactTextChars(request, spec, { criterionIds: ["AC-005"] })).toBe([...SECTION].length);
    expect(exactTextChars(request, spec, { criterionIds: ["AC-006"] })).toBe(0);
  });
});

describe("scenario: srtvet-update R67, an exact README section test priced by cases (#2101)", () => {
  for (const [language, path] of LANGUAGES) {
    test(`${language}: the text's characters price the task above its case price, and only with the policy`, () => {
      const plan = graph(planned("T005", path, ["AC-005"]));
      const before = sizePlan({ graph: plan, policy: policy(), samples: history, spent: 0, spec, request }).tasks[0];
      const after = sizePlan({ graph: plan, policy: policy(true), samples: history, spent: 0, spec, request }).tasks[0];
      expect(before?.exactTextChars).toBeUndefined();
      const chars = [...SECTION].length;
      expect(after?.exactTextChars).toBe(chars);
      expect(after?.estimate).toEqual({ low: chars * SUPPLIED_TEXT_PER_CHAR.low, high: chars * SUPPLIED_TEXT_PER_CHAR.high });
      // Above three times the case-priced low end, as the 1.64M run was against 285k.
      // About twice the case-priced high end, as the 1.64M run was against 834k.
      expect(after?.estimate.low ?? 0).toBeGreaterThan(before?.estimate.low ?? Infinity);
      expect(after?.estimate.high ?? 0).toBeGreaterThan(2 * (before?.estimate.high ?? Infinity));
      expect(after?.oversized).toBe(before?.oversized);
    });
  }

  test("a test that does not compare the section keeps its case price", () => {
    const plan = graph(planned("T006", "docs_test.go", ["AC-006"]));
    const before = sizePlan({ graph: plan, policy: policy(), samples: history, spent: 0, spec, request }).tasks[0];
    const after = sizePlan({ graph: plan, policy: policy(true), samples: history, spent: 0, spec, request }).tasks[0];
    expect(after?.estimate).toEqual(before?.estimate);
    expect(after?.exactTextChars).toBeUndefined();
  });
});
