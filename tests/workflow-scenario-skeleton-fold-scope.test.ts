import { describe, expect, test } from "bun:test";
import { criticalPathFeatures, featureWork } from "../src/core/workflows/initiatives/critical-path.js";
import {
  applySplitEdit,
  foldSkeletonFeatures,
  type InitiativeFeature,
  type InitiativePlan,
  mergeSmallSiblings,
} from "../src/core/workflows/initiatives/plan.js";
import { featurePrompt } from "../src/core/workflows/initiatives/service.js";
import type { InitiativeRow } from "../src/core/workflows/initiatives/store.js";

// Scenario of bench round 56, hdrlens (Go, #1829). After the critical-path rule sent its first
// answer back, the decomposer gave the 25 package stubs a `scaffold` feature whose scope said
// "Create all 25 internal stubs; do not implement them", next to `base`, which owns three of those
// stubs. The host folded scaffold into base and joined the two scopes with a newline, so base was
// told to implement text.go, options.go and io.go and not to implement them. Specify, plan and
// analyze looped four times on it: 503k tokens and 15.1 minutes at the head of the critical path.

const MODULES = ["text", "options", "io", "message", "negotiate", "byterange", "freshness", "cookies", "summary", "cmd"];
const STUBS = MODULES.map((m) => ({ path: `internal/hdr/${m}.go`, content: `package hdr\n\n// ${m}: filled by its feature.\n` }));
const SCAFFOLD_SCOPE = `Create all ${STUBS.length} internal stubs; do not implement them or change existing root files.`;
const feature = (id: string, paths: string[], dependsOn: string[], extra: Partial<InitiativeFeature> = {}): InitiativeFeature => ({
  id, title: id, boundary: { scope: `Own the ${id} code`, paths }, contract: `${id} works`, dependsOn, mandatory: true, size: "medium", ...extra,
});
const owns = (id: string, modules: string[]) => [...modules.map((m) => `internal/hdr/${m}.go`), `internal/hdr/${id}_test.go`];
const scaffold = feature("scaffold", STUBS.map((s) => s.path), [], {
  size: "small", skeleton: STUBS, boundary: { scope: SCAFFOLD_SCOPE, paths: STUBS.map((s) => s.path) }, contract: "Stubs only; no behavior.",
});
const base = feature("base", owns("base", ["text", "options", "io"]), ["scaffold"], {
  boundary: { scope: "Own shared text, options, IO and in-memory test support.", paths: owns("base", ["text", "options", "io"]) },
});
const hdrlens: InitiativePlan = {
  schemaVersion: 1, title: "hdrlens", goals: ["An HTTP header-field analyzer"], completionCriteria: ["Every command works"],
  features: [
    scaffold,
    base,
    feature("message", owns("message", ["message"]), ["base"]),
    feature("negotiate", owns("negotiate", ["negotiate", "byterange"]), ["message"]),
    feature("front", owns("front", ["cmd", "summary"]), ["negotiate"]),
  ],
};
const BASE_STUBS = ["text", "options", "io"].map((m) => `internal/hdr/${m}.go`);

/** The merged feature states each stub's fate once: its own stubs implemented, no stub-wide "do not implement". */
function expectOneOrder(merged: InitiativeFeature | undefined) {
  expect(merged).toBeDefined();
  const scope = merged?.boundary.scope ?? "";
  expect(scope).not.toContain("do not implement");
  expect(scope).toContain(`This feature implements ${BASE_STUBS.join(", ")}.`);
  expect(scope).toContain("The other stubs stay as written for the features that fill them.");
  expect(scope).toContain("Own shared text, options, IO and in-memory test support.");
  expect(merged?.contract).not.toContain("no behavior");
  expect(merged?.contract).toContain("base works");
  expect(merged?.skeleton).toEqual(STUBS);
}

describe("a skeleton feature merged with a feature that fills its stubs (#1829)", () => {
  test("the fold restates the skeleton's scope instead of joining its 'do not implement'", () => {
    const { plan, merged } = foldSkeletonFeatures(hdrlens);
    expect(merged).toEqual([{ featureId: "base", from: ["scaffold", "base"] }]);
    expectOneOrder(plan.features.find((f) => f.id === "base"));
  });

  test("the person's merge edit does the same", () => {
    const plan = applySplitEdit(hdrlens, { op: "merge", featureIds: ["scaffold", "base"], id: "base", title: "base" });
    expectOneOrder(plan.features.find((f) => f.id === "base"));
  });

  test("the small-sibling merge does the same", () => {
    const stubs = STUBS.slice(0, 2);
    const plan: InitiativePlan = {
      ...hdrlens,
      features: [
        feature("stubs", stubs.map((s) => s.path), [], { skeleton: stubs, boundary: { scope: "Create both stubs; do not implement them.", paths: stubs.map((s) => s.path) } }),
        feature("text", [stubs[0]?.path ?? "", "internal/hdr/text_test.go"], [], { boundary: { scope: "Implement text.", paths: [stubs[0]?.path ?? "", "internal/hdr/text_test.go"] } }),
        ...hdrlens.features.slice(2),
      ],
    };
    const { plan: after, merged } = mergeSmallSiblings(plan);
    expect(merged).toEqual([{ featureId: "stubs", from: ["stubs", "text"] }]);
    const scope = after.features.find((f) => f.id === "stubs")?.boundary.scope ?? "";
    expect(scope).not.toContain("do not implement");
    expect(scope).toContain("This feature implements internal/hdr/text.go.");
    expect(scope).toContain("Implement text.");
  });

  test("two skeleton-only features merged keep their own words: no part fills a stub", () => {
    const other = { ...scaffold, id: "scaffold2", skeleton: [{ path: "internal/x/x.go", content: "package x\n" }], boundary: { scope: "Create x; do not implement it.", paths: ["internal/x/x.go"] } };
    const plan = applySplitEdit({ ...hdrlens, features: [...hdrlens.features, other] }, { op: "merge", featureIds: ["scaffold", "scaffold2"] });
    expect(plan.features.find((f) => f.id === "scaffold")?.boundary.scope).toBe(`${SCAFFOLD_SCOPE}\nCreate x; do not implement it.`);
  });

  test("the folded feature's run is told which stubs later features fill, not that all are replaced later", () => {
    const { plan } = foldSkeletonFeatures(hdrlens);
    const folded = plan.features.find((f) => f.id === "base");
    if (!folded) throw new Error("base missing");
    const row = { id: "hdrlens", prompt: "Build hdrlens." } as InitiativeRow;
    const prompt = featurePrompt(row, plan, folded, []);
    expect(prompt).not.toContain("later features replace the stubs");
    expect(prompt).toContain("Later features fill these stubs, so this run leaves them as written: internal/hdr/message.go (message),");
    for (const stub of BASE_STUBS) expect(prompt).not.toContain(`${stub} (`);
  });

  test("the critical-path rule counts no work for a feature the host writes whole", () => {
    expect(featureWork(scaffold, [])).toBe(0);
    // Before #1829 scaffold's 10 stub paths were 5 units of work, the largest share of the path.
    expect(criticalPathFeatures(hdrlens, "Build hdrlens.").map((f) => f.feature.id)).not.toContain("scaffold");
  });
});
