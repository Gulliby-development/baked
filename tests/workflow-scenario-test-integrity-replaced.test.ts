import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import type { Review } from "../src/core/workflows/schemas.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import {
  type IntegrityRecord,
  measureTestIntegrity,
  scanTestIntegrity,
  type TestRemovalFinding,
} from "../src/core/workflows/test-integrity.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 68, ewvet (#2139): spec finding F1 said the test
// `ScannerRecognitionMatchesReaderForLiteralTokens` checked recognition through Reader.Read
// rather than the classification facade, and its fix said "add the matching forwarding Scanner
// facade and literal classification tests". T003 replaced the test with a facade test (the count
// stayed 9); the guard knew only "remove" or "move" as a request and reported `test-removed` and
// `assertions`, and three correctives restored one test or the other (587k tokens).

const OLD = "ScannerRecognitionMatchesReaderForLiteralTokens";
const NEW = "EncodingTokenFacadeForwardsReaderClassification";
const path = "tests/Ewvet.Tests/ScannerTests.cs";
const fact = (name: string, body: string[]) =>
  ["    [Fact]", `    public void ${name}()`, "    {", ...body.map((line) => `        ${line}`), "    }", ""].join("\n");
const KEPT = fact("ScannerSkipsWhitespace", ["Assert.Empty(Scanner.Tokens(\" \"));"]);
const file = (first: string) => `using Xunit;\n\npublic class ScannerTests\n{\n${first}\n${KEPT}}\n`;
const BEFORE = file(
  fact(OLD, [
    'Assert.Equal(Reader.Read("1"), Scanner.Recognize("1"));',
    'Assert.Equal(Reader.Read("a"), Scanner.Recognize("a"));',
    'Assert.Equal(Reader.Read("s"), Scanner.Recognize("s"));',
  ]),
);
const AFTER = file(fact(NEW, ['Assert.Equal(TokenKind.Literal, Scanner.Classify("7"));']));

const F1 = {
  id: "F1",
  basis: "spec",
  file: path,
  claim: `The test ${OLD} tests recognition through Reader.Read rather than the classification facade`,
  suggestedFix: "Add the matching forwarding Scanner facade and literal classification tests",
} satisfies TestRemovalFinding;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Mode = "names" | "unnamed";

/** A review whose spec finding names the test (or, unnamed, does not); its correction swaps it. */
class SwapExecutor extends FixtureExecutor {
  store!: WorkflowStore;
  reviews = 0;
  corrections: string[][] = [];
  constructor(
    private dir: string,
    private mode: Mode,
  ) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
      snapshotHash: string;
      extra: { evidence?: { id: string }[]; finding?: { id: string } };
    };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    if (request.profile.output === "plan") {
      const response = await super.execute(request);
      (response.output as { taskGraph: { tasks: Task[] } }).taskGraph.tasks[0]?.writes.push({ path, action: "create" });
      return response;
    }
    if (request.profile.output === "implementation") {
      const task = request.task as Task;
      const target = join(this.dir, path);
      mkdirSync(join(this.dir, "tests/Ewvet.Tests"), { recursive: true });
      writeFileSync(join(this.dir, "value.txt"), "ready");
      if (task.origin === "planned") writeFileSync(target, BEFORE);
      else {
        const findings = this.store
          .findings(request.runId)
          .filter((f) => task.findingIds.includes(f.id))
          .map((f) => JSON.parse(f.body_json) as Review["findings"][number]);
        this.corrections.push(findings.map((f) => f.claim));
        if (existsSync(target)) {
          const before = readFileSync(target, "utf8");
          this.store.artifact(request.runId, "pre-images", `pre-images/${hashBytes(before)}`, before);
        }
        // A guard finding asks for the old test back; the spec's correction swaps it for the new one.
        writeFileSync(target, findings.some((f) => f.claim.startsWith("Test integrity")) ? BEFORE : AFTER);
      }
      return {
        output: { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Updated the scanner tests", evidenceIds: [], unresolved: [] },
        inputTokens: 25,
        outputTokens: 25,
      };
    }
    if (request.profile.output === "review" && this.reviews++ === 0) {
      const claim = this.mode === "names" ? F1.claim : "The Scanner facade has no literal classification tests";
      return {
        output: {
          schemaVersion: 1,
          snapshotHash: data.snapshotHash,
          verdict: "changes_requested",
          coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: "Facade untested" }],
          findings: [
            // Not `contradicts`, `partial` or `missing`: their rewrite and strengthen flags already
            // let a correction swap tests of the file (#1069, #1481).
            {
              id: "F1", kind: "unrequested", severity: "high", basis: "spec", confidence: 1, requirementIds: ["FR-001"],
              criterionIds: ["AC-001"], file: path, symbol: null, evidenceIds, claim, impact: "The facade is untested",
              suggestedFix: F1.suggestedFix,
            },
          ],
        },
        inputTokens: 25,
        outputTokens: 25,
      };
    }
    if (request.profile.output === "refutation")
      return {
        output: { schemaVersion: 1, findingId: data.extra.finding?.id, decision: "confirmed", evidenceIds, explanation: "The spec names the facade" },
        inputTokens: 25,
        outputTokens: 25,
      };
    return super.execute(request);
  }
}

for (const mode of ["names", "unnamed"] as const)
  test(`scenario: ewvet (#2139), a correction replaces a test the spec finding ${mode === "names" ? "names" : "does not name"}`, async () => {
    const fixture = workflowFixture({ executor: (root) => new SwapExecutor(root, mode) });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    executor.store = service.store;
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    await service.drive(run.runId, new AbortController().signal);
    const claims = service.store.findings(run.runId).map((f) => (JSON.parse(f.body_json) as { claim: string }).claim);
    const guards = claims.filter((c) => c.startsWith("Test integrity"));
    if (mode === "unnamed") {
      // The same swap without a finding naming the test is still a removal.
      expect(guards.some((c) => c.startsWith("Test integrity (test-removed)"))).toBe(true);
      return;
    }
    expect(guards).toEqual([]);
    expect(executor.corrections).toHaveLength(1);
    expect(readFileSync(join(fixture.root, path), "utf8")).toContain(NEW);
    // The exemption is recorded with the finding that granted it.
    const records = service.store
      .artifacts(run.runId)
      .filter((a) => a.kind === "test-integrity" && a.logical_path.startsWith("integrity/decisions/tasks/"))
      .map((a) => JSON.parse(service.store.readArtifact(run.runId, a.id)) as IntegrityRecord);
    const replaced = records.flatMap((r) => r.measures).filter((m) => m.form === "test" && m.replacedTests);
    expect(replaced).toEqual([expect.objectContaining({ path, replacedTests: 1, replacedBy: [expect.any(String)] })]);
    expect((await service.get(run.runId)).status).toBe("completed");
  }, 90_000);

const scan = (before: string, after: string, finding: TestRemovalFinding, at = path) =>
  scanTestIntegrity([{ path: at, before, after }], { removalFindings: [finding] }).map((f) => f.rule);

describe("a replacement is decided on the diff, not on the fix's wording (#2139)", () => {
  test("the ewvet swap: exempt when the claim names the test, flagged when it does not", () => {
    expect(scan(BEFORE, AFTER, F1)).toEqual([]);
    expect(scan(BEFORE, AFTER, { ...F1, claim: "The facade has no classification tests" })).toEqual(["test-removed", "assertions"]);
  });

  test("phrasing pairs: the fix's verb does not matter, the claim's subject and the new test do", () => {
    for (const suggestedFix of [
      "Add a test of the facade",
      "Replace it with a facade test",
      "Rewrite the test against Scanner.Classify",
      "Test the facade instead",
      "Change the test to call the facade",
    ])
      expect(scan(BEFORE, AFTER, { ...F1, suggestedFix })).toEqual([]);
    // Each new title pays for one removed test: dropping the test without a new one is a removal.
    const dropped = BEFORE.replace(/ {4}\[Fact\]\n {4}public void Scanner\w+Tokens[\s\S]*?\n {4}\}\n/, "");
    expect(scan(BEFORE, dropped, F1)).toEqual(["test-count", "assertions"]);
    // A fix that says not to remove the test grants nothing.
    expect(scan(BEFORE, AFTER, { ...F1, suggestedFix: "Do not remove the test; add a facade test" })).toContain("test-removed");
    // Other bases, files and the guard's own findings grant nothing.
    expect(scan(BEFORE, AFTER, { ...F1, basis: "inferred" })).toContain("test-removed");
    expect(scan(BEFORE, AFTER, { ...F1, file: "tests/Other.cs" })).toContain("test-removed");
    expect(scan(BEFORE, AFTER, { ...F1, claim: `Test integrity (test-removed): ${OLD}` })).toContain("test-removed");
  });

  test("phrasing pair: a plain-word title is named only when quoted", () => {
    const ts = (name: string, body: string) => `test("${name}", () => { ${body} });\n`;
    const before = ts("adds", "expect(add(1, 1)).toBe(2); expect(add(2, 2)).toBe(4);") + ts("keeps", "expect(1).toBe(1);");
    const after = ts("adds through the facade", "expect(facade.add(1, 1)).toBe(2);") + ts("keeps", "expect(1).toBe(1);");
    const finding = { basis: "spec", file: "tests/add.test.ts", suggestedFix: "Add a facade test" };
    expect(scan(before, after, { ...finding, claim: 'The test "adds" calls add directly' }, "tests/add.test.ts")).toEqual([]);
    expect(scan(before, after, { ...finding, claim: "The suite adds no facade test" }, "tests/add.test.ts")).toContain("test-removed");
  });

  test("a replaced test that a correction of another finding added is not lost (#1519)", () => {
    const protects = new Map([[path, new Map([[OLD, "T002 for finding F0"]])]]);
    const measure = (finding: TestRemovalFinding) =>
      scanTestIntegrity([{ path, before: BEFORE, after: AFTER }], { protects, removalFindings: [finding] }).map((f) => f.rule);
    expect(measure(F1)).toEqual([]);
    expect(measure({ ...F1, claim: "The facade has no tests" })).toContain("test-removed");
  });

  test("the measure records the count and the finding id, never the title (#1715)", () => {
    const [m] = measureTestIntegrity([{ path, before: BEFORE, after: AFTER }], { removalFindings: [F1] });
    expect(m).toEqual(expect.objectContaining({ form: "test", replacedTests: 1, replacedBy: ["F1"], unclaimed: 0 }));
  });
});

/** One test of each language's title convention, with a body of `n` assertions. */
const LANGUAGES: [language: string, path: string, write: (name: string, n: number) => string][] = [
  ["typescript", "tests/scan.test.ts", (name, n) => `test("${name}", () => {\n${"  expect(scan(1)).toBe(1);\n".repeat(n)}});\n`],
  ["javascript", "tests/scan.test.js", (name, n) => `it("${name}", () => {\n${"  expect(scan(1)).toBe(1);\n".repeat(n)}});\n`],
  ["python", "tests/test_scan.py", (name, n) => `def ${name}():\n${"    assert scan(1) == 1\n".repeat(n)}\n`],
  ["go", "scan_test.go", (name, n) => `func ${name}(t *testing.T) {\n${'\tif scan(1) != 1 { t.Error("want 1") }\n'.repeat(n)}}\n`],
  ["rust", "tests/scan.rs", (name, n) => `#[test]\nfn ${name}() {\n${"    assert_eq!(scan(1), 1);\n".repeat(n)}}\n`],
  ["java", "src/test/java/ScanTest.java", (name, n) => `    @Test\n    void ${name}() {\n${"        assertEquals(1, scan(1));\n".repeat(n)}    }\n`],
  ["kotlin", "src/test/kotlin/ScanTest.kt", (name, n) => `    @Test\n    fun ${name}() {\n${"        assertEquals(1, scan(1))\n".repeat(n)}    }\n`],
  ["scala", "src/test/scala/ScanSuite.scala", (name, n) => `  test("${name}") {\n${"    assert(scan(1) == 1)\n".repeat(n)}  }\n`],
  ["csharp", "tests/ScanTests.cs", (name, n) => `    [Fact]\n    public void ${name}()\n    {\n${"        Assert.Equal(1, Scan(1));\n".repeat(n)}    }\n`],
  ["ruby", "spec/scan_spec.rb", (name, n) => `  it "${name}" do\n${"    expect(scan(1)).to eq(1)\n".repeat(n)}  end\n`],
  ["dart", "test/scan_test.dart", (name, n) => `  test('${name}', () {\n${"    expect(scan(1), equals(1));\n".repeat(n)}  });\n`],
  ["lua", "spec/scan_spec.lua", (name, n) => `  it("${name}", function()\n${"    assert.are.equal(1, scan(1))\n".repeat(n)}  end)\n`],
  ["rescript", "tests/ScanTest.res", (name, n) => `test("${name}", () => {\n${"  expect(scan(1))->toBe(1)\n".repeat(n)}})\n`],
  ["powershell", "tests/Scan.Tests.ps1", (name, n) => `  It '${name}' {\n${"    Scan 1 | Should -Be 1\n".repeat(n)}  }\n`],
];

describe("every language with a test title convention (#2139)", () => {
  for (const [language, at, write] of LANGUAGES)
    test(`${language}: a named test replaced is exempt, an unnamed one is flagged`, () => {
      const title = (base: string) => (language === "python" ? `test_${base}` : language === "go" ? `Test${base}` : `${base}_case`);
      const [old, replacement, kept] = [title("recognition_via_reader"), title("facade_classification"), title("whitespace")];
      const before = write(old, 3) + write(kept, 1);
      // The new test checks something else: no retitle of the old one (#1532).
      const swapped = write(replacement, 1).replaceAll("scan(1)", "classify(7)").replaceAll("Scan(1)", "Classify(7)").replaceAll("Scan 1", "Classify 7").replaceAll("want 1", "want 7");
      const after = swapped + write(kept, 1);
      const finding = { basis: "spec", file: at, claim: `${old} tests through Reader rather than the facade`, suggestedFix: "Add a facade test" };
      expect(scan(before, after, finding, at)).toEqual([]);
      expect(scan(before, after, { ...finding, claim: "The facade has no tests" }, at)).toContain("test-removed");
    });
});
