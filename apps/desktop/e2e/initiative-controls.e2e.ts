import { expect, test } from "./fixtures.ts";

test("an initiative is paused, its split becomes editable, and Resume drives it again", async ({
  app,
}) => {
  const page = await app("#/p/baked/initiatives/desktop-app");
  const initiative = page.getByRole("region", { name: "Desktop app initiative" });
  await initiative.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(initiative).toContainText("paused");
  await expect(initiative).toContainText("The initiative is paused, so its split can be edited");
  await expect(initiative.getByRole("button", { name: "Merge selected" })).toBeDisabled();

  await initiative.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(initiative.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(initiative).not.toContainText("The initiative is paused");
});

test("the initiative's progress bar counts its done features", async ({ app }) => {
  const page = await app("#/p/baked/initiatives/desktop-app");
  const initiative = page.getByRole("region", { name: "Desktop app initiative" });
  await expect(initiative.getByRole("img", { name: "2 of 6 features done" })).toBeVisible();
  await expect(initiative).toContainText("1 needs decision");
});
