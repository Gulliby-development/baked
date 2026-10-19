import type { Spec } from "../../src/core/workflows/schemas.js";
import { fixtureSpec } from "./workflow-fixture.js";

// R48 (#1614): URL lists, Java parser inputs and an escaped stdin value in table cells.
export const cellSpec: Spec = {
  ...fixtureSpec,
  criteria: [{
    ...fixtureSpec.criteria[0]!,
    given: "concrete inputs",
    when: "the tests run",
    then: [
      "| Input | Expected |", "| --- | --- |",
      '| `https://user:pass@example.com/a`, `https://\u4f8b\u3048.\u30c6\u30b9\u30c8/\u9053`, `https://example.com/a%20b`, `HTTPS://example.com/a` as `url` | accepted |',
      '| `"0 R."`, `"00 R."`, `"50 R."`, `"001 R."`, `"+1 R."`, `"\\u0661 R."` | parsed |',
      '| profile A; stdin "0001ALICE 0015{\\n0002BOB   0120}\\n..." | records |',
      '| Layout `layout.json`, view `ALT`, text "caf\\u00e9\\tend\\r" | rendered |',
    ].join("\n"),
  }],
};

const urls = [
  '"https://user:pass@example.com/a"',
  '"https://\u4f8b\u3048.\u30c6\u30b9\u30c8/\u9053"',
  '"https://example.com/a%20b"',
  '"HTTPS://example.com/a"',
].join(", ");
const parser = '"0 R.", "00 R.", "50 R.", "001 R.", "+1 R."';

export const cellSamples = [
  { stack: "maven", path: "src/test/java/ParserTest.java", text: `class ParserTest {
  String[] inputs = {${urls}, ${parser}, "\\u0661 R.", "0001ALICE 0015{\\n0002BOB   0120}\\n...", "layout.json", "ALT", "caf\\u00e9\\tend\\r"};
}
` },
  { stack: "python", path: "tests/test_parser.py", text: `def test_inputs():
    inputs = [${urls}, ${parser}, "\u0661 R.", "0001ALICE 0015{\\x0a0002BOB   0120}\\x0a...", "layout.json", "ALT", "caf\\xe9\\x09end\\x0d"]
    assert inputs
` },
  { stack: "go", path: "parser_test.go", text: `package parser
import "testing"
func TestInputs(t *testing.T) {
  inputs := []string{${urls}, ${parser}, "\\u0661 R.", "0001ALICE 0015{\\n0002BOB   0120}\\n...", "layout.json", "ALT", "caf\\u00e9\\tend\\r"}
  if len(inputs) == 0 { t.Fatal("empty") }
}
` },
  { stack: "bun", path: "tests/parser.test.ts", text: `import { expect, test } from "bun:test";
test("inputs", () => {
  const inputs = [${urls}, ${parser}, "\\u{661} R.", "0001ALICE 0015{\\n0002BOB   0120}\\n...", "layout.json", "ALT", \`caf\u00e9\tend\r\`];
  expect(inputs.length).toBeGreaterThan(0);
});
` },
  { stack: "dotnet", path: "tests/ParserTests.cs", text: `class ParserTests {
  string[] inputs = {${urls}, ${parser}, "\\u0661 R.", "0001ALICE 0015{\\n0002BOB   0120}\\n...", "layout.json", "ALT", "caf\\u00e9\\tend\\r"};
}
` },
] as const;

export const omittedCellInput = '"50 R."';
export const withoutCellInput = (text: string): string => text.replace(`${omittedCellInput}, `, "");
