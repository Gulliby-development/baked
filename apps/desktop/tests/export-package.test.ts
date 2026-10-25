import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { sddExport } = await import("../src/renderer/client/sdd-export.ts");
const { defaultPackageOut, packageOutProblem, packageSummary } = await import(
  "../src/renderer/components/ExportPackageDialog.tsx"
);
delete scope.window;

describe("Export package dialog (#2207)", () => {
  test("the destination follows the format and stays inside the project", () => {
    expect(defaultPackageOut("shop", false)).toBe(".baked/exports/shop-export");
    expect(defaultPackageOut("shop", true)).toBe(".baked/exports/shop-export.zip");
    expect(packageOutProblem(".baked/exports/shop-export")).toBeNull();
    expect(packageOutProblem("handoff\\shop")).toBeNull();
    expect(packageOutProblem(" ")).toContain("Name a path");
    expect(packageOutProblem("/tmp/shop")).toContain("relative");
    expect(packageOutProblem("C:\\Users\\shop")).toContain("relative");
    expect(packageOutProblem("../shop")).toContain("inside the project");
  });

  test("an approved run is written as a folder or a zip; an unapproved one is refused", async () => {
    const folder = await sddExport.write("baked", "run", "run-settings-dark-mode", { zip: false });
    expect(folder.path).toContain(".baked\\exports\\run-settings-dark-mode-export");
    expect(folder.files).toContain("specs/settings-dark-mode/spec.md");
    expect(packageSummary(folder)).toBe("Folder with 9 files, 1 of 1 feature accepted");
    const zip = await sddExport.write("baked", "run", "run-settings-dark-mode", {
      zip: true,
      out: "handoff/dark.zip",
    });
    expect(zip.path).toContain("handoff\\dark.zip");
    expect(packageSummary(zip)).toStartWith("Archive with");
    const refused = sddExport.write("baked", "run", "run-usage-totals", { zip: false });
    await expect(refused).rejects.toBeInstanceOf(ApiError);
    await expect(refused).rejects.toMatchObject({ status: 409 });
  });

  test("an initiative is exported once its split is approved", async () => {
    const written = await sddExport.write("baked", "initiative", "desktop-app", { zip: true });
    expect(written.manifest.kind).toBe("initiative");
    expect(written.files).toContain("initiative.md");
    await expect(
      sddExport.write("baked", "initiative", "headless-automation", { zip: false }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
