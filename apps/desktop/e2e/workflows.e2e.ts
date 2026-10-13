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
  await page.getByRole("button", { name: "Stages", exact: true }).click();
  const transition = page.getByRole("group", { name: "implement-checks" });
  await expect(transition.getByText("task-tests", { exact: true })).toBeVisible();
  await transition.getByRole("button", { name: "Remove task-tests" }).click();
  await expect(transition.getByText("task-tests", { exact: true })).toHaveCount(0);
});

test("the gallery plays a run and opens a workflow in the graph", async ({ app }) => {
  const page = await app("#/p/baked/workflows");
  const banner = page.getByRole("region", { name: "How a run flows" });
  await expect(banner.locator("[data-station]").first()).toBeVisible();
  await page.getByRole("searchbox", { name: "Find a workflow" }).fill("fix");
  await expect(page.getByRole("article", { name: "Workflow quick-fix" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Workflow sdd" })).toHaveCount(0);
  await page.getByRole("link", { name: "Open quick-fix in the graph" }).click();

  await expect(page).toHaveURL(/#\/p\/baked\/workflows\/quick-fix$/);
  await expect(page.getByRole("button", { name: "Graph", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: /^Station plan/ })).toBeVisible();
  await page.getByRole("button", { name: "Flow", exact: true }).click();
  // The walkthrough plays on its own unless the system asks for reduced motion.
  const pause = page.getByRole("button", { name: "Pause" });
  if (await pause.isVisible()) await pause.click();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  const progress = page.getByRole("progressbar", { name: "Walkthrough progress" });
  const before = Number(await progress.getAttribute("aria-valuenow"));
  await page.getByRole("button", { name: "Step forward" }).click();
  await expect(progress).toHaveAttribute("aria-valuenow", String(before + 1));
  await expect(page.getByRole("region", { name: "Now" })).toBeVisible();
});

test("the playing walkthrough does not scroll the page back to it", async ({ app, page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await app("#/p/baked/workflows");
  await page.setViewportSize({ width: 1400, height: 500 });
  const banner = page.getByRole("region", { name: "How a run flows" });
  await expect(banner.locator("[data-station]").first()).toBeVisible();
  // Scroll down to the gallery, past the playing conveyor, and let it move on a few stations.
  const main = page.locator("main");
  const top = await main.evaluate((box) => {
    box.scrollTop = box.scrollHeight;
    return box.scrollTop;
  });
  expect(top).toBeGreaterThan(0);
  const told = banner.locator("[aria-live]");
  for (let i = 0; i < 2; i++) {
    const text = await told.textContent();
    await expect(told).not.toHaveText(text ?? "", { timeout: 5000 });
  }
  expect(await main.evaluate((box) => box.scrollTop)).toBe(top);
});
