import { describe, expect, test } from "bun:test";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";

// Bench round 32, notesift (#1314): the decomposer split the link graph, checks and tags into six
// features of one source file each. Each feature run repeats research, specification, planning,
// analysis and review, so those six paid 27 percent of the initiative in fixed stages.
describe("decomposer feature floor", () => {
  const decomposer = builtinProfiles.find((p) => p.id === "decomposer");

  test("the decomposer is told what a feature run costs and to merge features below the floor", () => {
    const text = decomposer?.instructions ?? "";
    expect(text).toContain("pays a fixed cost besides its tasks");
    expect(text).toContain("at least three files or a group of at least three related behaviors");
    expect(text).toContain("merge a smaller one into a sibling with the same dependencies");
    expect(text).toContain("The host merges features of one or two paths");
    expect(decomposer?.version).toBe("1.9.0");
  });

  // Bench round 42, fecsmith (#1504): the brief named every command file, the decomposer wrote
  // `commands/*Command.java`, and the estimate could not count the feature's files.
  test("the decomposer lists named files by path and keeps globs for open sets", () => {
    const text = decomposer?.instructions ?? "";
    expect(text).toContain("each file by its path when the request or the code names it");
    expect(text).toContain("a glob only for an open set of files that nobody lists");
  });
});
