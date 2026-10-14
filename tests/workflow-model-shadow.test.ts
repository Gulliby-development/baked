import { afterEach, describe, expect, test } from "bun:test";
import { parseModelRouting } from "../src/core/llm/model-routing.js";
import { explainRoute, rerouteRecord } from "../src/core/workflows/routing.js";
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

// The #1172 shape: the profile also routes the active class, with an effort for it.
const ACTIVE_ROUTING = {
  classes: { active: { model: "codex/gpt-6-luna", effort: "high" }, review: "codex/gpt-6.1-sol" },
};

async function start(
  extra: { model?: string; modelStrict?: boolean },
  routing: unknown = GLOBAL_ROUTING,
) {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  fixture.config.modelRouting = parseModelRouting(routing);
  const run = await fixture.service.start({
    commandId: newId(),
    featureId: "fixture",
    workflowId: "sdd",
    prompt: "Create ready value",
    ownerLabel: "test",
    policy: fixture.policy,
    ...extra,
  });
  return { ...readRoutingSummary(fixture.service.store, run.runId), fixture };
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

describe("an explicit run model with a configured active class (#1172)", () => {
  test("--model serves the active class and keeps its effort", async () => {
    const summary = await start({ model: "claude-code/sonnet" }, ACTIVE_ROUTING);
    const byTarget = Object.fromEntries(summary.effective.map((row) => [row.target, row.model]));
    expect(byTarget.researcher).toBe("claude-code/sonnet");
    expect(byTarget["spec-author"]).toBe("claude-code/sonnet");
    expect(byTarget.reviewer).toBe("codex/gpt-6.1-sol");
    const text = summary.warnings.join("\n");
    expect(text).not.toContain("modelRouting.classes.active");
    expect(text).toContain("use codex/gpt-6.1-sol (modelRouting.classes.review)");
  });

  test("without --model the configured active class still applies", async () => {
    const summary = await start({}, ACTIVE_ROUTING);
    const byTarget = Object.fromEntries(summary.effective.map((row) => [row.target, row.model]));
    expect(byTarget.researcher).toBe("codex/gpt-6-luna");
    expect(summary.warnings).toEqual([]);
  });

  test("the route preview and a reroute follow the explicit model too", async () => {
    const summary = await start({ model: "claude-code/sonnet" }, ACTIVE_ROUTING);
    const { root, config } = summary.fixture;
    const explained = explainRoute(root, config, { workflowId: "sdd", model: "claude-code/sonnet" });
    expect(explained.profiles.researcher?.model).toBe("claude-code/sonnet");
    expect(explained.profiles.researcher?.effort).toBe("high");
    const previous = {
      schemaVersion: 1 as const,
      runModel: "claude-code/sonnet",
      profiles: {},
      stages: {},
      explicitModel: true,
    };
    const rerouted = rerouteRecord(root, config, previous, "sdd", [], ["researcher"], {});
    expect(rerouted.profiles.researcher?.model).toBe("claude-code/sonnet");
    expect(rerouted.explicitModel).toBe(true);
    const implicit = rerouteRecord(root, config, { ...previous, explicitModel: undefined }, "sdd", [], ["researcher"], {});
    expect(implicit.profiles.researcher?.model).toBe("codex/gpt-6-luna");
  });
});
