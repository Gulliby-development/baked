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

  // Duplicating opens the copy in Edit; a click on a station sets it up beside the graph.
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: /^Station checks/ }).click();
  const gates = page
    .getByRole("region", { name: "Station checks" })
    .getByRole("group", { name: "Gates of stage checks" });
  await gates.getByRole("button", { name: "typecheck is required; switch" }).click();
  await expect(gates.getByRole("button", { name: "typecheck is advisory; switch" })).toBeVisible();

  await page.getByRole("button", { name: "Save…" }).click();
  const dialog = page.getByRole("dialog", { name: "Write the workflow file?" });
  await expect(dialog.getByTestId("workflow-diff")).toContainText('"id": "quick-custom"');
  await dialog.getByRole("button", { name: "Write file" }).click();

  await expect(page).toHaveURL(/#\/p\/baked\/workflows\/quick-custom$/);
  await expect(page.getByText("baked/workflows/quick-custom.json")).toBeVisible();
  await expect(page.getByText("unsaved changes")).toHaveCount(0);
});

test("a gate is removed from an arrow of the copy", async ({ app }) => {
  const page = await app("#/p/baked/workflows/quick");
  await page.getByRole("button", { name: "Duplicate as custom" }).click();
  await page.getByRole("button", { name: /^Station implement/ }).click();
  await page.getByRole("button", { name: "Arrow: if implement passes, go to checks" }).click();
  const arrow = page.getByRole("region", { name: "Transition implement-checks" });
  await expect(arrow.getByText("task-tests", { exact: true })).toBeVisible();
  await arrow.getByRole("button", { name: "Remove task-tests" }).click();
  await expect(arrow.getByText("task-tests", { exact: true })).toHaveCount(0);
});

test("an arrow is drawn by clicking two stations and a loop takes any number of rounds", async ({
  app,
}) => {
  const page = await app("#/p/baked/workflows/quick");
  await page.getByRole("button", { name: "Duplicate as custom" }).click();
  await page.getByRole("button", { name: /^Station checks/ }).click();
  const station = page.getByRole("region", { name: "Station checks" });

  // Rounds are typed or stepped past the recommended five, with a note why fewer is better.
  const rounds = station.getByRole("textbox", { name: "Rounds of checks-implement" });
  await rounds.fill("8");
  await rounds.press("Enter");
  await expect(rounds).toHaveValue("8");
  await expect(station.getByText(/^More than 5:/)).toBeVisible();

  await station.getByRole("button", { name: "Remove the arrow checks-implement" }).click();
  await expect(
    station.getByRole("button", { name: "Arrow: if checks fails, go to implement" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Draw an arrow", exact: true }).click();
  await page.getByRole("button", { name: /^Station checks/ }).click();
  await page.getByRole("button", { name: /^Station plan/ }).click();
  const dialog = page.getByRole("dialog", { name: "New arrow" });
  await expect(dialog.getByRole("button", { name: "fails" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "passes" })).toBeDisabled();
  await dialog.getByRole("button", { name: "More rounds for the new loop" }).click();
  await dialog.getByRole("button", { name: "Add arrow" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: /^Station checks/ }).click();
  await expect(
    station.getByRole("button", { name: "Arrow: if checks fails, go to plan" }),
  ).toContainText("up to 4×");
});

test("watching a run opens the station it shows in Edit", async ({ app }) => {
  const page = await app("#/p/baked/workflows/quick");
  await expect(page.getByText(/^Watch only/)).toBeVisible();
  const pause = page.getByRole("button", { name: "Pause" });
  if (await pause.isVisible()) await pause.click();
  await page.getByRole("region", { name: "Now" }).getByRole("button", { name: /^Set up / }).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("region", { name: /^Station / })).toBeVisible();
  await page.getByRole("button", { name: "Next station" }).click();
  await expect(page.getByText(/^Station 2 of 5$/)).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: /^Station plan/ })).toBeVisible();
  await page.getByRole("button", { name: "Watch", exact: true }).click();
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
