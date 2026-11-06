import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFormatCache } from "../src/core/tools/auto-format.js";
import { editFileTool } from "../src/core/tools/edit-file.js";
import { clearEditStacks } from "../src/core/tools/edit-stack.js";
import { oldStringRange, rangeText, replaceRange } from "../src/core/tools/line-range.js";
import { multiEditTool } from "../src/core/tools/multi-edit.js";
import { getCwd, setCwd } from "../src/core/cwd.js";
import { NO_EDIT_STEPS, REPEATED_READS, stillStuck, type WatchStep, watchSteps } from "../src/core/workflows/progress-watch.js";

// Bench round 106 (#2981). tokenpare filters T005 removed two `--version` placeholder rows of
// ToppRows.cs with edit_file, lineStart 11 and an oldString of the two lines with a final newline.
// The range counted the empty piece after that newline as a third line, its text never equalled
// oldString, and every call failed with "oldString does not match lines 11-13". The watcher took
// each failed call as an edit, so it never steered: 17 calls, then 10 in the restart, 492k tokens.

const TMP = join(tmpdir(), `baked-edit-newline-${process.pid}`);
const ORIG_CWD = getCwd();
beforeEach(async () => {
  clearEditStacks();
  setFormatCache(null);
  await mkdir(TMP, { recursive: true });
  setCwd(TMP, { changeProcess: false });
});
afterAll(async () => {
  setCwd(ORIG_CWD, { changeProcess: false });
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

const TOPP = [
  "namespace Tokenpare.Tests;",
  "",
  "public class ToppRows",
  "{",
  "    [Theory]",
  '    [InlineData("topp 2", "a b", "a b")]',
  '    [InlineData("topp 1", "c", "c")]',
  '    [InlineData("topp 3", "d e f", "d e f")]',
  '    [InlineData("topp 0", "", "")]',
  '    [InlineData("topp 9", "g", "g")]',
  '    [InlineData("--version", "", "0.0.0")]',
  '    [InlineData("--version", "x", "0.0.0")]',
  "    public void Rows(string args, string input, string output) => Check(args, input, output);",
  "}",
  "",
].join("\n");
const PLACEHOLDERS = `${TOPP.split("\n").slice(10, 12).join("\n")}\n`;
const WITHOUT = TOPP.replace(PLACEHOLDERS, "");

const MD = ["# tokenpare", "", "## Usage", "", "Old line one.", "Old line two.", "", "## More", ""].join("\n");

async function file(name: string, text: string): Promise<string> {
  const path = join(TMP, name);
  await writeFile(path, text, "utf-8");
  return path;
}

describe("scenario: R106 tokenpare filters T005, a lineStart edit whose oldString ends in a newline (#2981)", () => {
  test("C#: the two placeholder rows go, by edit_file and by multi_edit", async () => {
    const path = await file("ToppRows.cs", TOPP);
    const result = await editFileTool.execute({ path, oldString: PLACEHOLDERS, newString: "", lineStart: 11 });
    expect(result.success).toBe(true);
    expect(await readFile(path, "utf8")).toBe(WITHOUT);
    await writeFile(path, TOPP);
    clearEditStacks();
    const multi = await multiEditTool.execute({ path, edits: [{ oldString: PLACEHOLDERS, newString: "", lineStart: 11 }] });
    expect(multi.success).toBe(true);
    expect(await readFile(path, "utf8")).toBe(WITHOUT);
  });

  test("a one-line range with its newline, replaced by a line with its own", async () => {
    const path = await file("One.cs", TOPP);
    const row = `${TOPP.split("\n")[9]}\n`;
    const result = await editFileTool.execute({ path, oldString: row, newString: row.replace("topp 9", "topp 8"), lineStart: 10 });
    expect(result.success).toBe(true);
    expect(await readFile(path, "utf8")).toBe(TOPP.replace("topp 9", "topp 8"));
  });

  test("Markdown: a two-line paragraph with its newline, by edit_file and by multi_edit next to another edit", async () => {
    const path = await file("README.md", MD);
    const want = MD.replace("Old line one.\nOld line two.\n", "New text.\n");
    const result = await editFileTool.execute({ path, oldString: "Old line one.\nOld line two.\n", newString: "New text.\n", lineStart: 5 });
    expect(result.success).toBe(true);
    expect(await readFile(path, "utf8")).toBe(want);
    await writeFile(path, MD);
    clearEditStacks();
    const multi = await multiEditTool.execute({
      path,
      edits: [
        { oldString: "Old line one.\nOld line two.\n", newString: "New text.\n", lineStart: 5 },
        { oldString: "## More\n", newString: "## Further\n", lineStart: 8 },
      ],
    });
    expect(multi.success).toBe(true);
    expect(await readFile(path, "utf8")).toBe(want.replace("## More", "## Further"));
  });

  test("a range at the file's end without a newline after it does not take one", () => {
    const lines = ["a", "b"];
    expect(oldStringRange(lines, "b\n", 2)).toBeNull();
    expect(oldStringRange(lines, "b", 2)).toEqual({ start: 1, end: 2, trailing: false });
    const range = oldStringRange(["a", "b", ""], "b\n", 2);
    expect(range && rangeText(["a", "b", ""], range)).toBe("b\n");
    expect(range && replaceRange(["a", "b", ""], range, "")).toBe("a\n");
  });
});

describe("the progress watcher does not count a failed edit (#2981)", () => {
  const input = { path: "ToppRows.cs", oldString: PLACEHOLDERS, newString: "", lineStart: 11 };
  const failed: WatchStep = {
    toolCalls: [{ toolName: "edit_file", input }],
    toolResults: [{ toolName: "edit_file", input, output: { success: false, output: "oldString does not match lines 11-13.", error: "oldString mismatch at line range" } }],
  };
  const done: WatchStep = {
    toolCalls: [{ toolName: "edit_file", input }],
    toolResults: [{ toolName: "edit_file", input, output: { success: true, output: "Edited" } }],
  };

  test("the same failing edit, repeated, is steered", () => {
    const finding = watchSteps(Array.from({ length: REPEATED_READS }, () => failed), { mustEdit: true });
    expect(finding?.signal).toBe("repeated-reads");
    expect(finding?.detail).toContain("failed 3 times with the same input since the last edit");
    // Before the fix each call was the last edit, so nothing was ever found.
    expect(watchSteps([done, done, done], { mustEdit: true })).toBeNull();
  });

  test("failed edits count toward no-edits", () => {
    const varied = Array.from({ length: NO_EDIT_STEPS }, (_, k): WatchStep => {
      const own = { ...input, lineStart: k + 1 };
      return { toolCalls: [{ toolName: "edit_file", input: own }], toolResults: [{ toolName: "edit_file", input: own, output: { success: false, output: "no" } }] };
    });
    expect(watchSteps(varied, { mustEdit: true })?.signal).toBe("no-edits");
  });

  test("after the steering, a failed edit is no progress and its repeat is a stop; a successful one is progress", () => {
    const finding = watchSteps([failed, failed, failed], { mustEdit: true });
    if (!finding) throw new Error("no finding");
    expect(stillStuck(finding, [failed, failed, failed, failed, failed], 3, 2)).toBe("stuck");
    expect(stillStuck(finding, [failed, failed, failed, done], 3, 2)).toBe("progress");
  });
});
