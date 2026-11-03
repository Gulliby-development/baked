import { expect, test } from "./fixtures.ts";

test("a project is renamed in the app's dialog, and an empty name is refused or restores it", async ({
  app,
}) => {
  const page = await app("#/projects");
  const main = page.getByRole("main");
  await main.getByRole("button", { name: "Rename BAKED", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rename project" });
  await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("BAKED");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  await main.getByRole("button", { name: "Rename BAKED", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Name" }).fill("BAKED core");
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(main.getByRole("article", { name: "BAKED core" })).toBeVisible();
  // The sidebar follows the new name.
  await expect(page.getByRole("navigation", { name: "Main" })).toContainText("BAKED core");
});

test("a project is pinned and unpinned from its card", async ({ app }) => {
  const page = await app("#/projects");
  const main = page.getByRole("main");
  const pin = main.getByRole("button", { name: "Pin site", exact: true });
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await pin.click();
  const unpin = main.getByRole("button", { name: "Unpin site", exact: true });
  await expect(unpin).toHaveAttribute("aria-pressed", "true");
  await expect(unpin).toContainText("Pinned");
  await unpin.click();
  await expect(main.getByRole("button", { name: "Pin site", exact: true })).toBeVisible();
});

test("a project is closed from its card, and Open starts it and shows its coordinator", async ({
  app,
}) => {
  const page = await app("#/projects");
  const card = page.getByRole("main").getByRole("article", { name: "baked-docs" });
  await expect(card).toContainText("open");
  await card.getByRole("button", { name: "Close" }).click();
  await expect(card).toContainText("closed");
  await expect(card.getByRole("button", { name: "Open" })).toBeVisible();
  await card.getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(/#\/p\/docs\/coordinator$/);
  await expect(page.getByRole("heading", { level: 1, name: "Coordinator" })).toBeVisible();
});

test("the project search narrows the cards", async ({ app }) => {
  const page = await app("#/projects");
  const main = page.getByRole("main");
  await expect(main.getByRole("article")).toHaveCount(4);
  await main.getByRole("searchbox", { name: "Find a project" }).fill("docs");
  await expect(main.getByRole("article")).toHaveCount(1);
  await expect(main.getByRole("article", { name: "baked-docs" })).toBeVisible();
  await main.getByRole("searchbox", { name: "Find a project" }).fill("");
  await expect(main.getByRole("article")).toHaveCount(4);
});

test("Create project opens the BAKED dialog", async ({ app }) => {
  const page = await app("#/projects");
  await page.getByRole("main").getByRole("button", { name: "Create project", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});
