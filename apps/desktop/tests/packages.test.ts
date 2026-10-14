import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { offers, PACKAGES_CAPABILITY } = await import("../src/renderer/client/capabilities.ts");
const { MOCK_PACKAGE_PATH } = await import("../src/renderer/client/mock-packages.ts");
const { installAction, packages, packSummary } = await import("../src/renderer/client/packages.ts");
const { installSummary, PackageActions, removeSummary } = await import("../src/renderer/screens/setup/PackagesSection.tsx");
const { PackageBox } = await import("../src/renderer/screens/setup/PackageBox.tsx");
const { boxItems, contentsLine, packingMs, BOX_SLOTS, DROP_MS } = await import("../src/renderer/screens/setup/packages-model.ts");
const { parseRoute, projectHref } = await import("../src/renderer/router.ts");
delete scope.window;

describe("packages client", () => {
  test("plans, installs only the approved plan, lists and removes", async () => {
    expect((await packages.list("site")).packages).toEqual([]);
    const plan = await packages.inspect("site", MOCK_PACKAGE_PATH);
    expect(plan.name).toBe("acme-review");
    expect(plan.overwrites).toBe(1);
    expect(installAction(plan)).toEqual({ allowed: true, label: "Install and replace 1 file" });

    const stale = await packages.install("site", { ...plan, planHash: "f".repeat(64) }, true).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ApiError);
    const conflict = await packages.install("site", plan, false).catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ApiError);

    const result = await packages.install("site", plan, true);
    expect(result.written).toHaveLength(plan.files.length);
    expect(installSummary(result)).toBe("Installed acme-review 1.2.0: 4 files written.");
    expect((await packages.list("site")).packages.map((p) => p.name)).toEqual(["acme-review"]);

    const again = await packages.inspect("site", MOCK_PACKAGE_PATH);
    expect(again.installed).toBe("1.2.0");
    expect(installAction(again)).toEqual({ allowed: true, label: "Update to 1.2.0" });

    const removed = await packages.remove("site", "acme-review");
    expect(removed.removed).toHaveLength(4);
    expect((await packages.list("site")).packages).toEqual([]);
    expect(await packages.inspect("site", "/nowhere").catch((e: unknown) => e)).toBeInstanceOf(ApiError);
  });

  test("install and remove summaries count one file as a file", () => {
    const installed = { name: "x", version: "1.0.0", written: ["a"], unchanged: [], removed: ["b"], kept: ["c"], gatesToConfirm: [] };
    expect(installSummary(installed)).toBe(
      "Installed x 1.0.0: 1 file written, 1 file of the old version removed, 1 edited file of the old version kept.",
    );
    expect(removeSummary({ name: "x", version: "1.0.0", removed: ["a"], kept: [], missing: [] })).toBe("Removed x 1.0.0: 1 file deleted.");
    expect(removeSummary({ name: "x", version: "1.0.0", removed: ["a", "b"], kept: ["baked/c.md"], missing: [] })).toBe(
      "Removed x 1.0.0: 2 files deleted; kept 1 edited: baked/c.md.",
    );
  });

  test("a plan with problems cannot be installed", () => {
    const plan = {
      source: "/p", workspace: "/w", name: "x", version: "1.0.0", description: null, installed: null,
      files: [], stale: [], contents: { agents: [], skills: [], workflows: [], gates: [] },
      gatesToConfirm: [], problems: ["workflows/x.json: unknown gate lint"], overwrites: 0, planHash: "0".repeat(64),
    };
    expect(installAction(plan)).toEqual({ allowed: false, label: "Cannot be installed" });
  });

  test("the section has its route and capability", () => {
    expect(parseRoute(projectHref("baked", "packages"))).toEqual({ name: "project", key: "baked", section: "packages", id: null });
    expect(offers(["workflow"], PACKAGES_CAPABILITY)).toBe(false);
    expect(offers(["workflow", "packages"], PACKAGES_CAPABILITY)).toBe(true);
  });

  test("checks and writes a package's manifest", async () => {
    const checked = await packages.pack("site", { path: MOCK_PACKAGE_PATH }, true);
    expect([checked.written, checked.upToDate, checked.files.length]).toEqual([false, true, 4]);
    expect(packSummary(checked, true)).toBe("acme-review 1.2.0: baked-package.json is up to date (4 files).");

    const stale = await packages.pack("site", { path: MOCK_PACKAGE_PATH, version: "1.3.0" }, true);
    expect(stale.upToDate).toBe(false);
    expect(packSummary(stale, true)).toBe("acme-review 1.3.0: baked-package.json is out of date; Write updates it (4 files).");

    const written = await packages.pack("site", { path: MOCK_PACKAGE_PATH, version: "1.3.0", name: "" }, false);
    expect(written.written).toBe(true);
    expect(written.manifest?.version).toBe("1.3.0");
    expect(packSummary(written, false)).toBe("Wrote baked-package.json for acme-review 1.3.0 (4 files).");
    expect((await packages.pack("site", { path: MOCK_PACKAGE_PATH }, true)).upToDate).toBe(true);

    expect(await packages.pack("site", { path: "/nowhere" }, true).catch((e: unknown) => e)).toBeInstanceOf(ApiError);
    expect(await packages.pack("site", { path: MOCK_PACKAGE_PATH, version: "next" }, false).catch((e: unknown) => e)).toBeInstanceOf(ApiError);
  });

  test("a refused manifest names its problems", () => {
    const refused = {
      root: "/p", manifestPath: "/p/baked-package.json", name: "x", version: "1.0.0", description: null,
      files: [], contents: { agents: [], skills: [], workflows: [], gates: [] },
      problems: ["docs/readme.md: not under agents/, skills/, workflows/ or gates/"], manifest: null,
      existing: false, upToDate: false, written: false,
    };
    expect(packSummary(refused, false)).toBe("baked-package.json not written for x 1.0.0: 1 problem.");
  });

  test("the screen offers Install package and Create package", () => {
    const html = renderToStaticMarkup(createElement(PackageActions, { onInstall: () => {}, onCreate: () => {} }));
    for (const label of ["Install package", "Create package"]) expect(html).toContain(`>${label}<`);
  });

  test("a package's contents become box tiles, in kind order", async () => {
    const plan = await packages.inspect("site", MOCK_PACKAGE_PATH);
    expect(boxItems(plan.contents).map((i) => i.key)).toEqual([
      "agents/acme-reviewer",
      "skills/review-notes",
      "workflows/acme-quick",
      "gates/lint",
    ]);
    expect(contentsLine(plan.contents)).toBe("1 agent profile · 1 skill · 1 workflow · 1 gate");
    expect(contentsLine({ agents: [], skills: ["a", "b"], workflows: [], gates: [] })).toBe("2 skills");
  });

  test("the box shows at most its slots and counts the rest", () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ key: `skills/s${i}`, kind: "skills" as const, name: `s${i}` }));
    const open = renderToStaticMarkup(createElement(PackageBox, { items, phase: "open" }));
    expect(open.match(/data-tile=/g)).toHaveLength(BOX_SLOTS);
    expect(open).toContain("+4 more");
    const closed = renderToStaticMarkup(createElement(PackageBox, { items, phase: "closed", label: "acme 1.0.0" }));
    expect(closed).not.toContain("data-tile=");
    expect(closed).toContain("Packed: acme 1.0.0");
  });

  test("the packing animation waits for its tiles, and not at all under reduced motion", () => {
    expect(packingMs(1, false)).toBeGreaterThanOrEqual(DROP_MS);
    expect(packingMs(20, false)).toBe(packingMs(BOX_SLOTS, false));
    expect(packingMs(4, true)).toBe(0);
    expect(packingMs(0, false)).toBe(0);
  });
});
