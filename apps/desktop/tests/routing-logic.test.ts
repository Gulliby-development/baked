import { describe, expect, test } from "bun:test";
import { offers, ROUTING_CAPABILITY } from "../src/renderer/client/capabilities.ts";
import type { RoutingOverview, RoutingRow } from "../src/renderer/client/setup.ts";
import {
  describeResolved,
  describeRoute,
  draftOf,
  effortLabel,
  layerValue,
  parseFallback,
  plainName,
  routeActionLabel,
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
      context: null,
    });
    expect(describeRoute({ model: "claude-code/opus", context: 1_000_000 })).toBe(
      "claude-code/opus · context 1m",
    );
    expect(draftOf({ model: "claude-code/opus", context: "auto" }).context).toBe("auto");
    expect(parseFallback(" a/b, c/d  e/f,")).toEqual(["a/b", "c/d", "e/f"]);
  });

  test("lists the groups of the TUI screen and each layer's value", () => {
    expect(routingGroups(view).map((g) => g.title)).toEqual([
      "Model names",
      "Agent roles",
      "Workflow steps of sdd",
      "Agent profiles",
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

  test("rows and efforts read in plain words", () => {
    expect(plainName(row({ label: "spec-author" }))).toBe("Spec author");
    expect(plainName(row({ target: { kind: "class", name: "fast" }, label: "$fast" }))).toBe("$fast");
    expect(effortLabel(null)).toBe("inherit");
    expect(effortLabel("default")).toBe("model default");
    expect(effortLabel("xhigh")).toBe("xhigh");
  });

  test("a row's action names its table, so a role and a profile of one name differ", () => {
    const reviewer = row({ label: "reviewer" });
    expect(routeActionLabel("Edit", reviewer, "roles")).toBe("Edit Reviewer role");
    expect(routeActionLabel("Edit", reviewer, "profiles")).toBe("Edit Reviewer profile");
    expect(routeActionLabel("Clear", row({ target: { kind: "class", name: "fast" }, label: "$fast" }), "classes")).toBe(
      "Clear $fast model name",
    );
  });
});
