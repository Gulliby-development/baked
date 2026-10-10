import { describe, expect, test } from "bun:test";
import { editFileTool } from "../src/core/tools/edit-file.js";
import { multiEditTool } from "../src/core/tools/multi-edit.js";
import { withoutAstEditHint } from "../src/core/tools/tool-utils.js";

// Run 6bb3052f: an implementer without ast_edit refused to edit src/site.ts because the edit tool
// descriptions send TS/JS edits to ast_edit.
describe("edit tools offered without ast_edit", () => {
  test("drop the hint that TS/JS files need ast_edit", () => {
    for (const tool of [editFileTool, multiEditTool]) {
      const description = withoutAstEditHint(tool.description);
      expect(description).not.toContain("ast_edit");
      expect(description).not.toContain("non-TS/JS");
      expect(description).toContain("lineStart");
    }
  });
});
