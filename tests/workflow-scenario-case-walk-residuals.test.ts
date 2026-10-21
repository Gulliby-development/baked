import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  caseCheck,
  criterionCases,
  missingCases,
  repairCaseTask,
} from "../src/core/verification/criteria-cases.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import type { Task } from "../src/core/workflows/types.js";

// R53 jsonsplice (#1790): the case walk refused 11 times with 37 items in 6 of 10 features for a
// requirement id, parameter expressions, prose between two code spans, spaced hex bytes the
// test spelled its toolchain's way, and rows a corrective did not own.

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-case-residuals-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

type Criterion = Spec["criteria"][number];
const criterion = (id: string, given: string, when: string, then: string, requirementIds = ["FR-001"]): Criterion => ({
  id,
  requirementIds,
  given,
  when,
  then,
  method: "automated",
});
const cases = (c: Criterion) => criterionCases({ criteria: [c] }, { criterionIds: [c.id] }, {}).map((x) => x.literal);

describe("literal classes the walk demanded (#1790)", () => {
  test("a requirement id is a reference, not a case", () => {
    expect(cases(criterion("AC-006", "the layout of `FR-005`", "`layout --width 80` runs", "it follows `FR-005` and `AC-002`"))).toEqual(["layout --width 80"]);
  });

  test("a name expression of the code under test is not a case", () => {
    const c = criterion("AC-005", "a document `src` and an index `itemIndex`", "`splice` runs with `[src, itemIndex]`", "it returns `root.items[itemIndex].value` and `[0, 1]`");
    expect(cases(c)).toEqual(["itemIndex", "[0, 1]"]);
  });

  test("paired code spans are cases, and a double quote inside one opens no quoted span", () => {
    const c = criterion("AC-005", 'the document `{"a":1}`', "each path is read", 'reading `a..b` throws Fail `invalid path at character 3`; `tags[1` throws Fail `invalid path`');
    expect(cases(c)).toEqual(["invalid path at character 3", "tags[1"]);
  });

  test("backticks that do not pair give no cases, never the prose between two spans", () => {
    // Before #1790 these gave "` is rejected; `{" and "]` with `{".
    const shifted = criterion("AC-005", "a document", "paths are read", '`"x`y"` is rejected; `{"a":1}`. `a..b` throws Fail `invalid path` at character 3`; `tags[1` throws Fail `invalid path`');
    const odd = criterion("AC-005", "a document", "paths are read", '`["a`"]` with `{"a":1}`. `a..b` throws Fail `invalid path`, then `tags[1` throws Fail `invalid path`');
    expect(cases(shifted)).toEqual([]);
    expect(cases(odd)).toEqual([]);
  });
});

// One honest test per toolchain spells the bytes `7B FF 0A` its own way.
const BYTES = criterion("AC-004", "a file holding the bytes `7B FF 0A`", "it is decoded", "it fails with `invalid UTF-8`");
const TOOLCHAINS: { tool: string; path: string; text: string }[] = [
  { tool: "bun test", path: "tests/decode.test.ts", text: 'expect(() => decode(new Uint8Array([0x7b, 0xff, 0x0a]))).toThrow("invalid UTF-8");' },
  { tool: "pytest", path: "tests/test_decode.py", text: 'with pytest.raises(ValueError, match="invalid UTF-8"):\n    decode(b"\\x7b\\xff\\n")' },
  { tool: "go test", path: "decode_test.go", text: 'if _, err := Decode([]byte{0x7b, 0xff, 0x0a}); err.Error() != "invalid UTF-8" {}' },
  { tool: "cargo test", path: "tests/decode.rs", text: 'assert_eq!(decode(b"\\x7b\\xff\\x0a").unwrap_err(), "invalid UTF-8");' },
  { tool: "dotnet test", path: "tests/App.Tests/DecodeTests.cs", text: 'Assert.Throws<FormatException>(() => Decode(new byte[] { 0x7B, 0xFF, 0x0A })).Message.Should().Be("invalid UTF-8");' },
  { tool: "maven", path: "src/test/java/app/DecodeTest.java", text: 'assertThrows(IllegalArgumentException.class, () -> decode(new byte[] {(byte) 0x7B, (byte) 0xFF, (byte) 0x0A}), "invalid UTF-8");\nassertEquals("invalid UTF-8", error.getMessage());' },
  { tool: "gradle", path: "src/test/kotlin/app/DecodeTest.kt", text: 'assertEquals("invalid UTF-8", runCatching { decode(byteArrayOf(0x7B, 0xFF.toByte(), 0x0A)) }.exceptionOrNull()?.message)' },
  { tool: "decimal list", path: "tests/decode.test.js", text: 'assert.throws(() => decode(Buffer.from([123, 255, 10])), /invalid UTF-8/);\nconst e = "invalid UTF-8";' },
  { tool: "hex string", path: "tests/decode_hex.test.ts", text: 'expect(() => decode(Buffer.from("7bff0a", "hex"))).toThrow("invalid UTF-8");' },
];

describe("spaced hex bytes in each toolchain's spelling (#1790)", () => {
  for (const { tool, path, text } of TOOLCHAINS)
    test(tool, async () => {
      const task = { criterionIds: ["AC-004"], writes: [{ path, action: "create" as const }] };
      const check = caseCheck({ criteria: [BYTES] }, task, {});
      expect(check ? await check(workspace({ [path]: text })) : ["no check"]).toEqual([]);
    });

  test("other bytes are still missing", () => {
    const [bytes] = criterionCases({ criteria: [BYTES] }, { criterionIds: ["AC-004"] }, {});
    expect(bytes?.literal).toBe("7B FF 0A");
    expect(missingCases(bytes ? [bytes] : [], ["decode(new Uint8Array([0x7b, 0xfe, 0x0a]))"])).toHaveLength(1);
  });
});

describe("a corrective owes the cases its findings name (#1790)", () => {
  type PlanTask = Pick<Task, "origin" | "writes" | "criterionIds">;
  const planned = (criterionIds: string[], path: string): PlanTask => ({ origin: "planned", criterionIds, writes: [{ path, action: "create" }] });
  const tasks = [planned(["AC-004"], "src/source.ts"), planned(["AC-011"], "src/parser.ts")];
  const spec = {
    criteria: [
      criterion("AC-004", "a source", "`lines --offset=0` runs", "it prints `line=1`"),
      criterion("AC-011", "a document with duplicate keys", "`countValues` runs", "it reports `JS009 duplicate key`", ["FR-011"]),
    ],
  };
  const repair = { criterionIds: ["AC-004", "AC-011"] };

  test("by the file a finding names", () => {
    expect(repairCaseTask(repair, [{ file: "src/source.ts", criterionIds: [] }], spec, tasks).criterionIds).toEqual(["AC-004"]);
  });

  test("by criterion and by requirement", () => {
    expect(repairCaseTask(repair, [{ criterionIds: ["AC-011"] }], spec, tasks).criterionIds).toEqual(["AC-011"]);
    expect(repairCaseTask(repair, [{ requirementIds: ["FR-011"] }], spec, tasks).criterionIds).toEqual(["AC-011"]);
  });

  test("a finding that names none of its criteria keeps them all", () => {
    expect(repairCaseTask(repair, [{ file: "README.md" }], spec, tasks).criterionIds).toEqual(["AC-004", "AC-011"]);
  });

  test("the corrective's walk no longer demands the parser slice's rows", async () => {
    const path = "tests/source.test.ts";
    const owned = repairCaseTask(repair, [{ file: "src/source.ts", criterionIds: [] }], spec, tasks);
    const check = caseCheck(spec, { ...owned, writes: [{ path, action: "modify" }] }, {});
    expect(check ? await check(workspace({ [path]: 'expect(run("lines --offset=0")).toBe("line=1");\n' })) : ["no check"]).toEqual([]);
    // Without the findings, the whole feature's rows are demanded.
    const whole = caseCheck(spec, { ...repair, writes: [{ path, action: "modify" }] }, {});
    expect(whole ? await whole(workspace({ [path]: 'expect(run("lines --offset=0")).toBe("line=1");\n' })) : []).toHaveLength(2);
  });
});
