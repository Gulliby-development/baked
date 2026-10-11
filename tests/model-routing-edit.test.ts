import { describe, expect, test } from "bun:test";
import {
  describeRoute,
  draftOf,
  draftProblems,
  parseFallback,
  routeAt,
  routeOf,
  routingClasses,
  routingProblems,
  setIndependentReview,
  setRoute,
} from "../src/core/workflows/routing-edit.js";

describe("editing modelRouting one route at a time", () => {
  test("a draft becomes the shortest route and reads back the same", () => {
    expect(routeOf({ model: " a/model ", effort: null, fallback: [] })).toBe("a/model");
    const full = routeOf({ model: "a/model", effort: "high", fallback: ["b/one", " "] });
    expect(full).toEqual({ model: "a/model", effort: "high", fallback: ["b/one"] });
    expect(draftOf(full)).toEqual({ model: "a/model", effort: "high", fallback: ["b/one"] });
    expect(draftOf(undefined)).toEqual({ model: "", effort: null, fallback: [] });
    expect(describeRoute(full)).toBe("a/model · high · → b/one");
    expect(parseFallback("b/one, c/two  d/three")).toEqual(["b/one", "c/two", "d/three"]);
  });

  test("setting and clearing routes keeps the layer minimal", () => {
    let routing = setRoute(undefined, { kind: "class", name: "deep" }, "big/model");
    routing = setRoute(routing, { kind: "role", role: "researcher" }, "$deep");
    routing = setRoute(routing, { kind: "stage", workflowId: "sdd", stageId: "plan" }, "x/plan");
    expect(routing).toEqual({
      classes: { deep: "big/model" },
      roles: { researcher: "$deep" },
      workflows: { sdd: { stages: { plan: "x/plan" } } },
    });
    expect(routeAt(routing, { kind: "stage", workflowId: "sdd", stageId: "plan" })).toBe("x/plan");
    routing = setRoute(routing, { kind: "stage", workflowId: "sdd", stageId: "plan" }, null);
    routing = setRoute(routing, { kind: "role", role: "researcher" }, null);
    expect(routing).toEqual({ classes: { deep: "big/model" } });
    expect(setRoute(routing, { kind: "class", name: "deep" }, null)).toBeUndefined();
    expect(setIndependentReview(undefined, "require")).toEqual({ independentReview: "require" });
    expect(setIndependentReview({ independentReview: "warn" }, null)).toBeUndefined();
  });

  test("a draft names a model, a class names no class, fallbacks are distinct models", () => {
    const role = { kind: "role", role: "planner" } as const;
    const cls = { kind: "class", name: "deep" } as const;
    expect(draftProblems(role, { model: "", effort: null, fallback: [] })).toHaveLength(1);
    expect(draftProblems(role, { model: "$deep", effort: null, fallback: [] })).toEqual([]);
    expect(draftProblems(role, { model: "$Deep", effort: null, fallback: [] })[0]).toContain(
      "lowercase",
    );
    expect(draftProblems(cls, { model: "$fast", effort: null, fallback: [] })[0]).toContain(
      "not another class",
    );
    expect(draftProblems({ kind: "class", name: "Bad" }, { model: "a/b", effort: null, fallback: [] })).toHaveLength(1);
    const fallback = draftProblems(role, {
      model: "a/b",
      effort: null,
      fallback: ["a/b", "$fast", "c/d", "c/d"],
    });
    expect(fallback.join("\n")).toMatch(/At most three/);
    expect(fallback.join("\n")).toMatch(/not classes/);
    expect(fallback.join("\n")).toMatch(/repeats the primary/);
    expect(fallback.join("\n")).toMatch(/listed twice/);
  });

  test("validation finds undefined classes across both layers and schema errors", () => {
    const project = { roles: { researcher: "$deep" } };
    expect(routingProblems(project, undefined, "project")).toEqual([
      "roles.researcher uses $deep, which no class defines",
    ]);
    expect(routingProblems(project, { classes: { deep: "big/model" } }, "project")).toEqual([]);
    expect(routingProblems({ roles: { researcher: "$fast" } }, undefined, "global")).toEqual([]);
    const bad = routingProblems(
      { roles: { researcher: { model: "a/b", effort: "huge" } } } as never,
      undefined,
      "global",
    );
    expect(bad[0]).toContain("roles.researcher");
    expect(routingClasses({ classes: { zeta: "z/z" } }, { classes: { deep: "d/d" } })).toEqual([
      "active",
      "fast",
      "coding",
      "review",
      "deep",
      "zeta",
    ]);
  });
});
