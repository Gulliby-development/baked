import { afterEach, describe, expect, test } from "bun:test";
import { hashJson } from "../src/core/specs/hash.js";
import { correctionFocus, focusFirst } from "../src/core/workflows/scheduler.js";
import type { Task } from "../src/core/workflows/types.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const task = (extra: Partial<Task>): Task => ({
  id: "T004",
  title: "Correct F1",
  description: "Correct F1",
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: ["LICENSE", "README.md", "src/cli.rs", "src/parse.rs"].map((path) => ({ path, action: "modify" as const })),
  readHints: [],
  checkIds: [],
  origin: "repair",
  findingIds: [],
  rationale: "Finding",
  ...extra,
});

// #714: a correction may write every file of the tasks it corrects; it starts at the finding's.
describe("correction focus", () => {
  test("names the finding's file, files its claim or fix names, and its symbol, within the task's writes", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { store } = fixture.service;
    const run = await fixture.start();
    const finding = (id: string, body: Record<string, unknown>) => {
      const artifact = store.artifact(run.runId, "review", `reviews/${id}.json`, JSON.stringify(body));
      return store.addFinding(run.runId, { id, ...body }, hashJson({ id, ...body }), artifact.id);
    };
    const ids = store.transaction(() => [
      finding("F1", { file: "src/parse.rs", symbol: "trim_line", claim: "Trailing space is kept", suggestedFix: "Trim in src/cli.rs too" }),
      finding("F2", { file: "src/other.rs", symbol: null, claim: "Unrelated", suggestedFix: "None" }),
    ]);
    const state = store.state(run.runId);
    const correction = task({ findingIds: [ids[0] as string] });
    expect(correctionFocus(store, run.runId, state, correction)).toEqual({
      files: ["src/parse.rs", "src/cli.rs"],
      symbols: ["trim_line"],
    });
    // A finding on a file the task may not write adds nothing; a planned task has no focus.
    expect(correctionFocus(store, run.runId, state, task({ findingIds: [ids[1] as string] })).files).toEqual([]);
    expect(correctionFocus(store, run.runId, state, task({ origin: "planned", findingIds: [ids[0] as string] }))).toEqual({
      files: [],
      symbols: [],
    });
  });

  test("puts the focused files first and keeps the rest in plan order", () => {
    const writes = task({}).writes;
    expect(focusFirst(writes, ["src/parse.rs", "src/cli.rs"]).map((w) => w.path)).toEqual([
      "src/parse.rs",
      "src/cli.rs",
      "LICENSE",
      "README.md",
    ]);
  });
});
