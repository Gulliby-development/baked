import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMMENT_MARKER,
  commentBody,
  reviewerFamily,
  reviewPrompt,
  sweepChecklist,
} from "../scripts/adversarial-review";

const root = join(import.meta.dir, "..");
const skill = readFileSync(join(root, ".agents/skills/file-issue/SKILL.md"), "utf8");
const instructions = readFileSync(join(root, ".agents/skills/file-issue/adversarial-review.md"), "utf8");

describe("adversarial sweep review (#1722)", () => {
  test("takes the sweep checklist from the file-issue skill, so a new dimension reaches the reviewer", () => {
    const checklist = sweepChecklist(skill);
    expect(checklist).toContain("## 2. Sweep for every occurrence");
    expect(checklist).toContain("## 3. Sweep every supported language");
    expect(checklist).toContain("**Toolchains.**");
    expect(checklist).not.toContain("## 4. Check for duplicates");
    const extended = skill.replace("- **Providers.**", "- **Locales.** Every locale the formatter serves.\n- **Providers.**");
    expect(sweepChecklist(extended)).toContain("**Locales.** Every locale the formatter serves.");
  });

  test("the prompt carries the instructions, the checklist, the issue, the Sweep section and the diff", () => {
    const prompt = reviewPrompt(
      {
        issues: [{ number: 7, title: "gofmt stubs refused", body: "Problem: stubs differ in whitespace." }],
        prNumber: 9,
        prTitle: "Accept formatter whitespace",
        prBody: "Before: x\n\n## Sweep\n- `task-graph.ts` fixed\nLanguages: Go only.\n\n## Tests\ny",
        diff: "+const a = 1;",
      },
      skill,
      instructions,
    );
    expect(prompt.startsWith("# Adversarial sweep review")).toBe(true);
    expect(prompt).toContain("## 3. Sweep every supported language");
    expect(prompt).toContain("# Issue #7: gofmt stubs refused");
    expect(prompt).toContain("- `task-graph.ts` fixed\nLanguages: Go only.");
    expect(prompt).not.toContain("## Tests\ny");
    expect(prompt).toContain("```diff\n+const a = 1;\n```");
    const long = reviewPrompt({ issues: [], prNumber: 1, prTitle: "t", prBody: "", diff: "x".repeat(130_000) }, skill, instructions);
    expect(long).toContain("[The diff is cut at 120000 characters of 130000.]");
    expect(long).toContain("(The description has no Sweep section.)");
  });

  test("a model of the other family reviews", () => {
    const both: ("anthropic" | "openai")[] = ["openai", "anthropic"];
    expect(reviewerFamily(["Fix\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>"], both)).toBe("openai");
    expect(reviewerFamily(["Fix from the Codex runner"], both)).toBe("anthropic");
    expect(reviewerFamily(["Fix"], both)).toBe("openai");
    // Only the fixer's own family has a key: no review rather than a same-family one.
    expect(reviewerFamily(["Claude-Session: https://claude.ai/code/x"], ["anthropic"])).toBeNull();
    expect(reviewerFamily(["Fix"], [])).toBeNull();
  });

  test("the comment is marked, so a new push updates it", () => {
    const body = commentBody("## Missed places\nNone found.", "openai");
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain("(advisory)");
    expect(body).toContain("None found.");
  });
});
