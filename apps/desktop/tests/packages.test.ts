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
const { installSummary, ManifestWriter } = await import("../src/renderer/screens/setup/PackagesSection.tsx");
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

  test("the Write manifest form has its fields and both buttons", () => {
    const html = renderToStaticMarkup(createElement(ManifestWriter, { projectKey: "site" }));
    expect(html).toContain('aria-label="Write manifest"');
    expect(html).toContain('aria-label="Package folder to write"');
    for (const label of ["Name", "Version", "Description (optional)", "Check", "Write"]) expect(html).toContain(`>${label}<`);
  });
});
