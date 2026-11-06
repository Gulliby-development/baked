import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rowOf, SUPPORTED_LANGUAGES } from "../src/core/intelligence/language-records.js";
import { changedLineRanges, FILE_FORMATTERS, type LineRange } from "../src/core/workflows/format-written.js";
import { keepFixerRange, putBackOutsideRange } from "../src/core/workflows/range-fixer-scope.js";

// Bench round 104 (#2970). logslice-update added one `parser.add_argument(` call next to the
// existing `--summary` call of src/logslice/cli.py, a file that is not `ruff format` clean. The
// format-written fixer `ruff format --range` also rewrote the `--summary` call, outside the range;
// the review reported the reformat twice (`unrequested`, then `contradicts`) and both corrections
// had empty patches, because the fixer put the reformat back before every check: 2 correctives,
// 401,203 tokens. The host now puts back a range fixer's changes outside its range.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The file as the run left it: the new `--offset` call (lines 7-12), the old calls unformatted. */
const EDITED = [
  "import argparse",
  "",
  "",
  "def build():",
  '    parser = argparse.ArgumentParser(prog="logslice")',
  '    parser.add_argument("--from", dest="start", help="start time")',
  "    parser.add_argument(",
  '        "--offset",',
  "        type=int,",
  "        default=0,",
  '        help="skip the first N lines"',
  "    )",
  '    parser.add_argument("--summary", action="store_true",',
  '                        help="print a summary")',
  '    parser.add_argument("--summary-format", choices=["text", "json"], default="text",',
  '                        help="summary format")',
  "    return parser",
  "",
].join("\n");
const OFFSET = '    parser.add_argument("--offset", type=int, default=0, help="skip the first N lines")';
const SUMMARY = '    parser.add_argument("--summary", action="store_true", help="print a summary")';
const lines = EDITED.split("\n");
/** The R104 fixer's output: the new call formatted, and the `--summary` call below it too. */
const WIDENED = [...lines.slice(0, 6), OFFSET, SUMMARY, ...lines.slice(14)].join("\n");
/** What the host keeps: the new call formatted, the `--summary` call as the file had it. */
const KEPT = [...lines.slice(0, 6), OFFSET, ...lines.slice(12)].join("\n");
const RANGE: LineRange[] = [[7, 12]];

describe("scenario: R104 logslice-update e033c9e8, a range fixer that rewrote the next statement (#2970)", () => {
  test("the neighbouring call goes back as it was; the new call keeps the formatter's lines", () => {
    expect(keepFixerRange(EDITED, WIDENED, RANGE)).toEqual({ text: KEPT, putBack: 2 });
  });

  test("a change in its own hunk outside the range goes back whole; one inside stays", () => {
    const apart = [...lines.slice(0, 6), OFFSET, ...lines.slice(12, 14), lines[14] ?? "", lines[15] ?? "", "    return parser  ", ""].join("\n");
    const formattedBoth = apart.replace("    return parser  ", "    return parser").replace(lines[12] ?? "", SUMMARY).replace(`\n${lines[13]}`, "");
    const kept = keepFixerRange(apart, formattedBoth, [[7, 7]]);
    expect(kept.text).toBe(apart);
    expect(kept.putBack).toBe(3);
  });

  test("the statement a range starts inside is the range's: its opening line above the range is not put back", () => {
    // The run changed lines 8-12 only; the formatter joins the whole call into line 7.
    expect(keepFixerRange(EDITED, [...lines.slice(0, 6), OFFSET, ...lines.slice(12)].join("\n"), [[8, 12]]).putBack).toBe(0);
  });

  test("a hunk the code does not split at the range's end is kept as the formatter wrote it", () => {
    const merged = WIDENED.replace(`${OFFSET}\n${SUMMARY}`, `${OFFSET}; ${SUMMARY.trim()}`);
    expect(keepFixerRange(EDITED, merged, RANGE)).toEqual({ text: merged, putBack: 0 });
  });

  test("nothing outside the range changed: the fixer's result stands", () => {
    const own = [...lines.slice(0, 6), OFFSET, ...lines.slice(12)].join("\n");
    expect(keepFixerRange(EDITED, own, RANGE)).toEqual({ text: own, putBack: 0 });
    expect(keepFixerRange(EDITED, EDITED, RANGE)).toEqual({ text: EDITED, putBack: 0 });
  });

  test("the put-back is kept only when the check passes on it, and is reported for the journal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-range-fix-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const target = join(dir, "cli.py");
    writeFileSync(target, WIDENED);
    const done = await putBackOutsideRange(target, "src/logslice/cli.py", EDITED, RANGE, async () => true);
    expect(done).toMatchObject({ path: "src/logslice/cli.py", action: "restored" });
    expect(readFileSync(target, "utf8")).toBe(KEPT);
    writeFileSync(target, WIDENED);
    expect(await putBackOutsideRange(target, "src/logslice/cli.py", EDITED, RANGE, async () => false)).toBeNull();
    expect(readFileSync(target, "utf8")).toBe(WIDENED);
  });
});

// One sample program per range formatter: a new `range` row of FILE_FORMATTERS adds its sample
// and a case here, and this table fails until it does.
const RANGE_SAMPLES: [string, string, string[]][] = [
  ["ruff format", "ruff", ["format"]],
  ["black", "black", []],
  ["prettier", "prettier", []],
  ["bun fmt", "bun", ["fmt"]],
  ["stylua", "stylua", []],
  ["clang-format", "clang-format", ["--dry-run"]],
];

describe("every range formatter keeps its fixer to the range (#2970)", () => {
  test("each FILE_FORMATTERS row with a range has a sample here", () => {
    const formatters = new Set(SUPPORTED_LANGUAGES.flatMap((language) => rowOf(FILE_FORMATTERS, language) ?? []).filter((f) => f.range));
    for (const formatter of formatters)
      expect(RANGE_SAMPLES.filter(([, program, args]) => formatter.runs(program, args)).length).toBe(1);
  });

  const installed = (program: string) => spawnSync(program, ["--version"]).status === 0;
  test.if(installed("ruff"))("ruff: the fixer on the new call's lines, then the put-back, leaves the old calls as they were", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-range-ruff-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const target = join(dir, "cli.py");
    const base = [...lines.slice(0, 6), ...lines.slice(12)].join("\n");
    writeFileSync(target, EDITED);
    const ranges = changedLineRanges(base, EDITED);
    expect(ranges).toEqual(RANGE);
    const ruff = rowOf(FILE_FORMATTERS, "python")?.find((f) => f.runs("ruff", ["format"]))?.range;
    const fix = ruff?.fix([], ranges, EDITED) ?? [];
    spawnSync("ruff", [...fix, "--line-length", "100", target]);
    const check = ruff?.check([], target, ranges, EDITED) ?? [];
    await putBackOutsideRange(target, "cli.py", EDITED, ranges, async () => spawnSync("ruff", [...check.slice(0, -1), "--line-length", "100", target]).status === 0);
    const after = readFileSync(target, "utf8");
    expect(after).toContain(OFFSET);
    expect(after).toContain(lines[12] ?? "");
    expect(after).toContain(lines[14] ?? "");
  });
});
