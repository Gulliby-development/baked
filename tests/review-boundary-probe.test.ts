import { describe, expect, test } from "bun:test";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";

describe("correctness review of boundary inputs", () => {
  test("the reviewer runs empty and zero inputs a criterion names and compares raw values strictly", () => {
    const reviewer = builtinProfiles.find((p) => p.id === "reviewer");
    expect(reviewer?.allowedTools).toContain("run_repro");
    expect(reviewer?.instructions).toContain("empty, zero or single-element input");
    expect(reviewer?.instructions).toContain("Object.is");
  });
});
