import { expect, test } from "bun:test";
import { scanTestIntegrity, type TestRemovalFinding } from "../src/core/workflows/test-integrity.js";

const path = "tests/adapter.test.ts";
const first = 'test("lint_adapter_one", () => { expect(run(1)).toBe(1); });\n';
const second = 'test("retained", () => { expect(run(2)).toBe(2); });\n';
const before = first + second;
const spec: TestRemovalFinding = { basis: "spec", file: path, claim: "FR-004 assigns command tests to cli", suggestedFix: "Remove lint_adapter_one" };
const protects = new Map([[path, new Map([["lint_adapter_one", "T004 for finding F0"], ["retained", "T003 for finding F2"]])]]);
const scan = (after: string | null, finding = spec, prior: string | undefined = before) => scanTestIntegrity([{ path, before: prior, after }], { protects, removalFindings: [finding] });

test("spec test names and identifier patterns authorize only their removal", () => {
  expect(scan(second)).toEqual([]);
  expect(scan(second, { ...spec, suggestedFix: "Move the lint_adapter_* tests to the cli module" })).toEqual([]);
  expect(scan(first)).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "test-removed", keep: ["retained"] })]));
  expect(scan(second.replace("expect(run(2)).toBe(2);", "" )).map((f) => f.rule)).toEqual(["assertions"]);
});

test("scope findings without explicit authority and targets do not waive protection", () => {
  for (const finding of [
    { ...spec, basis: "inferred" },
    { ...spec, basis: undefined },
    { ...spec, file: "tests/other.test.ts" },
    { ...spec, suggestedFix: "Correct the scope" },
    { ...spec, suggestedFix: "Remove lint_adapter_one_extra" },
    { ...spec, suggestedFix: "Do not remove lint_adapter_one" },
    { ...spec, claim: "lint_adapter_one exercises the old helper", suggestedFix: "Remove the unused production helper" },
    { ...spec, claim: "Test integrity (test-removed)", suggestedFix: "Remove lint_adapter_one" },
  ]) expect(scan(second, finding).map((f) => f.rule)).toContain("test-removed");
});

test("deletion needs every test named or an explicit instruction for the whole file", () => {
  expect(scan(null).map((f) => f.rule)).toEqual(["test-deleted"]);
  expect(scan(null, { ...spec, suggestedFix: "Remove lint_adapter_one and retained" })).toEqual([]);
  const file = { ...spec, suggestedFix: `Move all tests from ${path} to tests/cli.test.ts` };
  expect(scan(null, file)).toEqual([]);
  const unknown = [{ path, before: undefined, after: null }];
  expect(scanTestIntegrity(unknown, { removalFindings: [file] })).toEqual([]);
  expect(scanTestIntegrity(unknown, { removalFindings: [spec] }).map((f) => f.rule)).toEqual(["test-deleted"]);
});

test("authorized removals do not exempt new skips or suppressions", () => {
  expect(scan(second.replace("test(", "test.skip(")).map((f) => f.rule)).toContain("skip");
  expect(scan(`// @ts-ignore\n${second}`).map((f) => f.rule)).toEqual(["suppression"]);
});
