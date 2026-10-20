import { describe, expect, test } from "bun:test";
import { closedIssueNumbers, sweepProblem, sweepSection } from "../scripts/check-sweep-section";

const REPO = "Gulliby-development/baked";

describe("sweep section check", () => {
  test("finds closing references to this repository only", () => {
    const body = "Closes #12, fixes: #13 and Resolves Gulliby-development/baked#14.\nRefs #15. Closes other/repo#16.";
    expect(closedIssueNumbers(body, REPO).sort((a, b) => a - b)).toEqual([12, 13, 14]);
  });

  test("reads the section up to the next heading of the same level", () => {
    const body = "## How\nx\n\n## Sweep\n- `a.ts:10` fixed\n### Checked, not affected\n- `b.ts`\n\n## Tests\ny";
    expect(sweepSection(body)).toBe("- `a.ts:10` fixed\n### Checked, not affected\n- `b.ts`");
  });

  test("treats a section with only a template comment as empty", () => {
    expect(sweepSection("## Sweep\n<!-- list the places -->\n\n## Tests\n")).toBe("");
    expect(sweepSection("## How\nno sweep here")).toBeNull();
  });

  test("requires the section only when a Bug issue is closed", () => {
    expect(sweepProblem("Closes #1", [{ number: 1, isBug: false }])).toBeNull();
    expect(sweepProblem("Closes #1", [])).toBeNull();
    expect(sweepProblem("Closes #1", [{ number: 1, isBug: true }])).toContain("no \"## Sweep\" section");
    expect(sweepProblem("Closes #1\n## Sweep\n", [{ number: 1, isBug: true }])).toContain("is empty");
    expect(
      sweepProblem("Closes #1\n## Sweep\nAll three call sites fixed.\nLanguages: not language-bound (git refs).", [
        { number: 1, isBug: true },
      ]),
    ).toBeNull();
  });

  test("requires a Languages line in the section", () => {
    const bug = [{ number: 1, isBug: true }];
    expect(sweepProblem("Closes #1\n## Sweep\nAll three call sites fixed.", bug)).toContain('no "Languages:" line');
    expect(sweepProblem("Closes #1\n## Sweep\n- a.ts fixed\n- **Languages:** python, go, rust", bug)).toBeNull();
    expect(sweepProblem("Closes #1\n## Sweep\n- a.ts fixed\n* Languages: go (#12 for rust)", bug)).toBeNull();
    expect(sweepProblem("Closes #1\n## Sweep\nfixed\n## Notes\nLanguages: go", bug)).toContain('no "Languages:" line');
  });
});
