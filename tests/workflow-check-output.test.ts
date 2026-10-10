import { describe, expect, test } from "bun:test";
import { passedOutputNote } from "../src/core/verification/check-runner.js";

describe("check output note", () => {
  // Run 1185f909: "9 pass 0 fail" with exit code 1 because a test ran the CLI in-process.
  test("explains a nonzero exit when every test passed", () => {
    const note = passedOutputNote("bun test v1.4.3\n\n 9 pass\n 0 fail\n 20 expect() calls\n", 1);
    expect(note).toContain("process.exitCode");
    expect(passedOutputNote("===== 12 passed in 0.31s =====", 1)).not.toBeNull();
  });

  test("stays silent on real failures and on success", () => {
    expect(passedOutputNote(" 9 pass\n 1 fail\n", 1)).toBeNull();
    expect(passedOutputNote("== 1 failed, 11 passed in 0.31s ==", 1)).toBeNull();
    expect(passedOutputNote(" 9 pass\n 0 fail\n", 0)).toBeNull();
    expect(passedOutputNote("error: Cannot find module './cli'", 1)).toBeNull();
  });
});
