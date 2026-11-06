import { describe, expect, test } from "bun:test";
import { measureFileRows, rowBlockDrifts, rowMoveDecision } from "../src/core/workflows/row-block-drift.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";

// Bench round 104 (#2969). netfold's scaffold commit wrote spec/mask_spec.rb with two row lists,
// `rows` and `totals`, each holding two placeholder rows. Feature `core` owns rows 7 and 8, which
// go in `rows`; it left the `totals` placeholders for feature `styles`. The checks stage read only
// the delivered file and recorded both placeholders as rows `core` added (two row_block_drift
// would-stops, "the block prescribes 2 rows"), though both lines were the scaffold's, byte for
// byte. The comparison now reads the file as it was before the run wrote it.

const PATH = "spec/mask_spec.rb";
const ROWS = ['[["mask", "10.0.0.0/8"], "", 0, "255.0.0.0\\n", ""],', '[["mask", "10.1.0.0/16"], "", 0, "255.255.0.0\\n", ""],'];
const request = ["Build the mask command.", "", "The prescribed rows, one test each:", "", "```text", `MaskSpec in ${PATH} (2 rows)`, ...ROWS, "```", ""].join("\n");
const graph = { tasks: [{ id: "T006", origin: "planned", writes: [{ path: PATH, action: "update" }] }] } as unknown as Pick<TaskGraph, "tasks">;

const placeholder = (n: number) => `  [["TODO-${n}"], "", 0, "placeholder ${n}", ""],`;
const spec = (rows: string[], totals: string[]) =>
  ['require_relative "spec_helper"', "", "ROWS = [", ...rows, "]", "", "TOTALS = [", ...totals, "]", "", "run_rows(ROWS)", "run_rows(TOTALS)", ""].join("\n");
const SCAFFOLD = spec([placeholder(1), placeholder(2)], [placeholder(3), placeholder(4)]);
const CORE = spec(ROWS.map((r) => `  ${r}`), [placeholder(3), placeholder(4)]);

const compare = (file: string, base: string | null) =>
  rowBlockDrifts(request, graph, () => file, "shadow", undefined, undefined, () => base)[0];

describe("scenario: R104 netfold core 1bb5f057, a second list's scaffold rows left for a later feature (#2969)", () => {
  test("the scaffold's rows the run left as they were are not added; its own rows are held", () => {
    const compared = compare(CORE, SCAFFOLD);
    expect(compared?.record.drifting).toEqual([]);
    expect(compared?.record.moves?.added).toEqual([]);
    expect(compared?.extras).toEqual([]);
    expect(compared?.record.fileRows?.filter((r) => r.base).map((r) => r.line)).toEqual([9, 10]);
  });

  test("without the base, the same file records both placeholders as added (the R104 record)", () => {
    expect(compare(CORE, null)?.extras.map((e) => [e.kind, e.line])).toEqual([
      ["added", 9],
      ["added", 10],
    ]);
  });

  test("a row of the run's own in the second list is still added", () => {
    const own = spec(ROWS.map((r) => `  ${r}`), [placeholder(3), placeholder(4), '  [["mask", "bogus"], "", 1, "", "bad mask\\n"],']);
    expect(compare(own, SCAFFOLD)?.extras.map((e) => [e.kind, e.line])).toEqual([["added", 11]]);
  });

  test("a scaffold row the run changed is added; one it copied is held only as often as the base held it", () => {
    const changed = spec(ROWS.map((r) => `  ${r}`), [placeholder(3), placeholder(4).replace("placeholder 4", "changed")]);
    expect(compare(changed, SCAFFOLD)?.extras.map((e) => [e.kind, e.line])).toEqual([["added", 10]]);
    const copied = spec(ROWS.map((r) => `  ${r}`), [placeholder(3), placeholder(4), placeholder(4)]);
    expect(compare(copied, SCAFFOLD)?.extras.map((e) => [e.kind, e.line])).toEqual([["added", 11]]);
  });

  test("a file the run created has no base: every unprescribed row is added", () => {
    expect(compare(CORE, null)?.record.moves?.added).toEqual([9, 10]);
  });

  test("the replay decides the moves from the record's base marks, as the run did", () => {
    const compared = compare(CORE, SCAFFOLD);
    expect(rowMoveDecision(compared?.record.fileRows ?? [])).toEqual(compared?.record.moves ?? { added: [], duplicated: [], reordered: [] });
  });

  test("a base row never takes the place of a prescribed row the file lacks", () => {
    // Row 2 missing; the untouched placeholder keeps its own place instead of `replaces: 2`.
    const partial = spec([`  ${ROWS[0]}`], [placeholder(3), placeholder(4)]);
    const fileRows = measureFileRows(request.split("```text\n")[1]?.split("\n").slice(1, 3) ?? [], partial, SCAFFOLD);
    expect(fileRows.filter((r) => r.base).every((r) => r.replaces === null)).toBe(true);
  });
});
