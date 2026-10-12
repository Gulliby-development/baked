import { expect, test } from "./fixtures.ts";

test("a built-in workflow is duplicated, edited and saved as a project workflow", async ({
  app,
}) => {
  const page = await app("#/p/baked/workflows");
  await expect(page.getByRole("heading", { name: "Workflows", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "quick", exact: true }).click();

  await expect(page).toHaveURL(/#\/p\/baked\/workflows\/quick$/);
  await expect(page.getByText("read only", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Duplicate as custom" }).click();
  await expect(page.getByRole("heading", { name: "quick-custom", level: 2 })).toBeVisible();
  await expect(page.getByText("unsaved copy of quick")).toBeVisible();

  const checks = page.getByRole("listitem", { name: "Stage checks" });
  await checks
    .getByRole("group", { name: "stage checks" })
    .getByRole("button", { name: "Make advisory" })
    .first()
    .click();
  await expect(
    checks.getByRole("group", { name: "stage checks" }).getByRole("button", {
      name: "Make required",
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Save…" }).click();
  const dialog = page.getByRole("dialog", { name: "Write the workflow file?" });
  await expect(dialog.getByTestId("workflow-diff")).toContainText('"id": "quick-custom"');
  await dialog.getByRole("button", { name: "Write file" }).click();

  await expect(page).toHaveURL(/#\/p\/baked\/workflows\/quick-custom$/);
  await expect(page.getByText("baked/workflows/quick-custom.json")).toBeVisible();
  await expect(page.getByText("unsaved changes")).toHaveCount(0);
});

test("a gate is removed from a transition of the copy", async ({ app }) => {
  const page = await app("#/p/baked/workflows/quick");
  await page.getByRole("button", { name: "Duplicate as custom" }).click();
  const transition = page.getByRole("group", { name: "implement-checks" });
  await expect(transition.getByText("task-tests", { exact: true })).toBeVisible();
  await transition.getByRole("button", { name: "Remove task-tests" }).click();
  await expect(transition.getByText("task-tests", { exact: true })).toHaveCount(0);
});
