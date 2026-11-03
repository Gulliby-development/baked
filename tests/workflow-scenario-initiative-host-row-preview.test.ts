import { afterEach, describe, expect, test } from "bun:test";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import type { SplitBudgetPreview } from "../src/core/workflows/initiatives/split-preview.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 87 citeseek (Python, #2640): 101 prescribed rows in six test files, written by the
// host with no session under `rowFileWrite: "on"`. The split approval's preview still priced each
// row as a test case a session pays for (`testCases` 57 and 44) and each row file as a path: 6.17M
// expected (3.60M, 1.69M, 0.89M) against 2.16M used, while the plan sizing of the same runs priced
// the row tasks at nothing (`hostRowFileTasks`, #2633) and said 1.35M, 1.18M and 1.14M. The
// preview now asks the same decision: on, its expected tokens are those of the split with the row
// files left out, as plan sizing prices them; off, the rows keep the session price.
//
// R87 priced a case at citeseek's measured rate; this fixture has no test history, so a case costs
// the cold-start 15k-75k and the size class prices 57 cases at most. The rows are twice R87's per
// file (114 and 88), so they set the price at the session rate as they did in R87.

const ROWS: Record<string, number> = {
  "tests/test_cli.py": 40,
  "tests/test_files.py": 14,
  "tests/test_tokens.py": 26,
  "tests/test_chunks.py": 34,
  "tests/test_stems.py": 48,
  "tests/test_rank.py": 40,
};
const CHUNKS = ["tests/test_cli.py", "tests/test_files.py", "tests/test_tokens.py", "tests/test_chunks.py"];
const RANKING = ["tests/test_stems.py", "tests/test_rank.py"];

const block = (path: string, n: number) =>
  ["```text", `SearchTests in ${path} (${n} rows, pytest.param(query, expected))`, ...Array.from({ length: n }, (_, i) => `pytest.param("query ${i + 1} of ${path}", ${i + 1}),`), "```"].join("\n");
const PROMPT = ["Build citeseek, a citation search tool.", "", "The prescribed rows, one test each:", "", ...Object.entries(ROWS).flatMap(([p, n]) => [block(p, n), ""])].join("\n");

/**
 * The citeseek split: chunks-cli (114 row cases), ranking (88), docs. Each code feature also has a
 * test file of no rows, so `rows: false` (the row files and their cases left out) is still a split.
 */
const split = (rows = true): InitiativePlan => ({
  schemaVersion: 1, title: "Citeseek", goals: ["Search citations"], completionCriteria: ["The CLI ranks chunks"],
  features: [
    { id: "chunks-cli", title: "Chunks and CLI", size: "large", workflow: "sdd", boundary: { scope: "Chunk files and the CLI", paths: ["citeseek/text.py", "citeseek/chunks.py", "citeseek/cli.py", "tests/test_smoke.py", ...(rows ? CHUNKS : [])] },
      contract: "The CLI prints chunks", dependsOn: [], mandatory: true, ...(rows ? { testCases: 114 } : {}) },
    { id: "ranking", title: "Ranking", size: "medium", workflow: "sdd", boundary: { scope: "Rank chunks", paths: ["citeseek/rank.py", "citeseek/cli.py", "tests/test_order.py", ...(rows ? RANKING : [])] },
      contract: "The CLI ranks chunks", dependsOn: ["chunks-cli"], mandatory: true, ...(rows ? { testCases: 88 } : {}) },
    { id: "docs", title: "Docs", size: "small", workflow: "sdd", boundary: { scope: "Document it", paths: ["README.md", "LICENSE"] },
      contract: "The README documents it", dependsOn: ["chunks-cli", "ranking"], mandatory: true },
  ],
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The split approval's budget preview, before any feature run or task plan exists. */
async function preview(policy: Pick<RunPolicy, "rowFileWrite">, plan = split()): Promise<SplitBudgetPreview> {
  const fixture = workflowFixture();
  cleanups.push(() => fixture.dispose());
  const initiatives = new InitiativeService(fixture.service);
  const view = await initiatives.start({
    commandId: newId(), initiativeId: "citeseek", prompt: PROMPT, ownerLabel: "test", plan, keepFeatures: true,
    featureAutoApproval: { maxTasks: 8, maxFiles: 40 },
    policy: { ...fixturePolicy, clarification: "assume", sizing: { maxRunTokens: 8_000_000 }, ...policy },
    budget: { maxTotalTokens: 8_000_000, maxAgentCalls: 1000, maxActiveMs: 21_600_000 },
  });
  expect(view.status).toBe("awaiting_approval");
  const found = initiatives.view("citeseek").budget.preview;
  if (!found) throw new Error("No budget preview at the split approval");
  return found;
}

describe("scenario: R87 citeseek, the preview prices the rows the host writes at host cost (#2640)", () => {
  test("rowFileWrite on: the preview expects what the split costs without its row files, as plan sizing prices them", async () => {
    const on = await preview({ rowFileWrite: "on" });
    const off = await preview({});
    const without = await preview({ rowFileWrite: "on" }, split(false));
    // Off: the rows at the session rate set both code features' price, 202 cases at 15k-75k.
    expect(off.expected["chunks-cli"]).toBe(114 * 45_000);
    expect(off.expected.ranking).toBe(88 * 45_000);
    expect(off.expected["chunks-cli"]).toBeGreaterThan(without.expected["chunks-cli"] ?? 0);
    expect(off.expected.ranking).toBeGreaterThan(without.expected.ranking ?? 0);
    // On: the rows are the host's, at no cost, and every feature falls to the row-free split.
    expect(on.expected).toEqual(without.expected);
    expect(on.lows).toEqual(without.lows);
    expect(on.sumExpected).toBe(without.sumExpected);
    expect(on.sumExpected).toBeLessThan(off.sumExpected * 0.65);
    // Docs has no rows: the same price either way.
    expect(on.expected.docs).toBe(off.expected.docs);
  });

  test("a row file of a language the host writes no rows for keeps the session price", async () => {
    // The same rows prescribed for bats files: no `ROW_FILE_SHAPES` row (#2553), so a session writes them.
    const rust = (plan: InitiativePlan): InitiativePlan => ({
      ...plan,
      features: plan.features.map((f) => ({ ...f, boundary: { ...f.boundary, paths: f.boundary.paths.map((p) => p.replace(/^tests\/(\w+)\.py$/, "tests/$1.bats")) } })),
    });
    const fixture = workflowFixture();
    cleanups.push(() => fixture.dispose());
    const initiatives = new InitiativeService(fixture.service);
    const of = async (id: string, policy: Pick<RunPolicy, "rowFileWrite">) => {
      await initiatives.start({
        commandId: newId(), initiativeId: id, prompt: PROMPT.replaceAll(".py (", ".bats ("), ownerLabel: "test", plan: rust(split()), keepFeatures: true,
        featureAutoApproval: { maxTasks: 8, maxFiles: 40 },
        policy: { ...fixturePolicy, clarification: "assume", sizing: { maxRunTokens: 8_000_000 }, ...policy },
        budget: { maxTotalTokens: 8_000_000, maxAgentCalls: 1000, maxActiveMs: 21_600_000 },
      });
      return initiatives.view(id).budget.preview;
    };
    const on = await of("rust-on", { rowFileWrite: "on" });
    const off = await of("rust-off", {});
    expect(on?.expected).toEqual(off?.expected);
    expect(on?.sumExpected).toBe(off?.sumExpected);
  });
});
