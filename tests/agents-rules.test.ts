// The area rules of AGENTS.md live one per file under `.agents/rules/<area>/`, so pull requests that
// add rules in the same area never edit the same lines (2026-11-03: seven of nine merge queue
// conflicts in one batch were AGENTS.md). AGENTS.md indexes the areas; this test keeps the index and
// the folders in step.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const rulesDir = join(root, ".agents/rules");
const agents = readFileSync(join(root, "AGENTS.md"), "utf8");

function indexedAreas(text: string): string[] {
  const section = text.split(/^## Area rules$/m)[1]?.split(/^## /m)[0] ?? "";
  return [...section.matchAll(/^\| \[`([a-z0-9-]+)`\]\(\.agents\/rules\/\1\/\) \|/gm)].map((m) => m[1] ?? "");
}

describe("AGENTS.md area rules", () => {
  const folders = readdirSync(rulesDir).filter((name) => statSync(join(rulesDir, name)).isDirectory()).sort();

  test("every area folder has a row in the AGENTS.md index, and every row a folder", () => {
    expect(indexedAreas(agents).sort()).toEqual(folders);
  });

  test("a rule file is one non-empty kebab-case Markdown paragraph, and nothing else sits in the rules tree", () => {
    const problems: string[] = [];
    for (const name of readdirSync(rulesDir))
      if (!folders.includes(name)) problems.push(`${name}: not an area folder`);
    for (const area of folders)
      for (const file of readdirSync(join(rulesDir, area))) {
        const where = `${area}/${file}`;
        if (!/^[a-z0-9]+(-[a-z0-9]+)*\.md$/.test(file)) {
          problems.push(`${where}: not a kebab-case .md name`);
          continue;
        }
        const text = readFileSync(join(rulesDir, area, file), "utf8").trim();
        if (!text) problems.push(`${where}: empty`);
        else if (/^#/m.test(text)) problems.push(`${where}: a heading; a rule file is one paragraph`);
      }
    expect(problems).toEqual([]);
  });

  test("the rule files are not copied back into AGENTS.md", () => {
    const opening = (path: string) => readFileSync(path, "utf8").trim().slice(0, 120);
    const copied = folders.flatMap((area) =>
      readdirSync(join(rulesDir, area))
        .filter((file) => agents.includes(opening(join(rulesDir, area, file))))
        .map((file) => `${area}/${file}`),
    );
    expect(copied).toEqual([]);
  });
});
