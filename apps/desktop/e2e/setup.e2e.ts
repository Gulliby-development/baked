import { expect, test } from "./fixtures.ts";

test("a folder without baked/project.json explains how to set it up", async ({ app }) => {
  const page = await app("#/p/client/overview", "uninitialized");
  await expect(page.getByRole("heading", { name: "client-api", level: 1 })).toBeVisible();
  const setup = page.getByRole("complementary", { name: "Project setup" });
  await expect(setup).toContainText("This folder has no baked/project.json");
  await expect(setup).toContainText("Run baked project init in the folder");
  await expect(page.getByText("No workflow runs yet.")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Working set" })
    .click();
  await expect(page.getByRole("heading", { name: "Working set", level: 1 })).toBeVisible();
  await expect(page.getByText(/This folder has no baked\/project\.json yet/)).toBeVisible();
});
