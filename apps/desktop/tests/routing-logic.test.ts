import { describe, expect, test } from "bun:test";
import { offers, ROUTING_CAPABILITY } from "../src/renderer/client/capabilities.ts";
import type { RoutingOverview, RoutingRow } from "../src/renderer/client/setup.ts";
import {
  describeResolved,
  describeRoute,
  draftOf,
  layerValue,
  parseFallback,
  routingGroups,
  unresolvedText,
} from "../src/renderer/screens/setup/routing-logic.ts";

const row = (extra: Partial<RoutingRow>): RoutingRow => ({
  target: { kind: "role", role: "reviewer" },
  path: "roles.reviewer",
  label: "reviewer",
  global: null,
  project: null,
  resolved: null,
  ...extra,
});

const view: RoutingOverview = {
  layers: {},
  workflows: ["sdd"],
  workflowId: "sdd",
  runModel: null,
  classes: [],
  roles: [row({})],
  stages: [],
  profiles: [],
  independentReview: { global: null, project: null, effective: "off" },
  warnings: [],
  error: null,
};

describe("model routing section", () => {
  test("routes read as model, effort and fallback", () => {
    expect(describeRoute("a/b")).toBe("a/b");
    expect(describeRoute({ model: "$deep", effort: "high", fallback: ["c/d", "e/f"] })).toBe(
      "$deep · high · → c/d, e/f",
    );
    expect(describeRoute(null)).toBe("");
    expect(describeResolved({ model: "a/b", source: "x", effort: "default", fallback: [] })).toBe(
      "a/b",
    );
    expect(draftOf({ model: "a/b", fallback: ["c/d"] })).toEqual({
      model: "a/b",
      effort: null,
      fallback: ["c/d"],
    });
    expect(parseFallback(" a/b, c/d  e/f,")).toEqual(["a/b", "c/d", "e/f"]);
  });

  test("lists the groups of the TUI screen and each layer's value", () => {
    expect(routingGroups(view).map((g) => g.title)).toEqual([
      "Classes",
      "Roles",
      "Stages of sdd",
      "Profiles",
    ]);
    const both = row({ global: "a/b", project: "$deep" });
    expect(layerValue(both, "global")).toBe("a/b");
    expect(layerValue(both, "project")).toBe("$deep");
    expect(unresolvedText(row({}), view)).toBe("the profile's own model");
    expect(unresolvedText(row({ target: { kind: "class", name: "fast" } }), view)).toBe(
      "needs a run model",
    );
  });

  test("an older backend without the routing capability is told apart", () => {
    expect(offers(["setup"], ROUTING_CAPABILITY)).toBe(false);
    expect(offers(["setup", "routing"], ROUTING_CAPABILITY)).toBe(true);
  });
});
