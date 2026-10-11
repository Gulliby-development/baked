import { describe, expect, test } from "bun:test";
import type { RouteExplanation } from "../src/renderer/client/setup.ts";
import { routeExtras, routeModels, routeRows } from "../src/renderer/screens/start/route-logic.ts";

const explanation: RouteExplanation = {
  workflowId: "sdd",
  runModel: "anthropic/claude-sonnet-5-5",
  stages: [
    {
      stageId: "plan",
      kind: "agent",
      profileId: "planner",
      model: "openai/gpt-6",
      source: "modelRouting.roles.planner → $review",
      effort: "high",
      fallback: ["anthropic/claude-opus-5-5"],
    },
    {
      stageId: "research",
      kind: "agent",
      profileId: "researcher",
      model: null,
      source: null,
      effort: null,
      fallback: [],
    },
    {
      stageId: "implement",
      kind: "tasks",
      profileId: null,
      model: null,
      source: null,
      effort: null,
      fallback: [],
    },
  ],
  profiles: {
    researcher: { model: "anthropic/claude-sonnet-5-5", source: "run model", effort: "low" },
  },
  warnings: [],
};

describe("route explanation", () => {
  test("a stage's own route comes first, as `baked workflow route` prints it", () => {
    const [plan, research, implement] = routeRows(explanation);
    expect(plan).toEqual({
      stageId: "plan",
      kind: "agent",
      model: "openai/gpt-6",
      source: "modelRouting.roles.planner → $review",
      effort: "high",
      fallback: ["anthropic/claude-opus-5-5"],
    });
    expect(research).toMatchObject({
      model: "anthropic/claude-sonnet-5-5",
      source: "run model via researcher",
      effort: "low",
    });
    expect(implement).toMatchObject({ model: null, source: "each agent's profile" });
  });

  test("extras and the distinct models", () => {
    const rows = routeRows(explanation);
    expect(rows.map(routeExtras)).toEqual([
      "high effort · → anthropic/claude-opus-5-5",
      "low effort",
      "",
    ]);
    expect(routeExtras({ effort: "default", fallback: [] })).toBe("");
    expect(routeModels(rows)).toEqual(["openai/gpt-6", "anthropic/claude-sonnet-5-5"]);
  });
});
