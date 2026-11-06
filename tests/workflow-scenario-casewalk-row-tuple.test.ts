import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CaseWalk,
  caseCheck,
  casePrescribed,
  caseWalkDecision,
  criterionCases,
} from "../src/core/verification/criteria-cases.js";
import { rowTupleHeld } from "../src/core/workflows/row-block-drift.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import {
  notPrescribedFindings,
  perRowReading,
  prescribedRowFiles,
} from "../src/core/workflows/supplied-content.js";
import type { Task } from "../src/core/workflows/types.js";
import { fixtureSpec } from "./helpers/workflow-fixture.js";

// #2544, the per-row reader in shadow. R98 spendgate (Python) restated each prescribed row in its
// criteria as a tuple in the spec's own notation; R97 gridspan and holefill (Elixir) wrote
// `(["check"], "a A1\r\n")` for the row `row(["check"], "a A1\r\n", ...)`. The walk's matcher
// found none of them in the rows' joined text, so `case_not_prescribed` noted each (17 notes over
// R97 and R98, none true). `rowTupleHeld` reads such a literal by its values (`rowTokens`) in
// order within one row: the restated rows are held, a row the request lacks and a case two rows
// spread between them are not. Its answer is recorded beside the joined one; the decision is
// unchanged.

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Row = [args: string[], code: number, out: string];
interface Notation {
  name: string;
  fence: string;
  path: string;
  header: string;
  /** A prescribed row, as the request writes it. */
  row: (...row: Row) => string;
  /** The same row as a criterion restates it, in the spec's own notation. */
  restate: (...row: Row) => string;
  file: (rows: string[]) => string;
  /** The notation's own rows, where they are not `ROWS`, `MISSING` and `SPREAD`. */
  rows?: { rows: Row[]; missing: Row; spread: Row };
}

const q = (s: string) => JSON.stringify(s);
const list = (args: string[], quote = '"') => `[${args.map((a) => `${quote}${a}${quote}`).join(", ")}]`;
const NOTATIONS: Notation[] = [
  {
    // R98 spendgate.
    name: "python",
    fence: "python",
    path: "tests/test_cli.py",
    header: "# Rows in tests/test_cli.py (2 rows)",
    row: (args, code, out) => `    (${list(args)}, ${String(code)}, ${q(out)}),`,
    restate: (args, code, out) => `(${args.map((a) => `'${a}'`).join(", ")}) -> (${String(code)}, ${q(out)})`,
    file: (rows) => `import pytest\n\nROWS = [\n${rows.join("\n")}\n]\n`,
  },
  {
    // R97 gridspan: the row's call restated without its name and status.
    name: "elixir",
    fence: "elixir",
    path: "test/cli_test.exs",
    header: "# Rows in test/cli_test.exs (2 rows)",
    row: (args, code, out) => `row(${list(args)}, ${q(out)}, ${String(code)}, "")`,
    restate: (args, _code, out) => `(${list(args)}, ${q(out)})`,
    rows: {
      rows: [
        [["check"], 0, "a A1\r\n"],
        [["fill"], 1, "b B2\r\n"],
      ],
      missing: [["check"], 1, "c C3\r\n"],
      spread: [["check"], 1, "b B2\r\n"],
    },
    file: (rows) => `defmodule CliTest do\n  use ExUnit.Case\n  import RowHelper\n\n${rows.map((r) => `  ${r}`).join("\n")}\nend\n`,
  },
  {
    name: "typescript",
    fence: "ts",
    path: "tests/cli.test.ts",
    header: "// Rows in tests/cli.test.ts (2 rows)",
    row: (args, code, out) => `{ args: ${list(args)}, code: ${String(code)}, stdout: ${q(out)} },`,
    restate: (args, code, out) => `${list(args, "'")} => ${String(code)}, '${out.replaceAll("\n", "\\n").replaceAll("\r", "\\r")}'`,
    file: (rows) => `const ROWS = [\n${rows.map((r) => `  ${r}`).join("\n")}\n];\n`,
  },
];

const ROWS: Row[] = [
  [["--limit", "100", "spend.csv"], 0, "ok 42.00 of 100.00\r\n"],
  [["--limit", "10", "spend.csv"], 1, "over 42.00 of 10.00\n"],
];
/** A row no block of the request holds. */
const MISSING: Row = [["--limit", "5", "spend.csv"], 1, "over 42.00 of 5.00\n"];
/** The arguments of the first row with the output of the second: no row tests it. */
const SPREAD: Row = [["--limit", "100", "spend.csv"], 1, "over 42.00 of 10.00\n"];

type Criterion = Spec["criteria"][number];
const criterion = (id: string, then: string): Criterion => ({
  id,
  requirementIds: ["FR-001"],
  given: "a spend file",
  when: "the user runs the gate",
  then,
  method: "automated",
});

describe("a row restated as a tuple is held by one row, read per row (#2544, shadow)", () => {
  for (const n of NOTATIONS) {
    const own = n.rows ?? { rows: ROWS, missing: MISSING, spread: SPREAD };
    const restated = own.rows.map((r) => n.restate(...r));
    const absent = n.restate(...own.missing);
    const spread = n.restate(...own.spread);
    const spec: Spec = {
      ...fixtureSpec,
      criteria: [
        criterion("AC-001", `it answers as the rows \`${restated[0]}\` and \`${restated[1]}\``),
        criterion("AC-002", `it answers \`${absent}\``),
        criterion("AC-003", `it answers \`${spread}\``),
      ],
    };
    const request = `Build spendgate.\n\n\`\`\`${n.fence}\n${n.header}\n${own.rows.map((r) => n.row(...r)).join("\n")}\n\`\`\`\n`;
    const T001 = {
      id: "T001",
      description: "Write the cli rows.",
      criterionIds: ["AC-001", "AC-002", "AC-003"],
      writes: [{ path: n.path, action: "create" as const }],
      dependsOn: [],
    };
    const tasks = [T001] as Task[];
    const rows = prescribedRowFiles(request, { tasks });

    test(`${n.name}: the joined reader holds none of them; one row holds each restated row`, () => {
      expect(rows.get(n.path)).toHaveLength(2);
      const cases = criterionCases(spec, T001, { checks: [], tasks: [T001], prescribedRows: rows });
      expect(cases.map((c) => c.literal)).toEqual([...restated, absent, spread]);
      const answers = cases.map((c) => [
        casePrescribed(c, [n.path], rows),
        casePrescribed(c, [n.path], rows, rowTupleHeld),
      ]);
      expect(answers).toEqual([
        ["none", "own"],
        ["none", "own"],
        ["none", "none"],
        ["none", "none"],
      ]);
    });

    test(`${n.name}: analysis still notes all three; the per-row answer holds only the restated rows`, () => {
      const findings = notPrescribedFindings(spec, { tasks }, request, { checks: [] });
      expect(findings.map((f) => f.id)).toEqual(["NOT-PRESCRIBED-AC-001", "NOT-PRESCRIBED-AC-002", "NOT-PRESCRIBED-AC-003"]);
      const reading = perRowReading(spec, { tasks }, request, { checks: [] });
      expect([...reading.noted]).toEqual([
        ["AC-001", "held"],
        ["AC-002", "none"],
        ["AC-003", "none"],
      ]);
      expect(reading.notPrescribed).toEqual([]);
    });

    test(`${n.name}: the walk records the per-row answer beside the joined one and decides as before`, async () => {
      const root = mkdtempSync(join(tmpdir(), "baked-row-tuple-"));
      roots.push(root);
      mkdirSync(dirname(join(root, n.path)), { recursive: true });
      writeFileSync(join(root, n.path), n.file(own.rows.map((r) => n.row(...r))));
      const walks: CaseWalk[] = [];
      const check = caseCheck(spec, T001, {
        checks: [],
        tasks,
        prescribedRows: rows,
        rowHold: rowTupleHeld,
        record: (w) => walks.push(w),
      });
      if (!check) throw new Error("no case check");
      expect(await check(root)).toEqual([]);
      const [record] = walks;
      expect(record?.cases.map((c) => [c.prescribed, c.prescribedPerRow])).toEqual([
        ["none", "own"],
        ["none", "own"],
        ["none", undefined],
        ["none", undefined],
      ]);
      if (record) expect(caseWalkDecision(record)).toEqual([]);
    });
  }

  test("a literal that is not only a row's values is left to the walk's matcher", () => {
    const row = `    (["render", "--var", "a=1"], 0, "42\\n"),`;
    // Bare words and flags are no tokens of a row; one number is one value.
    expect(rowTupleHeld("render --var a=1 => 42", row)).toBeNull();
    expect(rowTupleHeld("0.(3)", row)).toBeNull();
    expect(rowTupleHeld('"42\\n"', row)).toBeNull();
    expect(rowTupleHeld('["render",\n"--var"]', row)).toBeNull();
    // Values in order within the row, in any quoting.
    expect(rowTupleHeld("('render', '--var', 'a=1') -> 0", row)).toBe(true);
    expect(rowTupleHeld('["--var", "render"]', row)).toBe(false);
    expect(rowTupleHeld('["render", "--var", "a=2"]', row)).toBe(false);
  });
});
