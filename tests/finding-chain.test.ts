import { describe, expect, test } from "bun:test";
import { batteryOf, type ChainFinding, chainMembers, chainRecord, chainRewriteDecision, chainSubject, correctiveChain, findingChain, rewritesSymbol, symbolKey, symbolPath, unchangedRepeats } from "../src/core/workflows/finding-chain.js";

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

describe("R68 ewvet scanner: a reviewer's repeatOf from a class to its member (#2137)", () => {
  // The run's seven findings: F1 on the class, the rest on one member, all but F1-2 `repeatOf: F1`.
  const file = { file: "src/Ewvet/Scan/Scanner.cs" };
  const member = "Scanner.IsEncodingToken";
  const F1 = finding("F1", { ...file, symbol: "Scanner", repairTaskId: "T009" });
  const findings = [
    F1,
    finding("F1-2", { ...file, symbol: member, repairTaskId: "T009" }),
    finding("F1-repeat", { ...file, symbol: member, repeatOf: "F1", repairTaskId: "T011" }),
    ...["F1-3", "F1-4", "F1-5", "F1-6"].map((id) => finding(id, { ...file, symbol: member, repeatOf: "F1", status: "open" })),
  ];
  const all = byId(findings);
  const at = (id: string) => findingChain(all, all.get(id) as ChainFinding).map((f) => f.id);

  test("F1-3 on the member, repeatOf F1 on the class, is the second link: the old rule left it a chain of one", () => {
    // The last names differ, and neither finding has a family or lacks a symbol.
    expect(symbolKey("Scanner")).not.toBe(symbolKey(member));
    expect(symbolPath(member)).toEqual(["Scanner", "IsEncodingToken"]);
    expect(at("F1-3")).toEqual(["F1", "F1-3"]);
    expect(chainRewriteDecision(at("F1-3").length, "on")).toBe("rewrite");
    expect(correctiveChain(all, [{ id: "F1-3" }])?.chain.map((f) => f.id)).toEqual(["F1", "F1-3"]);
    // F1-2 names no repeatOf and no family: no link.
    expect(at("F1-2")).toEqual(["F1-2"]);
  });

  test("the chain's members are every finding linked to F1, its record names both symbols", () => {
    expect(chainMembers(all, findingChain(all, all.get("F1-6") as ChainFinding)).map((f) => f.id)).toEqual(["F1", "F1-repeat", "F1-3", "F1-4", "F1-5", "F1-6"]);
    const record = chainRecord("T012", all.get("F1-3") as ChainFinding, findingChain(all, all.get("F1-3") as ChainFinding), "on");
    expect(record).toMatchObject({ decision: "rewrite", symbol: "IsEncodingToken", symbols: ["Scanner", "IsEncodingToken"] });
    expect(record.corrective).toBeUndefined();
  });

  test("a link from a class to a member of another file, or to another class's member, stays unjoined", () => {
    const other = byId([F1, finding("F2", { file: "src/Ewvet/Scan/Lexer.cs", symbol: member, repeatOf: "F1" })]);
    expect(findingChain(other, other.get("F2") as ChainFinding)).toHaveLength(1);
    const sibling = byId([F1, finding("F2", { ...file, symbol: "Lexer.IsEncodingToken", repeatOf: "F1" })]);
    expect(findingChain(sibling, sibling.get("F2") as ChainFinding)).toHaveLength(1);
  });
});

describe("R68 ewvet scanner: a finding back after its corrective changed no file (#2137)", () => {
  const file = { file: "src/Ewvet/Scan/Scanner.cs" };
  const F1 = finding("F1", { ...file, symbol: "Scanner", claim: "IsEncodingToken  misses the BOM", repairTaskId: "T010" });
  const changes: Record<string, string[] | null> = { T010: [], T011: ["src/Ewvet/Scan/Scanner.cs"] };
  const changedOf = (taskId: string) => changes[taskId] ?? null;

  test("a repeatOf of the finding an empty corrective addressed is a repeat without change", () => {
    const repeat = finding("F1-repeat", { ...file, symbol: "Scanner.IsEncodingToken", repeatOf: "F1", status: "open" });
    expect(unchangedRepeats(byId([F1, repeat]), [repeat], changedOf)).toEqual([{ findingId: "F1-repeat", earlierId: "F1", taskId: "T010", changed: [], chain: ["F1", "F1-repeat"] }]);
  });

  test("without repeatOf, the same claim on the same file counts, case and spacing folded", () => {
    const again = finding("F3", { ...file, symbol: null, claim: "isencodingtoken misses the BOM ", status: "open" });
    expect(unchangedRepeats(byId([F1, again]), [again], changedOf).map((r) => [r.findingId, r.earlierId])).toEqual([["F3", "F1"]]);
    const elsewhere = finding("F3", { file: "src/Ewvet/Scan/Lexer.cs", claim: F1.claim, status: "open" });
    expect(unchangedRepeats(byId([F1, elsewhere]), [elsewhere], changedOf)).toEqual([]);
  });

  test("a corrective that changed a file, recorded no change yet, or a new defect is no repeat without change", () => {
    const changed = finding("F1", { ...F1, repairTaskId: "T011" });
    const repeat = finding("F1-repeat", { ...file, repeatOf: "F1", status: "open" });
    expect(unchangedRepeats(byId([changed, repeat]), [repeat], changedOf)).toEqual([]);
    expect(unchangedRepeats(byId([finding("F1", { ...F1, repairTaskId: "T099" }), repeat]), [repeat], changedOf)).toEqual([]);
    expect(unchangedRepeats(byId([F1, finding("F2", { ...file, claim: "Another defect", status: "open" })]), [{ id: "F2" }], changedOf)).toEqual([]);
  });
});
