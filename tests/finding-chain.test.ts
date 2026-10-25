import { describe, expect, test } from "bun:test";
import { batteryOf, type ChainFinding, chainMembers, chainRecord, chainRewriteDecision, chainSubject, findingChain, rewritesSymbol } from "../src/core/workflows/finding-chain.js";

// The join rules of a finding chain. A new join rule adds a case here with a pair the older rule
// failed to join (AGENTS.md).

const finding = (id: string, fields: Partial<ChainFinding> = {}): ChainFinding => ({ id, file: "src/test/java/amp/ReaderNumericTest.java", symbol: null, family: null, repeatOf: null, repairTaskId: null, claim: id, severity: "medium", status: "resolved", requirementIds: [], criterionIds: [], ...fields });
const byId = (findings: ChainFinding[]) => new Map(findings.map((f) => [f.id, f]));

describe("R67 ampwhy: a reviewer's repeatOf on one file when the earlier finding has no symbol (#2098)", () => {
  const F2 = finding("F2", { repairTaskId: "T005" });
  const F4 = finding("F4", { symbol: "leadingZerosBoundariesAndLongRunsSaturateWithoutLosingConsumption", repeatOf: "F2" });

  test("F2 without a symbol and F4 with one, linked by repeatOf, are a chain of two", () => {
    const all = byId([F2, F4]);
    expect(findingChain(all, F4).map((f) => f.id)).toEqual(["F2", "F4"]);
    expect(chainRewriteDecision(findingChain(all, F4).length, "on")).toBe("rewrite");
    // Either side may lack the symbol.
    const reversed = byId([finding("F2", { symbol: "Reader.read" }), finding("F4", { repeatOf: "F2" })]);
    expect(findingChain(reversed, reversed.get("F4") as ChainFinding)).toHaveLength(2);
  });

  test("a family on both findings is a chain of two without the symbol either", () => {
    const all = byId([finding("F2", { family: "missing-mode" }), finding("F4", { symbol: "rowsInOneMode", family: "missing-mode", repeatOf: "F2" })]);
    expect(findingChain(all, all.get("F4") as ChainFinding)).toHaveLength(2);
  });

  test("no link and no key is a chain of one", () => {
    const all = byId([F2, finding("F4", { symbol: "rowsInOneMode" })]);
    expect(findingChain(all, all.get("F4") as ChainFinding)).toHaveLength(1);
  });

  test("a reviewer's link to another file, or between two different symbols without a family, is no join", () => {
    const otherFile = byId([finding("F2", { file: "src/test/java/amp/ReaderNamedTest.java" }), finding("F4", { repeatOf: "F2" })]);
    expect(findingChain(otherFile, otherFile.get("F4") as ChainFinding)).toHaveLength(1);
    const unnamed = byId([finding("F2", { file: null }), finding("F4", { repeatOf: "F2" })]);
    expect(findingChain(unnamed, unnamed.get("F4") as ChainFinding)).toHaveLength(1);
    const symbols = byId([finding("F2", { symbol: "Reader.read" }), finding("F4", { symbol: "Value.of", repeatOf: "F2" })]);
    expect(findingChain(symbols, symbols.get("F4") as ChainFinding)).toHaveLength(1);
  });

  test("a side branch without a symbol joins the chain's members", () => {
    const all = byId([F2, F4, finding("F5", { repeatOf: "F2" })]);
    expect(chainMembers(all, findingChain(all, F4)).map((f) => f.id)).toEqual(["F2", "F4", "F5"]);
  });

  test("a rewrite decision on a test file routes to the test sweep and has no battery", () => {
    const all = byId([F2, F4]);
    const record = chainRecord("T006", F4, findingChain(all, F4), "on");
    expect(record).toMatchObject({ decision: "rewrite", corrective: "test-sweep", length: 2, symbol: "leadingZerosBoundariesAndLongRunsSaturateWithoutLosingConsumption" });
    expect(rewritesSymbol(record)).toBe(false);
    expect(batteryOf(all, record)).toEqual([]);
    // Off, the decision is a patch and no route is recorded.
    expect(chainRecord("T006", F4, findingChain(all, F4), "off").corrective).toBeUndefined();
  });

  test("a chain on a source file without a symbol still rewrites, named by its file", () => {
    const source = { file: "src/main/java/amp/Reader.java" };
    const all = byId([finding("F2", source), finding("F4", { ...source, repeatOf: "F2" })]);
    const record = chainRecord("T006", all.get("F4") as ChainFinding, findingChain(all, all.get("F4") as ChainFinding), "on");
    expect(record.corrective).toBeUndefined();
    expect(rewritesSymbol(record)).toBe(true);
    expect(chainSubject(record)).toBe("src/main/java/amp/Reader.java");
  });
});
