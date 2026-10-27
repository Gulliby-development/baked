import { describe, expect, test } from "bun:test";
import { batteryOf, type ChainFinding, chainMembers, chainRecord, chainRewriteDecision, chainSubject, correctiveChain, findingChain, rewritesSymbol, patchLines, recordRestoredRemovals, replayRestoredRemovals, restoredRemovals, symbolKey, symbolPath, unchangedRepeats } from "../src/core/workflows/finding-chain.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { Task } from "../src/core/workflows/types.js";

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

describe("R74 callmend cmd: one family on another spec file each round (#2334)", () => {
  const F1 = finding("F1", { file: "spec/cmd/stream_command_spec.rb", family: "literal-test-inputs", repairTaskId: "T015" });
  const F12 = finding("F1-2", { file: "spec/cmd/check_command_spec.rb", family: "literal-test-inputs", repeatOf: "F1", repairTaskId: "T016" });

  test("F1-2 on check_command_spec.rb, repeatOf F1 on stream_command_spec.rb, is the second link: the old rule left it a chain of one", () => {
    const all = byId([F1, F12]);
    expect(findingChain(all, F12).map((f) => f.id)).toEqual(["F1", "F1-2"]);
    const record = chainRecord("T016", F12, findingChain(all, F12), "on");
    expect([record.decision, record.corrective, record.files]).toEqual(["rewrite", "test-sweep", ["spec/cmd/stream_command_spec.rb", "spec/cmd/check_command_spec.rb"]]);
    expect(rewritesSymbol(record)).toBe(false);
  });

  test("the family alone joins two test files; a link across files needs one family", () => {
    const unlinked = byId([F1, { ...F12, repeatOf: null }]);
    expect(findingChain(unlinked, unlinked.get("F1-2") as ChainFinding)).toHaveLength(2);
    const otherFamily = byId([F1, { ...F12, family: "missing-exit-code" }]);
    expect(findingChain(otherFamily, otherFamily.get("F1-2") as ChainFinding)).toHaveLength(1);
    const noFamily = byId([{ ...F1, family: null }, { ...F12, family: null }]);
    expect(findingChain(noFamily, noFamily.get("F1-2") as ChainFinding)).toHaveLength(1);
  });

  test("two source files of one family join only by the reviewer's link", () => {
    const source = (id: string, file: string, repeatOf: string | null) => finding(id, { file, family: "utf8-byte-offsets", symbol: null, repeatOf, repairTaskId: `T0${id.slice(1)}` });
    const unlinked = byId([source("F1", "lib/a.rb", null), source("F2", "lib/b.rb", null)]);
    expect(findingChain(unlinked, unlinked.get("F2") as ChainFinding)).toHaveLength(1);
    const linked = byId([source("F1", "lib/a.rb", null), source("F2", "lib/b.rb", "F1")]);
    expect(findingChain(linked, linked.get("F2") as ChainFinding)).toHaveLength(2);
    expect(chainMembers(linked, findingChain(linked, linked.get("F2") as ChainFinding)).map((f) => f.id)).toEqual(["F1", "F2"]);
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

// R72 evalpin foundation (#2277): T008 removed `#[allow(unused_variables)]` from the prescribed cli
// stub for the integrity guard, T009 put it back for `cargo clippy -D warnings`, and five
// correctives ran before the spec conflict opened. The second link is the contradiction.
describe("a corrective that restores what the previous corrective removed (#2277)", () => {
  const ALLOW = "#[allow(unused_variables)]";
  const removeAllow = `--- a/src/cli.rs\n+++ b/src/cli.rs\n@@ -1,3 +1,2 @@\n-${ALLOW}\n pub fn run(args: &[String]) -> i32 {\n     2\n`;
  const restoreAllow = `--- a/src/cli.rs\n+++ b/src/cli.rs\n@@ -1,2 +1,3 @@\n+${ALLOW}\n pub fn run(args: &[String]) -> i32 {\n     2\n`;
  const T008 = { taskId: "T008", findingIds: ["F-integrity"], patch: removeAllow };
  const T009 = { taskId: "T009", findingIds: ["F-clippy"], patch: restoreAllow };

  test("T009 restoring T008's removal is one restore naming both correctives' findings", () => {
    expect(restoredRemovals(T009, [T008])).toEqual([
      { taskId: "T009", findingIds: ["F-clippy"], path: "src/cli.rs", earlierTaskId: "T008", earlierFindingIds: ["F-integrity"], lines: [ALLOW] },
    ]);
  });

  test("only the latest earlier corrective of the file counts, and moved or trivial lines are no removal", () => {
    // A later corrective of the file that kept the line out stands between them: T009 restores
    // what T008b removed only if T008b removed it.
    const unrelated = { taskId: "T008b", findingIds: ["F2"], patch: "--- a/src/cli.rs\n+++ b/src/cli.rs\n@@ -5 +5 @@\n-    let x = 1;\n+    let x = 2;\n" };
    expect(restoredRemovals(T009, [T008, unrelated])).toEqual([]);
    // A line the earlier corrective moved (removed and added) is not removed.
    const moved = { ...T008, patch: `${removeAllow}@@ -9 +9 @@\n+${ALLOW}\n` };
    expect(restoredRemovals(T009, [moved])).toEqual([]);
    // A closing brace put back is no contradiction.
    const brace = { taskId: "T001", findingIds: [], patch: "--- a/src/cli.rs\n+++ b/src/cli.rs\n@@ -3 +2 @@\n-}\n" };
    expect(restoredRemovals({ ...T009, patch: "--- a/src/cli.rs\n+++ b/src/cli.rs\n@@ -2 +3 @@\n+}\n" }, [brace])).toEqual([]);
    // Another file is another chain.
    expect(restoredRemovals({ ...T009, patch: restoreAllow.replaceAll("src/cli.rs", "src/main.rs") }, [T008])).toEqual([]);
  });

  test("a removed line that starts with -- is a line, not a file header", () => {
    const sql = "--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1 @@\n--- noqa: AM04\n SELECT 1\n";
    expect(patchLines(sql).get("q.sql")).toEqual({ removed: ["-- noqa: AM04"], added: [] });
    expect(patchLines("--- /dev/null\n+++ b/new.rs\n@@ -0,0 +1 @@\n+fn a() {}\n").get("new.rs")).toEqual({ removed: [], added: ["fn a() {}"] });
  });

  test("the run records the would-stop once, and the chain decision for the replay", () => {
    const tasks = [
      { id: "T001", origin: "planned", findingIds: [] },
      { id: "T008", origin: "repair", findingIds: ["F-integrity"] },
      { id: "T009", origin: "convergence", findingIds: ["F-clippy"] },
    ] as unknown as Task[];
    const artifacts: { id: string; kind: string; logical_path: string; body: string }[] = [
      { id: "a1", kind: "diff", logical_path: "tasks/T008/diff.json", body: JSON.stringify({ changed: ["src/cli.rs"], patch: removeAllow }) },
      { id: "a2", kind: "diff", logical_path: "tasks/T009/diff.json", body: JSON.stringify({ changed: ["src/cli.rs"], patch: restoreAllow }) },
    ];
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const store = {
      artifacts: () => artifacts,
      readArtifact: (_: string, id: string) => artifacts.find((a) => a.id === id)?.body ?? "",
      artifact: (_: string, kind: string, logical_path: string, body: string) => {
        artifacts.push({ id: `a${artifacts.length + 1}`, kind, logical_path, body });
        return { id: "x" };
      },
      transaction: <T>(fn: () => T) => fn(),
      eventsOfType: (_: string, type: string) => events.filter((e) => e.type === type),
      emit: (_: string, event: { type: string; payload: Record<string, unknown> }) => events.push(event),
    } as unknown as WorkflowStore;
    const policy = { stopModes: {} } as RunPolicy;
    expect(recordRestoredRemovals(store, "r1", policy, tasks, "T008")).toEqual([]);
    expect(recordRestoredRemovals(store, "r1", policy, tasks, "T009").map((r) => r.earlierTaskId)).toEqual(["T008"]);
    recordRestoredRemovals(store, "r1", policy, tasks, "T009");
    expect(events.map((e) => [e.payload.reason, e.payload.mode, e.payload.key])).toEqual([["corrective_restores_removed", "shadow", "task-T009-src/cli.rs"]]);
    expect(artifacts.filter((a) => a.logical_path === "chains/restores/T009.json")).toHaveLength(1);
    // A planned task is no corrective; the replay finds the same restore from the diffs alone.
    expect(recordRestoredRemovals(store, "r1", policy, tasks, "T001")).toEqual([]);
    expect(replayRestoredRemovals(store, "r1", tasks).map((r) => [r.taskId, r.earlierTaskId, r.path])).toEqual([["T009", "T008", "src/cli.rs"]]);
  });
});
