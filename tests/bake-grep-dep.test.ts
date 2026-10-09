import { describe, expect, test } from "bun:test";
import { resolveDepSearch, annotateDepNoMatch, type DepResolution } from "../src/core/tools/bake-grep";
import type { ToolResult } from "../src/types";

describe("resolveDepSearch", () => {
  test("explicit path returns it directly with --no-ignore --follow", () => {
    const res = resolveDepSearch("react", "some/custom/path");
    expect(res.searchPath).toBe("some/custom/path");
    expect(res.extraArgs).toContain("--no-ignore");
    expect(res.extraArgs).toContain("--follow");
    expect(res.resolved).toBe(true);
  });

  test("dep=true searches everything", () => {
    const res = resolveDepSearch("true");
    expect(res.searchPath).toBe(".");
    expect(res.extraArgs).toContain("--no-ignore");
    expect(res.extraArgs).toContain("--follow");
    expect(res.resolved).toBe(true);
  });

  test("empty dep searches everything", () => {
    const res = resolveDepSearch("");
    expect(res.searchPath).toBe(".");
    expect(res.resolved).toBe(true);
  });

  test("unknown dep falls back to glob pattern", () => {
    const res = resolveDepSearch("nonexistent-package-xyz");
    expect(res.searchPath).toBe(".");
    expect(res.extraArgs).toContain("--no-ignore");
    expect(res.extraArgs).toContain("--follow");
    expect(res.extraArgs.some((a) => a.includes("--glob="))).toBe(true);
    expect(res.extraArgs.some((a) => a.includes("nonexistent-package-xyz"))).toBe(true);
    expect(res.resolved).toBe(false);
  });

  test("glob pattern has correct format for unknown packages", () => {
    const res = resolveDepSearch("totally-nonexistent-pkg-xyz");
    const globArg = res.extraArgs.find((a) => a.startsWith("--glob="));
    expect(globArg).toBe("--glob=**/totally-nonexistent-pkg-xyz/**");
  });

  test("scoped packages resolve directly if found in node_modules", () => {
    // @opentui/core exists in this repo's node_modules
    const res = resolveDepSearch("@opentui/core");
    if (res.resolved) {
      expect(res.searchPath).toContain("node_modules/@opentui/core");
    } else {
      const globArg = res.extraArgs.find((a) => a.startsWith("--glob="));
      expect(globArg).toBe("--glob=**/@opentui/core/**");
    }
  });

  test("dep field is preserved on resolution", () => {
    const res = resolveDepSearch("lodash");
    expect(res.dep).toBe("lodash");
  });
});

describe("annotateDepNoMatch", () => {
  const makeDepRes = (resolved: boolean, dep: string, searchPath = "."): DepResolution => ({
    searchPath,
    extraArgs: ["--no-ignore", "--follow"],
    resolved,
    dep,
  });

  test("passes through results with matches", () => {
    const result: ToolResult = { success: true, output: "src/foo.ts:10:import React" };
    const depRes = makeDepRes(true, "react", "node_modules/react");
    expect(annotateDepNoMatch(result, depRes)).toBe(result);
  });

  test("annotates no-match for resolved dep (installed but pattern not found)", () => {
    const result: ToolResult = { success: true, output: "No matches found." };
    const depRes = makeDepRes(true, "react", "node_modules/react");
    const annotated = annotateDepNoMatch(result, depRes);
    expect(annotated.output).toContain("installed but does not contain this pattern");
    expect(annotated.output).toContain("react");
  });

  test("annotates no-match for unresolved dep (not installed)", () => {
    const result: ToolResult = { success: true, output: "No matches found." };
    const depRes = makeDepRes(false, "zustand");
    const annotated = annotateDepNoMatch(result, depRes);
    expect(annotated.output).toContain("was not found in any vendor directory");
    expect(annotated.output).toContain("zustand");
    expect(annotated.output).toContain("package manager install");
  });

  test("annotates count mode zero matches for resolved dep", () => {
    const result: ToolResult = { success: true, output: "0 matches." };
    const depRes = makeDepRes(true, "lodash", "node_modules/lodash");
    const annotated = annotateDepNoMatch(result, depRes);
    expect(annotated.output).toContain("installed but does not contain this pattern");
  });

  test("annotates count mode zero matches for unresolved dep", () => {
    const result: ToolResult = { success: true, output: "0 matches." };
    const depRes = makeDepRes(false, "some-pkg");
    const annotated = annotateDepNoMatch(result, depRes);
    expect(annotated.output).toContain("was not found in any vendor directory");
  });
});
