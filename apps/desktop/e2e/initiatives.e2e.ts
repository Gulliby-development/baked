import { expect, test } from "./fixtures.js";

test("the initiative board shows each feature's step and workflow", async ({ app }) => {
  const page = await app("#/p/baked/initiatives/desktop-app");
  const board = page.getByRole("region", { name: "Features" });
  await expect(board.getByRole("heading", { name: "Step 1 · starts first" })).toBeVisible();
  await expect(board.getByRole("heading", { name: "Step 4 · after step 3" })).toBeVisible();
  const usage = board.getByRole("listitem", { name: "Usage reports" });
  await expect(usage.getByText("quick", { exact: true })).toBeVisible();
});

test("a split waiting for approval sets each feature's workflow and size", async ({ app }) => {
  const page = await app("#/p/baked/initiatives/headless-automation");
  const card = page.getByRole("listitem", { name: "JSON output for every command" });
  await card.getByRole("button", { name: "large" }).click();
  await expect(card.getByRole("button", { name: "large" })).toHaveAttribute("aria-pressed", "true");
  await card.getByRole("button", { name: "Workflow: JSON output for every command" }).click();
  await expect(page.getByRole("dialog", { name: "Feature workflow" })).toContainText(
    "Other features build on its spec",
  );
});

test("a new initiative starts in the coordinator with the idea", async ({ app }) => {
  const page = await app("#/p/site/initiatives");
  await page.getByRole("textbox", { name: "What is the big idea?" }).fill("Ship offline mode");
  await page.getByRole("button", { name: "Plan it with the coordinator" }).click();
  await expect(page.getByRole("textbox", { name: "Message BAKED" })).toHaveValue(
    "Plan this as an initiative: Ship offline mode",
  );
});
