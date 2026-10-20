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

  // #1764: md-site T075 (bench round 52) corrected F-003, a repeat of F-002 that T074 had fixed
  // in src/render.ts, with no file to focus on: it preloaded all ten writes and spent 2.46M tokens.
  test("focuses a repeat finding on the files the correction of the finding it repeats changed", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { store } = fixture.service;
    const run = await fixture.start();
    const finding = (id: string, body: Record<string, unknown>) => {
      const artifact = store.artifact(run.runId, "review", `reviews/${id}.json`, JSON.stringify(body));
      return store.addFinding(run.runId, { id, ...body }, hashJson({ id, ...body }), artifact.id);
    };
    const [first, repeat] = store.transaction(() => [
      finding("F-002", { file: null, symbol: null, claim: "Headings lose their anchors", suggestedFix: "Keep ids" }),
      finding("F-003", {
        file: null,
        symbol: null,
        claim: "Nested headings still lose their anchors",
        suggestedFix: "Keep ids at every level",
        repeatOf: "F-002",
      }),
    ]) as [string, string];
    const earlier = task({ id: "T074", findingIds: [first] });
    const writes = ["src/render.ts", "src/parse.ts", "src/cli.ts", "README.md"].map((path) => ({
      path,
      action: "modify" as const,
    }));
    const correction = task({ id: "T075", findingIds: [repeat], writes });
    const base = store.state(run.runId);
    const state = { ...base, graph: { ...(base.graph ?? {}), tasks: [earlier, correction] } } as typeof base;
    // T074 changed src/render.ts and src/parse.ts; its unapplied write to src/cli.ts does not count.
    const { attemptId } = store.transaction(() => store.beginExternalAttempt(run.runId, "task-T074"));
    store.transaction(() => {
      for (const path of ["src/render.ts", "src/parse.ts"]) {
        const id = store.prepareEffect(run.runId, attemptId, "file_patch", { path, tool: "edit_file" }, null, null);
        store.effectStatus(run.runId, id, "applied");
      }
      store.prepareEffect(run.runId, attemptId, "file_patch", { path: "src/cli.ts", tool: "edit_file" }, null, null);
    });
    expect(correctionFocus(store, run.runId, state, correction).files).toEqual(["src/render.ts", "src/parse.ts"]);
    // The first correction of a finding has no predecessor to follow.
    expect(correctionFocus(store, run.runId, state, task({ id: "T076", findingIds: [first], writes })).files).toEqual(
      [],
    );
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
