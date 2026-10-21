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

const row = { id: "hdrlens", prompt: "Build hdrlens." } as InitiativeRow;
const promptOf = (plan: InitiativePlan, id: string) => {
  const target = plan.features.find((f) => f.id === id);
  if (!target) throw new Error(`${id} missing`);
  return featurePrompt(row, plan, target, []);
};

/**
 * The merged feature states each stub's fate once: no stub-wide "do not implement" in its scope,
 * and its run's request names the stubs it implements and the ones later features fill (#1847
 * moved the fates from the merged scope to the request, built from the plan the run starts on).
 */
function expectOneOrder(plan: InitiativePlan) {
  const merged = plan.features.find((f) => f.id === "base");
  expect(merged).toBeDefined();
  const scope = merged?.boundary.scope ?? "";
  expect(scope).not.toContain("do not implement");
  expect(scope).toContain(`The host writes the ${STUBS.length} stub files of the skeleton before any task`);
  expect(scope).toContain("Own shared text, options, IO and in-memory test support.");
  expect(merged?.contract).not.toContain("no behavior");
  expect(merged?.contract).toContain("base works");
  expect(merged?.skeleton).toEqual(STUBS);
  const prompt = promptOf(plan, "base");
  expect(prompt).toContain(`This feature implements ${BASE_STUBS.join(", ")}.`);
  expect(prompt).toContain("Later features write internal/hdr/message.go (message), ");
}

describe("a skeleton feature merged with a feature that fills its stubs (#1829)", () => {
  test("the fold restates the skeleton's scope instead of joining its 'do not implement'", () => {
    const { plan, merged } = foldSkeletonFeatures(hdrlens);
    expect(merged).toEqual([{ featureId: "base", from: ["scaffold", "base"] }]);
    expectOneOrder(plan);
  });

  test("the person's merge edit does the same", () => {
    expectOneOrder(applySplitEdit(hdrlens, { op: "merge", featureIds: ["scaffold", "base"], id: "base", title: "base" }));
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
    expect(scope).toContain("Implement text.");
    expect(promptOf(after, "stubs")).toContain("This feature implements internal/hdr/text.go.");
  });

  test("two skeleton-only features merged keep their own words: no part fills a stub", () => {
    const other = { ...scaffold, id: "scaffold2", skeleton: [{ path: "internal/x/x.go", content: "package x\n" }], boundary: { scope: "Create x; do not implement it.", paths: ["internal/x/x.go"] } };
    const plan = applySplitEdit({ ...hdrlens, features: [...hdrlens.features, other] }, { op: "merge", featureIds: ["scaffold", "scaffold2"] });
    expect(plan.features.find((f) => f.id === "scaffold")?.boundary.scope).toBe(`${SCAFFOLD_SCOPE}\nCreate x; do not implement it.`);
    // A feature that is only skeleton implements nothing, whoever else lists its stubs.
    expect(promptOf(plan, "scaffold")).not.toContain("This feature implements");
  });

  test("a second merge moves the stub to the merged feature: the fates follow the plan, not an earlier scope", () => {
    // Adversarial review of #1839: fold scaffold into base, then merge base and message. The
    // scope listed "the other stubs stay as written", message.go among them.
    const folded = foldSkeletonFeatures(hdrlens).plan;
    const plan = applySplitEdit(folded, { op: "merge", featureIds: ["base", "message"], id: "base", title: "base" });
    const prompt = promptOf(plan, "base");
    expect(plan.features.find((f) => f.id === "base")?.boundary.scope).not.toContain("stay as written");
    expect(prompt).toContain(`This feature implements ${[...BASE_STUBS, "internal/hdr/message.go"].join(", ")}.`);
    expect(prompt).not.toContain("internal/hdr/message.go (message)");
  });

  test("a stub another feature's glob covers is filled by that feature", () => {
    const plan: InitiativePlan = {
      ...hdrlens,
      features: hdrlens.features.map((f) => (f.id === "front" ? { ...f, boundary: { ...f.boundary, paths: ["internal/hdr/cmd*.go", "internal/hdr/summary.go"] } } : f)),
    };
    const prompt = promptOf(foldSkeletonFeatures(plan).plan, "base");
    expect(prompt).toContain("internal/hdr/cmd.go (front)");
    expect(prompt).not.toContain("implements internal/hdr/text.go, internal/hdr/options.go, internal/hdr/io.go, internal/hdr/cmd.go");
  });

  test("a stub a later feature also lists stays this feature's to write where its own boundary needs it", () => {
    const plan: InitiativePlan = {
      ...hdrlens,
      features: hdrlens.features.map((f) => (f.id === "message" ? { ...f, boundary: { ...f.boundary, paths: [...f.boundary.paths, "internal/hdr/text.go"] } } : f)),
    };
    const prompt = promptOf(foldSkeletonFeatures(plan).plan, "base");
    expect(prompt).toContain("internal/hdr/text.go (message)");
    expect(prompt).toContain("leave those stubs as written, except the ones this feature implements");
  });

  test("the critical-path rule counts no work for a feature the host writes whole", () => {
    expect(featureWork(scaffold, [])).toBe(0);
    // Before #1829 scaffold's 10 stub paths were 5 units of work, the largest share of the path.
    expect(criticalPathFeatures(hdrlens, "Build hdrlens.").map((f) => f.feature.id)).not.toContain("scaffold");
  });
});
