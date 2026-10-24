import { expect, test } from "bun:test";
import { pathsExistLater } from "../src/core/workflows/dependencies.js";
import type { RuntimeState } from "../src/core/workflows/types.js";

// Adversarial review of #1951 (#1965): docs depends only on middle, middle on base. docs is held on
// middle while base was accepted after docs' provisional base was fixed; the release brings in
// base's result with middle's, so docs' plan may name base's files.

const bounds = (dependsOn: boolean) => ({
  featureId: "docs",
  features: [
    { id: "base", scope: "base", paths: ["src/base.ts"], ...(dependsOn ? { dependsOn: [] } : {}) },
    { id: "middle", scope: "middle", paths: ["src/middle.ts"], ...(dependsOn ? { dependsOn: ["base"] } : {}) },
    { id: "docs", scope: "docs", paths: ["README.md"], ...(dependsOn ? { dependsOn: ["middle"] } : {}) },
    { id: "other", scope: "other", paths: ["src/other.ts"], ...(dependsOn ? { dependsOn: ["base"] } : {}) },
  ],
});

const held = (withDependsOn = true, released = false) =>
  ({
    planAhead: { released, baselined: false },
    initiativeBounds: bounds(withDependsOn),
    hostDependencies: [{ featureId: "init_middle", contractHash: "a".repeat(64) }],
  }) as unknown as RuntimeState;

test("a held run reads the files of its pinned feature's ancestors, not of other features", () => {
  const later = pathsExistLater(held());
  expect(["src/middle.ts", "src/base.ts", "src/other.ts", "README.md"].map(later)).toEqual([true, true, false, false]);
});

test("bounds saved before they carried dependsOn keep the pinned features alone", () => {
  const later = pathsExistLater(held(false));
  expect(["src/middle.ts", "src/base.ts"].map(later)).toEqual([true, false]);
});

test("a released run names nothing later", () => {
  expect(pathsExistLater(held(true, true))("src/base.ts")).toBe(false);
});
