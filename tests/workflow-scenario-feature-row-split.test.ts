import { describe, expect, test } from "bun:test";
import { scopeRowRanges } from "../src/core/workflows/feature-rows.js";
import { type InitiativePlan, featureRowFiles, featureRowSplit, rowOwnerProblems } from "../src/core/workflows/initiatives/plan.js";

// #3067, bench round R111 skillgate (PowerShell 7, Pester, 215 prescribed rows in 20 files). The
// decomposer gave each command feature "all of" its own test file and a few rows of the shared
// `It 'part 2'` list of tests/Cli.Tests.ps1, typed only for Cli. `scopeRowRanges` read "outline rows
// 6 and 8 of ... tests/Cli.Tests.ps1" as rows 6 and 8 of the Outline block (its name is `outline`),
// so the outline run held 2 of Outline's 13 rows; links got 1 of 8 and lint none of 8. 26 rows were
// never written, and Pester, the reviews and the initiative all passed.

const fence = "```";
const FILES = { outline: "tests/Outline.Tests.ps1", links: "tests/Links.Tests.ps1", lint: "tests/Lint.Tests.ps1", cli: "tests/Cli.Tests.ps1" } as const;
const SIZES = { outline: 13, links: 8, lint: 8, cli: 10 } as const;
const block = (name: keyof typeof FILES) =>
  [`${fence}powershell`, `${name} in ${FILES[name]} (${SIZES[name]} rows)`, ...Array.from({ length: SIZES[name] }, (_, i) => `@{ Args = '${name} ${i + 1}'; Code = 0; Out = '${name} ok ${i + 1}' }`), fence].join("\n");
const request = ["Build skillgate, a skill file linter.", "", ...(["outline", "links", "lint", "cli"] as const).map(block)].join("\n\n");
const sharer = (id: "outline" | "links" | "lint", row: number) => ({
  id,
  title: id,
  boundary: {
    scope: `Owns the ${id} command; its rows: all of \`${FILES[id]}\` and ${id} row${id === "outline" ? "s 6 and 8" : ` ${row}`} of the \`It 'part 2'\` list of \`${FILES.cli}\`.`,
    paths: [`src/${id}.ps1`, FILES[id], FILES.cli],
  },
  contract: `The ${id} command.`,
  dependsOn: ["cli"],
  mandatory: true,
  rows: [{ path: FILES.cli, rows: id === "outline" ? [6, 8] : [row] }],
});
const plan: InitiativePlan = {
  schemaVersion: 1,
  title: "skillgate",
  goals: ["skillgate lints skill files."],
  completionCriteria: ["Every prescribed row passes."],
  features: [
    { id: "cli", title: "cli", boundary: { scope: "The entry point; its rows: cli rows 1-5 and 10 of tests/Cli.Tests.ps1.", paths: ["src/cli.ps1", FILES.cli] }, contract: "The cli.", dependsOn: [], mandatory: true, rows: [{ path: FILES.cli, rows: [1, 2, 3, 4, 5, 10] }] },
    sharer("outline", 0),
    sharer("links", 7),
    sharer("lint", 9),
  ],
};
const all = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("a row phrase about another file does not narrow a feature's own row file (#3067)", () => {
  test("R111 skillgate: outline, links and lint own every row of their own files, and their Cli rows", () => {
    const split = featureRowSplit(plan, request);
    for (const id of ["outline", "links", "lint"] as const) {
      const own = split.get(FILES[id])?.own.get(id) ?? all(SIZES[id]);
      expect(own).toEqual(all(SIZES[id]));
    }
    const cli = split.get(FILES.cli)?.own;
    expect(cli?.get("outline")).toEqual([6, 8]);
    expect(cli?.get("links")).toEqual([7]);
    expect(cli?.get("lint")).toEqual([9]);
    // What the feature run is told under the rows heading.
    const outline = featureRowFiles(plan, request, { id: "outline" }).find((f) => f.path === FILES.outline);
    expect(outline?.rows ?? all(SIZES.outline)).toEqual(all(SIZES.outline));
    // The row-owner rule that saw the gap in shadow finds none.
    expect(rowOwnerProblems(plan, request).filter((p) => p.shape === "row-split")).toEqual([]);
  });

  test("scope words with a path: another file's clause is skipped, `all of <path>` is every row", () => {
    const names = ["outline", "Outline.Tests"];
    const scope = plan.features[1]!.boundary.scope;
    expect(scopeRowRanges(scope, names, 13, FILES.outline)).toEqual(all(13));
    // A phrase that names the file itself still narrows it.
    expect(scopeRowRanges("outline rows 6 and 8 of tests/Outline.Tests.ps1", names, 13, FILES.outline)).toEqual([6, 8]);
    expect(scopeRowRanges("outline rows 6 and 8 in `Outline.Tests.ps1`.", names, 13, FILES.outline)).toEqual([6, 8]);
    // Only the clause up to the next row phrase or sentence counts.
    expect(scopeRowRanges("outline rows 1-3, and lint rows 1-2 of tests/Lint.Tests.ps1", names, 13, FILES.outline)).toEqual([1, 2, 3]);
    expect(scopeRowRanges("outline rows 1-3. Cli rows live in tests/Cli.Tests.ps1", names, 13, FILES.outline)).toEqual([1, 2, 3]);
    // A method name is not a file.
    expect(scopeRowRanges("CliRows rows 1-10 for Cli.Run.", ["CliRows"], 13, "tests/CliRows.cs")).toEqual(all(10));
    // Other phrasings of the whole file.
    expect(scopeRowRanges("Owns all rows of tests/Outline.Tests.ps1.", names, 13, FILES.outline)).toEqual(all(13));
    expect(scopeRowRanges("all of tests/Links.Tests.ps1", names, 13, FILES.outline)).toBeNull();
    // Without a path the words read as before.
    expect(scopeRowRanges(scope, names, 13)).toEqual([6, 8]);
  });
});
