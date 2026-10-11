import { afterEach, describe, expect, test } from "bun:test";
import { parseModelRouting } from "../src/core/llm/model-routing.js";
import { newId } from "../src/core/workflows/store.js";
import { readRoutingSummary } from "../src/core/workflows/view.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// The bench round 03 shape: `--model claude-code/sonnet` with the owner's global class routing.
const GLOBAL_ROUTING = {
  classes: { coding: "codex/gpt-6-luna", review: "codex/gpt-6.1-sol" },
};

async function start(extra: { model?: string; modelStrict?: boolean }) {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  fixture.config.modelRouting = parseModelRouting(GLOBAL_ROUTING);
  const run = await fixture.service.start({
    commandId: newId(),
    featureId: "fixture",
    workflowId: "sdd",
    prompt: "Create ready value",
    ownerLabel: "test",
    policy: fixture.policy,
    ...extra,
  });
  return readRoutingSummary(fixture.service.store, run.runId);
}

describe("an explicit run model shadowed by class routing", () => {
  test("warns which roles run on another model and records the effective models", async () => {
    const summary = await start({ model: "claude-code/sonnet" });
    expect(summary?.strict).toBe(false);
    expect(summary?.warnings.join("\n")).toContain(
      "Model claude-code/sonnet applies to the active class only",
    );
    expect(summary?.warnings.join("\n")).toContain(
      "implementer, acceptance-writer use codex/gpt-6-luna (modelRouting.classes.coding)",
    );
    expect(summary?.warnings.join("\n")).toContain("--model-strict");
    const byTarget = Object.fromEntries(summary?.effective.map((row) => [row.target, row.model]) ?? []);
    expect(byTarget.implementer).toBe("codex/gpt-6-luna");
    expect(byTarget.reviewer).toBe("codex/gpt-6.1-sol");
  });

  test("a run without an explicit model has nothing to warn about", async () => {
    const summary = await start({});
    expect(summary?.warnings ?? []).toEqual([]);
  });

  test("a strict model serves every class and leaves no warning", async () => {
    const summary = await start({ model: "claude-code/sonnet", modelStrict: true });
    expect(summary?.strict).toBe(true);
    expect(summary?.warnings).toEqual([]);
    expect([...new Set(summary?.effective.map((row) => row.model))]).toEqual(["claude-code/sonnet"]);
  });
});
