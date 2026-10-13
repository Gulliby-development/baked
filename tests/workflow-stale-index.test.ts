import { describe, expect, test } from "bun:test";
import { markStaleIndexResult, writtenInRoot } from "../src/core/workflows/stale-index.js";
import type { EffectRow } from "../src/core/workflows/store.js";

const effect = (path: string, root: string | null, status: EffectRow["status"] = "applied"): EffectRow => ({
  id: path,
  attempt_id: "a",
  kind: "file_patch",
  status,
  intent_json: JSON.stringify({ path, tool: "edit_file", ...(root ? { root } : {}) }),
  before_hash: null,
  after_hash: null,
});

describe("index answers in a worktree run", () => {
  test("the run's applied edits in its own worktree count as changed", () => {
    const root = ".baked/worktrees/run-1/main";
    expect(
      writtenInRoot(
        [
          effect("src/store.ts", root),
          effect("src/store.ts", root),
          effect("src/view.ts", root, "prepared"),
          effect("src/other.ts", ".baked/worktrees/run-2/main"),
          effect("src/inline.ts", null),
        ],
        root,
      ),
    ).toEqual(["src/store.ts"]);
  });

  test("an answer that cites a changed file says to read it first; others are unchanged", () => {
    const found = { success: true, output: "src/store.ts:120 function save()\nsrc/view.ts:4 render" };
    const marked = markStaleIndexResult(found, ["src/store.ts", "src/new.ts"]);
    expect(marked.output).toStartWith(found.output);
    expect(marked.output).toContain("may be out of date: src/store.ts. Read these files");
    expect(marked.output).not.toContain("src/new.ts.");
    expect(markStaleIndexResult(found, ["src/absent.ts"])).toBe(found);
    expect(markStaleIndexResult(found, [])).toBe(found);
    const windows = { success: true, output: "src\\store.ts:120 function save()" };
    expect(markStaleIndexResult(windows, ["src/store.ts"]).output).toContain("out of date: src/store.ts");
  });
});
