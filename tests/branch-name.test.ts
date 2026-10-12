import { describe, expect, test } from "bun:test";
import { branchNameProblem } from "../scripts/check-branch-name";

describe("branch naming rule", () => {
  test("accepts feature and bugfix branches, with or without a platform suffix", () => {
    for (const branch of [
      "feature/desktop-checkpoints",
      "feature/desktop-checkpoints-sgmb4g",
      "bugfix/eol-aware-edits",
      "bugfix/branch-naming-rule-w9dyrm",
      "feature/go-dotnet-language-support",
    ]) {
      expect(branchNameProblem(branch)).toBeNull();
    }
  });

  test("exempts Dependabot branches", () => {
    expect(branchNameProblem("dependabot/bun/minor-and-patch-27f468aa5a")).toBeNull();
  });

  test("rejects other prefixes and generic names", () => {
    for (const branch of [
      "claude/project-thread-88mrvl",
      "claude/fix-ebusy-test-lease-6evgyt",
      "docs/bench-loop-objective",
      "fix/something",
      "feature/project-thread-88mrvl",
      "feature/",
      "Feature/Desktop",
      "main",
    ]) {
      expect(branchNameProblem(branch)).not.toBeNull();
    }
  });
});
