import type { Spec } from "../../src/core/workflows/schemas.js";
import { fixtureSpec } from "./workflow-fixture.js";

const table = (input: string, expected: string) => `Input | Expected\n--- | ---\n${input} | ${expected}`;
export const residualSamples = [
  { name: "scope paths", stack: "rust", path: "tests/linter_tests.rs",
    then: table("`src/linter.rs`, `src/cmd_lint.rs`, `tests/linter_tests.rs`", "only these files changed"),
    given: 'scope includes `src/linter.rs` and `tests/linter_tests.rs`',
    text: '#[test]\nfn lint() { assert!(lint_source("echo ok").is_ok()); }\n', cases: [] },
  { name: "coverage counts", stack: "go", path: "parser_test.go",
    given: 'at least `30` handwritten tests, with a minimum of "22" cases and count `180` overall',
    then: table("at least 30 tests", "coverage checked in review"),
    text: 'package parser\nfunc TestParse(t *testing.T) { if parse("echo ok") == nil { t.Fatal("parse failed") } }\n', cases: [] },
  { name: "expected fields", stack: "dotnet", path: "tests/PatternTests.cs",
    given: 'the pattern has `magic=true` or `magic=false`',
    then: `${table("magic=true", "pattern.magic is true")}\nmagic=false | pattern.magic is false`,
    text: 'class PatternTests { void Check() { Assert.True(Parse("*").magic); Assert.False(Parse("plain").magic); } }\n', cases: [] },
  { name: "paired assignments", stack: "rust", path: "tests/input_tests.rs",
    given: "stdin bytes and an argument",
    then: table('arg="-", stdin=[0xc3,0xa9]', "decoded text"),
    text: '#[test]\nfn stdin() { assert_eq!(run("-", &[0xc3, 0xa9]), "ok"); }\n', cases: ["[0xc3,0xa9]"] },
  { name: "paired quoted inputs", stack: "go", path: "pattern_test.go",
    given: "a pattern and a candidate",
    then: table('"*", "a/b"', "matches"),
    text: 'package pattern\nfunc TestMatch(t *testing.T) { if !match("*", "a/b") { t.Fatal("match failed") } }\n', cases: ["a/b"] },
  { name: "formatted lists", stack: "rust", path: "tests/bytes_tests.rs",
    given: "bytes and command arguments",
    then: `${table('`[0x65,0x63,0xFF,0x0A]`', "invalid encoding")}\n\`[\"ls\",\"a.txt\",...]\` | arguments preserved`,
    text: '#[test]\nfn bytes() { check(&[0x65, 0x63, 0xFF, 0x0A]); run(&["ls", "a.txt", "other"]); }\n', cases: ["[0x65,0x63,0xFF,0x0A]", '["ls","a.txt",...]'] },
  { name: "formatted expression", stack: "rust", path: "tests/error_tests.rs",
    given: "an error expression",
    then: table('`ShError("oops".into()).0`', "inner message"),
    text: '#[test]\nfn error() { assert_eq!(ShError ( "oops" . into () ) . 0, "oops"); }\n', cases: ['ShError("oops".into()).0'] },
] as const;

export type ResidualSample = (typeof residualSamples)[number];
export const residualSpec = (sample: ResidualSample): Spec => ({
  ...fixtureSpec,
  criteria: [{ ...fixtureSpec.criteria[0]!, given: sample.given, when: "the tests run", then: sample.then }],
});

export const decoySamples = [
  { stack: "rust", path: "tests/pattern_tests.rs", decoy: '#[test]\nfn pattern() { assert!(pattern.magic, "--case-42"); }\n',
    text: '#[test]\nfn pattern() { assert!(parse("--case-42").magic); }\n' },
  { stack: "go", path: "pattern_test.go", decoy: 'package pattern\nfunc TestPattern(t *testing.T) { if !pattern.magic { t.Fatal("--case-42") } }\n',
    text: 'package pattern\nfunc TestPattern(t *testing.T) { if !parse("--case-42").magic { t.Fatal("failed") } }\n' },
  { stack: "dotnet", path: "tests/PatternTests.cs", decoy: 'class PatternTests { void Check() { Assert.True(pattern.magic, "--case-42"); } }\n',
    text: 'class PatternTests { void Check() { Assert.True(Parse("--case-42").magic); } }\n' },
  { stack: "python", path: "tests/test_pattern.py", decoy: 'def test_pattern():\n    assert pattern.magic, "--case-42"\n',
    text: 'def test_pattern():\n    assert parse("--case-42").magic\n' },
  { stack: "bun", path: "tests/pattern.test.ts", decoy: 'test("pattern", () => { expect(pattern.magic, "--case-42").toBe(true); });\n',
    text: 'test("pattern", () => { expect(parse("--case-42").magic).toBe(true); });\n' },
  { stack: "maven", path: "src/test/java/PatternTest.java", decoy: 'class PatternTest { void check() { assertTrue(pattern.magic, "--case-42"); } }\n',
    text: 'class PatternTest { void check() { assertTrue(parse("--case-42").magic); } }\n' },
] as const;
