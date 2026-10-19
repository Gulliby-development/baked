import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getIntelligenceClient, setIntelligenceClient } from "../src/core/intelligence/instance.js";
import { runWithCwd } from "../src/core/cwd.js";
import { fuzzyWhitespaceMatch, fuzzyWhitespaceMatchAsync } from "../src/core/tools/edit-file.js";
import { countOccurrences, intelligenceSource } from "../src/core/tools/post-edit-helpers.js";
import { renameFileTool } from "../src/core/tools/rename-file.js";
import type { IntelligenceClient } from "../src/core/workers/intelligence-client.js";
import { ToolDeadlineError, withDeadline } from "../src/core/workflows/stall.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("the shared occurrence counter terminates for an empty needle", () => {
  expect(countOccurrences("assert total() == 1", "")).toBe(0);
  expect(countOccurrences("", "")).toBe(0);
  expect(countOccurrences("aaaa", "aa")).toBe(2);
});

test("a repetitive fuzzy scan yields to timers and stops at its matching deadline", async () => {
  const content = "  assert value\n".repeat(20000);
  const old = "assert value\n".repeat(5000) + "missing()";
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 0);
  try {
    await expect(fuzzyWhitespaceMatchAsync(content, old, "replacement", 20)).rejects.toThrow("Fuzzy edit matching timed out");
    expect(ticked).toBe(true);
  } finally {
    clearTimeout(timer);
  }
});

test("cooperative matching preserves indentation, escape normalization and ambiguity decisions", async () => {
  for (const [content, old, replacement] of [
    ["def test_value():\n\tassert value == 1", "  assert value == 1", "  assert value == 2"],
    ["\tassert value == 1\n\tassert value == 1", "  assert value == 1", "  assert value == 2"],
    ["const x = `value`;", "const x = \\`value\\`;", "const x = `new`;"],
    ["hello\nworld", "", "new"],
  ]) {
    expect(await fuzzyWhitespaceMatchAsync(content!, old!, replacement!)).toEqual(fuzzyWhitespaceMatch(content!, old!, replacement!));
  }
});

test("advisory diagnostics never initialize the main-thread router", async () => {
  const previous = getIntelligenceClient();
  setIntelligenceClient(null);
  cleanups.push(() => setIntelligenceClient(previous));
  const source = intelligenceSource({
    getIntelligenceClient,
    getIntelligenceRouter: () => { throw new Error("main-thread language server startup"); },
  } as unknown as typeof import("../src/core/intelligence/index.js"));
  expect(await source.diagnostics("test_expenses.py")).toBeNull();
});

test("a rename waiting on the worker stops at its deadline before moving or updating imports", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const from = join(fixture.root, "old.py");
  const to = join(fixture.root, "new.py");
  writeFileSync(from, "value = 1\n");
  const previous = getIntelligenceClient();
  setIntelligenceClient({ isReady: true, routerGetFileRenameEdits: () => new Promise(() => {}) } as unknown as IntelligenceClient);
  cleanups.push(() => setIntelligenceClient(previous));
  await expect(runWithCwd(fixture.root, () => withDeadline("rename_file", 100, () => renameFileTool.execute({ from, to })))).rejects.toBeInstanceOf(ToolDeadlineError);
  expect(existsSync(from)).toBe(true);
  expect(existsSync(to)).toBe(false);
});

test("interrupted attempts distinguish zero usage from unknown usage and cannot be charged twice", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { runId } = await fixture.start();
  const { store } = fixture.service;
  const stepId = store.beginStep(runId, "interrupted-usage");
  const zero = store.beginHostAttempt(runId, stepId);
  store.recordAttemptUsage(runId, zero, 0);
  store.finishAttempt(runId, zero, "interrupted", null);
  expect(store.attempts(runId).find((a) => a.id === zero)).toMatchObject({ used_tokens: 0, usage_complete: 1 });
  const unknown = store.beginHostAttempt(runId, stepId);
  store.finishAttempt(runId, unknown, "interrupted", null);
  expect(store.attempts(runId).find((a) => a.id === unknown)).toMatchObject({ used_tokens: null, usage_complete: 0 });
  expect(() => store.finishAttempt(runId, zero, "interrupted", null)).toThrow("Attempt no longer running");
  expect(store.run(runId).token_usage).toBe(0);
});
