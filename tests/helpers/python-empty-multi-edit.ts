import { multiEditTool } from "../../src/core/tools/multi-edit.js";

const result = await multiEditTool.execute({
  path: process.argv[2]!,
  edits: [
    { oldString: "assert total() == 1", newString: "assert total() == 2" },
    { oldString: "", newString: "assert total() == 3" },
  ],
});
process.stdout.write(JSON.stringify(result));
