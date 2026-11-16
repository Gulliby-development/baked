import { describe, expect, test } from "bun:test";
import { suppliedLinesOnce } from "../src/core/workflows/supplied-drift.js";
import { measureTestIntegrity, prescribedExemptions, scanTestIntegrity } from "../src/core/workflows/test-integrity.js";

const suppliedBy = (request: string) => (path: string, content: string) => suppliedLinesOnce(request, path, content);

// #3059, R110 lwu (loopwatch-update, JavaScript, run d64ae354). The request gives
// `tests/retries.test.js` as a verbatim diff whose line 4 is `+// prettier-ignore`, above a table
// of 12 one-line rows, and the host wrote the file. The run-scope integrity scan counted the
// marker as a suppression the run added: a bare marker is never prescribed by the request text
// (`prescribedSuppression`). Corrective T004 removed it, Prettier reflowed the table to 79 lines,
// the reviewer found the file no longer verbatim, T005 restored it, the scan fired again, and
// T006 refused for 3 sessions until a spec-conflict settlement: 3 correctives, about 184k tokens.

const diffBrief = (path: string, lines: readonly string[]) =>
  [
    `Add ${path} exactly as this diff gives it:`,
    "",
    "```diff",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
    ...lines.map((line) => `+${line}`),
    "```",
    "",
  ].join("\n");

/** One file per language whose bare suppression a verbatim block gives, with that marker. */
const CASES: { name: string; path: string; lines: string[] }[] = [
  {
    name: "JavaScript // prettier-ignore (R110 lwu)",
    path: "tests/retries.test.js",
    lines: [
      'import { test, expect } from "bun:test";',
      'import { retries } from "../src/retries.js";',
      "",
      "// prettier-ignore",
      "const ROWS = [",
      "  [0, 0], [1, 100], [2, 200],",
      "];",
      "",
      'test("retries", () => { for (const [n, ms] of ROWS) expect(retries(n)).toBe(ms); });',
    ],
  },
  {
    name: "Python # noqa",
    path: "tests/test_rows.py",
    lines: ["from rows import parse  # noqa", "", "def test_parse():", "    assert parse('a') == ['a']"],
  },
  {
    name: "C // NOLINT",
    path: "tests/cli_test.c",
    lines: ['#include "cli.h"', "", "int main(void) {", "  int failed = 0; // NOLINT", "  return failed;", "}"],
  },
  {
    name: "Java // NOSONAR",
    path: "src/test/java/RowsTest.java",
    lines: ["class RowsTest {", "  @org.junit.jupiter.api.Test", "  void rows() { int unused = 0; // NOSONAR", "  }", "}"],
  },
];

describe("scenario: R110 lwu, a suppression the request gives verbatim (#3059)", () => {
  for (const c of CASES) {
    const after = `${c.lines.join("\n")}\n`;
    const request = diffBrief(c.path, c.lines);
    test(`${c.name}: the run-scope scan does not count it and records it apart`, () => {
      const changes = [{ path: c.path, before: null, after }];
      const options = { specText: request, suppliedLines: suppliedBy(request) };
      expect(scanTestIntegrity(changes, options).filter((f) => f.rule === "suppression")).toEqual([]);
      const [measure] = measureTestIntegrity(changes, options);
      expect(measure).toMatchObject({ suppressions: 0, suppliedSuppressions: 1 });
    });

    test(`${c.name}: the same marker a session adds on a line the request does not supply is counted`, () => {
      const added = `${after}${c.path.endsWith(".py") ? "y = 1  # noqa" : "// prettier-ignore"}\n`;
      const changes = [{ path: c.path, before: null, after: added }];
      const found = scanTestIntegrity(changes, { specText: request, suppliedLines: suppliedBy(request) });
      expect(found.filter((f) => f.rule === "suppression")).toHaveLength(1);
    });
  }

  test("without the request's lines the bare marker is counted, as before", () => {
    const c = CASES[0];
    if (!c) throw new Error("no case");
    const request = diffBrief(c.path, c.lines);
    const changes = [{ path: c.path, before: null, after: `${c.lines.join("\n")}\n` }];
    expect(scanTestIntegrity(changes, { specText: request }).filter((f) => f.rule === "suppression")).toHaveLength(1);
  });

  test("a verification bypass on a supplied line clears its shadow finding", () => {
    const path = "package.json";
    const lines = ["{", '  "scripts": { "test": "vitest run --passWithNoTests" }', "}"];
    const request = diffBrief(path, lines);
    const changes = [{ path, before: "{}\n", after: `${lines.join("\n")}\n` }];
    const live = [{ rule: "verification-bypass" as const, path, detail: "" }];
    expect(prescribedExemptions(changes, "", live as never, suppliedBy(request))).toEqual([{ rule: "verification-bypass", path }]);
    expect(prescribedExemptions(changes, "", live as never)).toEqual([]);
  });
});
