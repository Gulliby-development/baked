import { describe, expect, test } from "bun:test";
import { join, resolve, sep } from "node:path";
import {
  findFileDiffStat,
  formatDiffStatLines,
  formatDiffTotals,
  type SessionDiffStats,
  toolCallEditPaths,
} from "../src/core/chat/diff-stats.js";

const MINUS = "\u2212";
// How sessionDiffStats writes a file outside the workspace: absolute, with forward slashes.
const OUTSIDE = resolve("/elsewhere/x.ts").split(sep).join("/");

const stats: SessionDiffStats = {
  base: "HEAD",
  files: [
    { path: "src/a.ts", status: "modified", added: 12, removed: 3 },
    { path: "src/new.ts", status: "added", added: 40, removed: 0 },
    { path: "logo.png", status: "modified", added: 0, removed: 0, binary: true },
    { path: OUTSIDE, status: "outside", added: 0, removed: 0 },
  ],
  totals: { files: 3, added: 52, removed: 3 },
};

describe("diff stats for the terminal surfaces", () => {
  test("tool calls name the files they write", () => {
    expect(toolCallEditPaths("edit_file", { path: "a.ts" })).toEqual(["a.ts"]);
    expect(toolCallEditPaths("write_file", { file: "b.ts" })).toEqual(["b.ts"]);
    expect(toolCallEditPaths("rename_file", { from: "c.ts", to: "d.ts" })).toEqual(["c.ts", "d.ts"]);
    expect(toolCallEditPaths("read_file", { path: "a.ts" })).toEqual([]);
    expect(toolCallEditPaths("edit_file", undefined)).toEqual([]);
  });

  test("totals read as added, removed and file count", () => {
    expect(formatDiffTotals(stats)).toBe(`+52 ${MINUS}3 in 3 files`);
    expect(
      formatDiffTotals({ ...stats, totals: { files: 1, added: 1, removed: 0 } }),
    ).toBe(`+1 ${MINUS}0 in 1 file`);
  });

  test("one aligned line per file, with the status unless it is a plain edit", () => {
    expect(formatDiffStatLines(stats)).toEqual([
      `+12 ${MINUS}3  src/a.ts`,
      `+40 ${MINUS}0  src/new.ts (added)`,
      "binary  logo.png",
      `+0 ${MINUS}0   ${OUTSIDE} (outside)`,
    ]);
  });

  test("a file is found whether the tool named it relative or absolute", () => {
    const root = resolve("/work", "repo");
    expect(findFileDiffStat(stats, root, "src/a.ts")?.added).toBe(12);
    expect(findFileDiffStat(stats, root, join(root, "src", "new.ts"))?.status).toBe("added");
    expect(findFileDiffStat(stats, root, resolve("/elsewhere/x.ts"))?.status).toBe("outside");
    expect(findFileDiffStat(stats, root, "missing.ts")).toBeUndefined();
  });
});
