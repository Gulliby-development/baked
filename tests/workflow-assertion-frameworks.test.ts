import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { testsHold } from "../src/core/verification/criteria-cases.js";
import { caseEvidence } from "../src/core/verification/criteria-evidence.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import { scanTestIntegrity, testChanges } from "../src/core/workflows/test-integrity.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// #1650 and #1651 (three-day error review, 2026-10-20): the case walk's message stripping and the
// test-integrity guard knew only the frameworks of the runs that raised earlier findings. Both now
// read one table of test and assertion conventions per framework.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DECOY = "case key=value a=1";

/** Whether the case walk takes the decoy, and the real input `"a"`, as evidence. */
const holds = (path: string, text: string) => {
  const evidence = caseEvidence(path, text);
  return { decoy: testsHold(evidence, DECOY), input: testsHold(evidence, 'parse("a")') };
};

describe("case evidence drops assertion messages of every listed framework (#1650)", () => {
  const rows: [string, string, string][] = [
    ["Go testify assert", "parse_test.go", `assert.Equal(t, 1, parse("a"), "${DECOY}")`],
    ["Go testify require, formatted", "parse_test.go", `require.Equalf(t, 1, parse("a"), "${DECOY} %d", 1)`],
    ["Go testify, one value", "parse_test.go", `assert.True(t, parse("a"), "${DECOY}")`],
    ["Go testing", "parse_test.go", `if parse("a") != 1 { t.Errorf("${DECOY}") }`],
    ["Python unittest assertEqual", "tests/test_parse.py", `self.assertEqual(parse("a"), 1, "${DECOY}")`],
    ["Python unittest assertTrue", "tests/test_parse.py", `self.assertTrue(parse("a"), "${DECOY}")`],
    ["Python unittest msg=", "tests/test_parse.py", `self.assertIn(parse("a"), [1], msg="${DECOY}")`],
    ["Python, multi-line assert", "tests/test_parse.py", `assert parse("a") == 1, (\n    "${DECOY}"\n)`],
    ["Python, one-line assert", "tests/test_parse.py", `assert parse("a") == 1, "${DECOY}"`],
    ["Java AssertJ as", "src/test/java/ParseTest.java", `assertThat(parse("a")).as("${DECOY}").isEqualTo(1);`],
    ["Java AssertJ describedAs", "src/test/java/ParseTest.java", `assertThat(parse("a")).describedAs("${DECOY}").isEqualTo(1);`],
    ["Java AssertJ withFailMessage", "src/test/java/ParseTest.java", `assertThat(parse("a")).withFailMessage("${DECOY}").isEqualTo(1);`],
    ["Java Hamcrest reason", "src/test/java/ParseTest.java", `assertThat("${DECOY}", parse("a"), is(1));`],
    ["JUnit 5", "src/test/java/ParseTest.java", `import org.junit.jupiter.api.Test;\nassertEquals(1, parse("a"), "${DECOY}");`],
    ["JUnit 4", "src/test/java/ParseTest.java", `import org.junit.Test;\nimport static org.junit.Assert.assertEquals;\nassertEquals("${DECOY}", 1, parse("a"));`],
    ["JUnit 4 assertTrue", "src/test/java/ParseTest.java", `import static org.junit.Assert.*;\nassertTrue("${DECOY}", parse("a"));`],
    ["Kotlin JUnit 4", "src/test/kotlin/ParseTest.kt", `import org.junit.Assert.assertEquals\nassertEquals("${DECOY}", 1, parse("a"))`],
    ["kotlin.test", "src/test/kotlin/ParseTest.kt", `import kotlin.test.assertEquals\nassertEquals(1, parse("a"), "${DECOY}")`],
    ["Kotest withClue", "src/test/kotlin/ParseSpec.kt", `withClue("${DECOY}") { parse("a") shouldBe 1 }`],
    ["C# NUnit Assert.That", "tests/ParseTests.cs", `Assert.That(parse("a"), Is.EqualTo(1), "${DECOY}");`],
    ["C# NUnit Assert.That, condition", "tests/ParseTests.cs", `Assert.That(parse("a") == 1, "${DECOY}");`],
    ["C# MSTest AreEqual", "tests/ParseTests.cs", `Assert.AreEqual(1, parse("a"), "${DECOY}");`],
    ["C# xUnit True", "tests/ParseTests.cs", `Assert.True(parse("a") == 1, "${DECOY}");`],
    ["C# FluentAssertions because", "tests/ParseTests.cs", `parse("a").Should().Be(1, "${DECOY}");`],
    ["C# FluentAssertions, one value", "tests/ParseTests.cs", `parse("a").Should()\n    .BeTrue("${DECOY}");`],
    ["C# FluentAssertions because:", "tests/ParseTests.cs", `parse("a").Should().BeEquivalentTo(new[] { 1 }, because: "${DECOY}");`],
    ["Node assert", "tests/parse.test.ts", `assert.strictEqual(parse("a"), 1, "${DECOY}");`],
    ["Chai assert.isTrue", "tests/parse.test.ts", `assert.isTrue(parse("a"), "${DECOY}");`],
    ["Jest expect message", "tests/parse.test.ts", `expect(parse("a"), "${DECOY}").toBe(1);`],
    ["Rust assert_eq!", "tests/parse.rs", `assert_eq!(parse("a"), 1, "${DECOY}");`],
    ["Dart expect reason:", "test/parse_test.dart", `expect(parse("a"), equals(1), reason: "${DECOY}");`],
    ["Dart fail", "test/parse_test.dart", `if (parse("a") != 1) fail("${DECOY}");`],
    ["ScalaTest withClue", "src/test/scala/ParseSpec.scala", `withClue("${DECOY}") { parse("a") shouldBe 1 }`],
    ["munit assertEquals clue", "src/test/scala/ParseSuite.scala", `assertEquals(parse("a"), 1, "${DECOY}")`],
  ];
  for (const [framework, path, line] of rows)
    test(`${framework}: the message is blanked and the input kept`, () => {
      expect(holds(path, line)).toEqual({ decoy: false, input: true });
    });

  test("the decoy written as an input or an expected value is still evidence", () => {
    expect(holds("tests/ParseTests.cs", `parse("${DECOY}").Should().Be(1);`).decoy).toBe(true);
    expect(holds("src/test/java/ParseTest.java", `assertEquals(1, parse("${DECOY}"));`).decoy).toBe(true);
    expect(holds("parse_test.go", `assert.Equal(t, "${DECOY}", parse("a"))`).decoy).toBe(true);
    expect(holds("tests/test_parse.py", `self.assertEqual(parse("a"), "${DECOY}")`).decoy).toBe(true);
    expect(holds("tests/test_parse.py", `assert parse("a") == (\n    "${DECOY}"\n)`).decoy).toBe(true);
    // A Python call's own keyword named msg is input, not an assertion message.
    expect(holds("tests/test_parse.py", `assert send(msg="${DECOY}")`).decoy).toBe(true);
    // Outside a Should() chain a C# method's second argument is input.
    expect(holds("tests/ParseTests.cs", `var r = Parser.Parse("a", "${DECOY}");`).decoy).toBe(true);
    // Dart's expect(actual, matcher) takes the expected value second (#1494).
    expect(holds("test/parse_test.dart", `expect(parse("a"), "${DECOY}");`).decoy).toBe(true);
    // JUnit 4's assertEquals(expected, actual, delta) has no message.
    expect(holds("src/test/java/ParseTest.java", `import org.junit.Test;\nassertEquals(1.0, parse("a"), 0.01);`).input).toBe(true);
  });
});

/** A test file before and after a change, scanned by the guard. */
const scan = (path: string, before: string, after: string) => scanTestIntegrity([{ path, before, after }]);

describe("the test-integrity guard reads every listed framework (#1651)", () => {
  test("C# FluentAssertions: a removed .Should() assertion is flagged", () => {
    const before = `    [Fact]\n    public void Adds()\n    {\n        Add(2, 2).Should().Be(4);\n        Add(1, 1).Should().Be(2);\n    }\n`;
    const after = before.replace("        Add(1, 1).Should().Be(2);\n", "");
    expect(scan("tests/AddTests.cs", before, after).map((f) => f.rule)).toEqual(["assertions"]);
  });

  test("Kotlin Kotest StringSpec: a removed spec is flagged by name", () => {
    const before = `class MathSpec : StringSpec({\n    "adds" {\n        add(1, 1) shouldBe 2\n    }\n    "subs" {\n        sub(2, 1) shouldBe 1\n    }\n})\n`;
    const after = before.replace(`    "subs" {\n        sub(2, 1) shouldBe 1\n    }\n`, "");
    const found = scan("src/test/kotlin/MathSpec.kt", before, after);
    expect(found.map((f) => f.rule)).toEqual(["test-count", "assertions"]);
    expect(found[0]?.detail).toContain('"subs"');
  });

  test("Kotlin Kotest ShouldSpec: a removed leaf is flagged by name", () => {
    const before = `class MathSpec : ShouldSpec({\n    should("add") {\n        add(1, 1) shouldBe 2\n    }\n    should("sub") {\n        sub(2, 1) shouldBe 1\n    }\n})\n`;
    const after = before.replace(`    should("sub") {\n        sub(2, 1) shouldBe 1\n    }\n`, "");
    expect(scan("src/test/kotlin/MathSpec.kt", before, after)[0]?.detail).toContain('"sub"');
  });

  test("Rust rstest: a removed test is flagged by name", () => {
    const before = `#[rstest]\nfn adds() {\n    assert_eq!(add(1, 1), 2);\n}\n\n#[rstest]\n#[case(2, 1)]\nfn subs(#[case] a: i32, #[case] b: i32) {\n    assert_eq!(sub(a, b), 1);\n}\n`;
    const after = before.slice(0, before.indexOf("\n#[rstest]\n#[case"));
    const found = scan("tests/math.rs", before, after);
    expect(found.map((f) => f.rule)).toEqual(["test-count", "assertions"]);
    expect(found[0]?.detail).toContain('"subs"');
  });

  test("Rust rstest: a removed case row is a lost test", () => {
    const before = `#[rstest]\n#[case(1, 1, 2)]\n#[case(2, 2, 4)]\nfn adds(#[case] a: i32, #[case] b: i32, #[case] c: i32) {\n    assert_eq!(add(a, b), c);\n}\n`;
    const after = before.replace("#[case(2, 2, 4)]\n", "");
    expect(scan("tests/math.rs", before, after).map((f) => f.rule)).toEqual(["test-count"]);
  });

  test("Rust test_case: each case is a test, and the function is named", () => {
    const before = `#[test_case(1)]\n#[test_case(2)]\nfn positive(n: i32) {\n    assert!(n > 0);\n}\n`;
    const after = before.replace("#[test_case(2)]\n", "");
    expect(scan("tests/math.rs", before, after).map((f) => f.rule)).toEqual(["test-count"]);
    expect(testChanges({ path: "tests/math.rs", before: "", after: before })?.added).toEqual(["positive"]);
  });

  test("Rust tokio::test with arguments: a removed test is named", () => {
    const before = `#[tokio::test(flavor = "multi_thread")]\nasync fn fetches() {\n    assert!(fetch().await.is_ok());\n}\n\n#[tokio::test(flavor = "multi_thread")]\nasync fn retries() {\n    assert!(retry().await.is_ok());\n}\n`;
    const after = before.slice(0, before.indexOf("\n#[tokio::test", 1));
    const found = scan("tests/net.rs", before, after);
    expect(found.map((f) => f.rule)).toEqual(["test-count", "assertions"]);
    expect(found[0]?.detail).toContain('"retries"');
  });

  test("Go t.Run: a removed subtest is a lost test, named after its function", () => {
    const before = `func TestParse(t *testing.T) {\n\tt.Run("empty", func(t *testing.T) {\n\t\tif parse("") != 0 {\n\t\t\tt.Error("want 0")\n\t\t}\n\t})\n\tt.Run("one", func(t *testing.T) {\n\t\tif parse("1") != 1 {\n\t\t\tt.Error("want 1")\n\t\t}\n\t})\n}\n`;
    const after = before.replace(`\tt.Run("one", func(t *testing.T) {\n\t\tif parse("1") != 1 {\n\t\t\tt.Error("want 1")\n\t\t}\n\t})\n`, "");
    const found = scan("parse_test.go", before, after);
    expect(found.map((f) => f.rule)).toEqual(["test-count", "assertions"]);
    expect(found[0]?.detail).toContain('"TestParse/one"');
  });

  test("Rust #[test] (control): a removed test is flagged by name", () => {
    const before = `#[test]\nfn adds() {\n    assert_eq!(add(1, 1), 2);\n}\n\n#[test]\nfn subs() {\n    assert_eq!(sub(2, 1), 1);\n}\n`;
    const after = before.slice(0, before.indexOf("\n#[test]\nfn subs"));
    expect(scan("tests/math.rs", before, after)[0]?.detail).toContain('"subs"');
  });

  test("a framework's patterns are read only in its language's files", () => {
    // A Kotest-looking line in TypeScript, and t.Run in Python, are not tests.
    const ts = `const table = {\n  "adds" { }\n};\n`;
    expect(scan("tests/table.test.ts", ts, "")).toEqual([]);
    const py = `def test_runs():\n    t.Run("one", go)\n    assert ok\n`;
    expect(testChanges({ path: "tests/test_runs.py", before: "", after: py })?.added).toEqual(["test_runs"]);
  });
});

// Scripted scenario (#1650): a pytest task whose criterion quotes an input the tests do not use
// gets a case-walk refusal; writing the input into an assertion message no longer answers it.
test("a pytest task cannot satisfy the case walk with an assertion message", async () => {
  const spec: Spec = {
    ...fixtureSpec,
    criteria: [{ ...fixtureSpec.criteria[0], then: 'value is ready and `--path SRC` prints "no matching files"' } as Spec["criteria"][number]],
  };
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { executor, root } = fixture;
  const original = executor.execute.bind(executor);
  const found: string[][] = [];
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    const out = await original(request);
    if (request.profile.output === "plan") {
      const plan = out.output as { markdown: string; taskGraph: { specHash: string; planHash: string; tasks: { writes: { path: string; action: string }[] }[] } };
      plan.taskGraph.specHash = hashJson(spec);
      plan.taskGraph.planHash = hashBytes(plan.markdown);
      plan.taskGraph.tasks[0]?.writes.push({ path: "tests/test_cli.py", action: "create" });
    }
    if (request.profile.output === "implementation") {
      mkdirSync(join(root, "tests"), { recursive: true });
      const write = (body: string) => writeFileSync(join(root, "tests/test_cli.py"), body);
      // The decoy: a unittest message and a multi-line assert message quote the refused input.
      write('self.assertEqual(run(["--path", "src"]).out, "no matching files", "--path SRC")\n');
      found.push((await request.caseCheck?.(root)) ?? ["no case check"]);
      write('assert run(["--path", "src"]).out == "no matching files", (\n    "--path SRC"\n)\n');
      found.push((await request.caseCheck?.(root)) ?? ["no case check"]);
      write('assert run(["--path", "SRC"]).out == "no matching files"\n');
      found.push((await request.caseCheck?.(root)) ?? ["no case check"]);
    }
    return out;
  };
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  await fixture.service.drive(run.runId, new AbortController().signal);
  const refused = ['AC-001 names "--path SRC", found only in an assertion message in tests/test_cli.py. Use it as a test input or expected value; the message alone is a decoy.'];
  expect(found).toEqual([refused, refused, []]);
}, 60000);
