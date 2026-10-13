import { expect, test } from "./fixtures.ts";

const FOLDER = "/home/you/packages/acme-review";

test("Install package walks from a folder to the plan to the packed box", async ({ app }) => {
  const page = await app("#/p/baked/packages");
  await expect(page.getByText("No packages installed in this project yet.")).toBeVisible();
  await page.getByRole("button", { name: /Install package/ }).click();

  const dialog = page.getByRole("dialog", { name: "Install a package" });
  await dialog.getByLabel("Package folder").fill(FOLDER);
  await dialog.getByRole("button", { name: "Show plan" }).click();
  await expect(dialog.getByRole("img", { name: "Box with 4 items to pack" })).toBeVisible();
  await expect(dialog).toContainText("1 agent profile · 1 skill · 1 workflow · 1 gate");
  await dialog.getByText("4 files into").click();
  await expect(dialog.getByRole("list", { name: "Files" })).toContainText("baked/gates/lint.json");

  await dialog.getByRole("button", { name: "Install and replace 1 file" }).click();
  await expect(dialog.getByRole("img", { name: "Packed: acme-review 1.2.0" })).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("Installed acme-review 1.2.0: 4 files written.");
  await dialog.getByRole("button", { name: "Done" }).click();

  const installed = page.getByRole("region", { name: "Installed packages" });
  await expect(installed).toContainText("acme-review");
  await installed.getByRole("button", { name: "Remove acme-review" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Removed acme-review 1.2.0");
});

test("Create package checks the folder, then writes its manifest", async ({ app }) => {
  const page = await app("#/p/baked/packages");
  await page.getByRole("button", { name: /Create package/ }).click();
  const dialog = page.getByRole("dialog", { name: "Create a package" });
  await dialog.getByLabel("Package folder").fill(FOLDER);
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("acme-review");
  await expect(dialog).toContainText("baked-package.json is up to date");

  await dialog.getByRole("textbox", { name: "Version" }).fill("1.3.0");
  await dialog.getByRole("button", { name: "Pack it" }).click();
  await expect(dialog.getByRole("img", { name: "Packed: acme-review 1.3.0" })).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText(
    "Wrote baked-package.json for acme-review 1.3.0 (4 files).",
  );
});
