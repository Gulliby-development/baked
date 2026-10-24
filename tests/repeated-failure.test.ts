import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  failureHash,
  firstDifference,
  normalizeCheckOutput,
  repeatCheck,
  repeatedFailureDecision,
  repeatRecord,
} from "../src/core/workflows/repeated-failure.js";

// #1996: two runs of the same failing check hash equal, whatever toolchain prints them; a moved
// position or another message is progress. A check runner whose failing output carries another
// value that changes between runs adds its pair here with its normalization.
const tmp = join(tmpdir(), "baked-check-x1").replaceAll("\\", "/");
const pairs: [string, string, string][] = [
  ["gofmt", "internal\\lint\\rules_test.go:26:2217: illegal byte order mark\r\n", "internal/lint/rules_test.go:26:2217: illegal byte order mark\n"],
  ["go test", "--- FAIL: TestRules (0.00s)\n    rules_test.go:40: got 1\nFAIL\nFAIL\tcfgquill/internal/lint\t0.012s\n", "--- FAIL: TestRules (0.03s)\n    rules_test.go:40: got 1\nFAIL\nFAIL\tcfgquill/internal/lint\t0.457s\n"],
  ["bun test", "\u001b[31m(fail)\u001b[0m parse > rejects [1.23ms]\n 0 pass\n 1 fail\nRan 1 test across 1 file. [45.00ms]", "(fail) parse > rejects [0.98ms]\n 0 pass\n 1 fail\nRan 1 test across 1 file. [51.12ms]"],
  ["jest", "  ✕ rejects bad input (5 ms)\nTime:        1.234 s", "  ✕ rejects bad input (12 ms)\nTime:        0.871 s"],
  ["pytest", "FAILED tests/test_cli.py::test_parse - AssertionError\n1 failed in 0.12s", "FAILED tests/test_cli.py::test_parse - AssertionError\n1 failed in 0.31s"],
  ["cargo", "test parse ... FAILED\ntest result: FAILED. 0 passed; 1 failed; finished in 0.00s", "test parse ... FAILED\ntest result: FAILED. 0 passed; 1 failed; finished in 0.02s"],
  ["temp paths", `error: ${tmp}/a1/out.txt missing at 2026-10-24T04:42:53.120Z`, `error: ${tmp}/b7/out.txt missing at 2026-10-24T05:01:02.004Z`],
  ["addresses", "panic: nil map at 0xc000123456", "panic: nil map at 0xc000fedcba"],
];

describe("repeated failure hash (#1996)", () => {
  test.each(pairs)("two runs of the same %s failure hash equal", (_name, a, b) => {
    expect(normalizeCheckOutput(a)).toBe(normalizeCheckOutput(b));
    expect(failureHash([repeatCheck("check", a, ["f"])])).toBe(failureHash([repeatCheck("check", b, ["f"])]));
  });

  test("a moved position, another message, another check or other files is progress", () => {
    const base = [repeatCheck("gofmt", "rules_test.go:26:2217: illegal byte order mark", ["rules_test.go"])];
    const variants = [
      [repeatCheck("gofmt", "rules_test.go:27:2217: illegal byte order mark", ["rules_test.go"])],
      [repeatCheck("gofmt", "rules_test.go:26:2217: expected declaration", ["rules_test.go"])],
      [repeatCheck("vet", "rules_test.go:26:2217: illegal byte order mark", ["rules_test.go"])],
      [repeatCheck("gofmt", "rules_test.go:26:2217: illegal byte order mark", ["rules.go"])],
      [...base, repeatCheck("tests-written", "rules_test.go:26:3024: illegal byte order mark", ["rules_test.go"])],
    ];
    for (const variant of variants) {
      expect(repeatedFailureDecision(base, variant)).toBe("progress");
      expect(firstDifference(base, variant)).not.toBeNull();
    }
    expect(repeatedFailureDecision(base, base)).toBe("repeat");
    expect(repeatedFailureDecision(null, base)).toBe("first");
    // Check order does not matter.
    const two = [repeatCheck("b", "x", []), repeatCheck("a", "y", [])];
    expect(failureHash(two)).toBe(failureHash([...two].reverse()));
  });

  test("a record names its chain root and the corrective it was compared with", () => {
    const checks = [repeatCheck("gofmt", "bom", ["a.go"])];
    const first = repeatRecord("T005", "T003", null, checks);
    expect(first).toMatchObject({ taskId: "T005", previous: null, root: "T003", decision: "first", previousHash: null, firstDifference: null });
    const second = repeatRecord("T006", "T005", first, checks);
    expect(second).toMatchObject({ previous: "T005", root: "T003", decision: "repeat", previousHash: first.hash, firstDifference: null });
  });
});
