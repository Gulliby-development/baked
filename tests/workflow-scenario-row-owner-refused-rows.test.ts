import { describe, expect, test } from "bun:test";
import { type InitiativeFeature, type InitiativePlan, refusedRow, rowOwnerProblems } from "../src/core/workflows/initiatives/plan.js";

// Bench round 109, datefold split (Swift, #3048). The request put a missing `--days`, a bad
// `--days` value and an empty list in part 1, and the plan's typed rows gave Cli 1-13, Options
// 1-18 and Values 1-16 to core. Their first word is `shift`, whose source only feature shift
// writes, so the `later-command` join (#3010) recorded 4 of 4 false would-stops for core. Core's
// argument parsing produced every one of those replies, and every row passed.

const fence = "```";

/** One row notation per language: args, stdin, exit status, stdout, stderr. */
const layouts = [
  {
    language: "Swift",
    file: (name: string) => `Tests/DatefoldTests/${name}RowsTests.swift`,
    sources: { core: "Sources/Datefold/Cli.swift", shift: "Sources/Datefold/ShiftCommand.swift" },
    row: (args: string[], stdin: string, code: number, out: string, err: string) =>
      `(${JSON.stringify(args).replace(/,/g, ", ")}, "${stdin}", ${code}, "${out}", "${err}"),`,
  },
  {
    language: "Ruby",
    file: (name: string) => `test/${name.toLowerCase()}_rows_test.rb`,
    sources: { core: "lib/datefold/cli.rb", shift: "lib/datefold/shift_command.rb" },
    row: (args: string[], stdin: string, code: number, out: string, err: string) =>
      `[[${args.map((a) => `"${a}"`).join(", ")}], "${stdin}", ${code}, "${out}", "${err}"],`,
  },
  {
    language: "Zig",
    file: (name: string) => `src/${name.toLowerCase()}_rows_test.zig`,
    sources: { core: "src/cli.zig", shift: "src/shift_command.zig" },
    row: (args: string[], stdin: string, code: number, out: string, err: string) =>
      `.{ &.{ ${args.map((a) => `"${a}"`).join(", ")} }, "${stdin}", ${code}, "${out}", "${err}" },`,
  },
  {
    language: "OCaml",
    file: (name: string) => `test/${name.toLowerCase()}_rows_test.ml`,
    sources: { core: "bin/cli.ml", shift: "bin/shift_command.ml" },
    row: (args: string[], stdin: string, code: number, out: string, err: string) =>
      `([${args.map((a) => `"${a}"`).join("; ")}], "${stdin}", ${code}, "${out}", "${err}");`,
  },
];

for (const layout of layouts) {
  const { sources } = layout;
  const cli = layout.file("Cli");
  const values = layout.file("Values");
  const reads = layout.file("Reads");
  /** `realShift`: core's Cli range also holds a row the shift command answers. */
  const request = (realShift = false) =>
    [
      "Build datefold, a date list tool. Part 1 is the command line; a bad `--days` belongs to part 1.",
      "",
      `${fence}text`,
      `cli in ${cli} (${realShift ? 3 : 2} rows: args | stdin | code | stdout | stderr)`,
      layout.row(["format", "2024-01-01"], "", 0, "2024-01-01\\n", ""),
      layout.row(["shift"], "", 2, "", "datefold: missing --days\\n"),
      ...(realShift ? [layout.row(["shift", "--days", "3"], "2024-01-01\\n", 0, "2024-01-04\\n", "")] : []),
      fence,
      "",
      `${fence}text`,
      `values in ${values} (2 rows: args | stdin | code | stdout | stderr)`,
      layout.row(["shift", "--days", "05"], "", 2, "", "datefold: bad value for --days\\n"),
      layout.row(["format", "x"], "", 2, "", "datefold: bad date\\n"),
      fence,
      "",
      `${fence}text`,
      `reads in ${reads} (1 row: args | stdin | code | stdout | stderr)`,
      layout.row(["shift", "--days", "3"], "", 1, "", ""),
      fence,
      "",
    ].join("\n");
  const feature = (id: string, paths: string[], dependsOn: string[], rows?: InitiativeFeature["rows"]): InitiativeFeature => ({
    id, title: id, boundary: { scope: `The ${id} part.`, paths }, contract: `Implements ${id}.`, dependsOn, mandatory: true, ...(rows ? { rows } : {}),
  });
  const plan = (realShift = false): InitiativePlan => ({
    schemaVersion: 1, title: "datefold", goals: ["datefold formats and shifts dates."], completionCriteria: ["Every prescribed row passes."],
    features: [
      // Core holds Cli and Values by typed rows, and Reads whole.
      feature("core", [sources.core, cli, values, reads], [], [
        { path: cli, rows: realShift ? [1, 2, 3] : [1, 2] },
        { path: values, rows: [1, 2] },
      ]),
      feature("shift", [sources.shift], ["core"]),
    ],
  });

  describe(`${layout.language}: a row the command line refuses needs no later command (#3048)`, () => {
    test("a missing option, a bad value or an empty list is a refused row; a shift that prints is not", () => {
      expect(refusedRow(layout.row(["shift"], "", 2, "", "datefold: missing --days\\n"))).toBe(true);
      expect(refusedRow(layout.row(["shift", "--days", "05"], "", 2, "", "datefold: bad value for --days\\n"))).toBe(true);
      expect(refusedRow(layout.row(["shift", "--days", "3"], "", 1, "", ""))).toBe(true);
      expect(refusedRow(layout.row(["shift", "--days", "3"], "2024-01-01\\n", 0, "2024-01-04\\n", ""))).toBe(false);
      // A failure that still prints is the command's own answer.
      expect(refusedRow(layout.row(["shift", "--days", "3"], "", 1, "partial\\n", "err"))).toBe(false);
    });

    test("core's refused shift rows inside its stated ranges, and in the file it owns whole, record nothing", () => {
      // On main: later-command problems for Cli, Values and Reads, owner core, needs shift.
      expect(rowOwnerProblems(plan(), request())).toEqual([]);
    });

    test("a shift row that prints, in core's range, still needs shift", () => {
      expect(rowOwnerProblems(plan(true), request(true))).toEqual([
        expect.objectContaining({ path: cli, owner: "core", needs: "shift", literal: "shift", rows: 1, shape: "later-command" }),
      ]);
    });
  });
}
