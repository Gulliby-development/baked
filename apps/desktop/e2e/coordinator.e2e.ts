import { expect, test } from "./fixtures.ts";

test("a schedule is added, paused and removed in the coordinator", async ({ app }) => {
  const page = await app("#/p/site/coordinator");
  const panel = page.getByRole("region", { name: "Schedules" });
  await expect(panel.getByText(/None\. A schedule starts a coordinator turn/)).toBeVisible();

  await panel.getByRole("button", { name: "Add" }).click();
  const form = panel.getByRole("form", { name: "New schedule" });
  await form.getByLabel("Name").fill("Nightly CI");
  await form.getByRole("button", { name: "Nightly 02:00" }).click();
  await expect(form.getByLabel("When", { exact: true }).last()).toHaveValue("0 2 * * *");
  await form.getByLabel("What the coordinator does").fill("Check failing CI and summarize it");
  await form.getByRole("button", { name: "Add schedule" }).click();

  await expect(form).toHaveCount(0);
  await expect(panel.getByText("Nightly CI", { exact: true })).toBeVisible();
  await expect(panel.getByText("nightly 02:00")).toBeVisible();
  await expect(panel.getByText(/^next /)).toBeVisible();

  await panel.getByRole("switch", { name: "Pause Nightly CI" }).click();
  await expect(panel.getByText("paused")).toBeVisible();
  await panel.getByRole("switch", { name: "Resume Nightly CI" }).click();
  await expect(panel.getByText(/^next /)).toBeVisible();

  await panel.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(panel.getByText("Nightly CI", { exact: true })).toHaveCount(0);
});

test("a schedule that fires too often is refused in the form", async ({ app }) => {
  const page = await app("#/p/docs/coordinator");
  const panel = page.getByRole("region", { name: "Schedules" });
  await panel.getByRole("button", { name: "Add" }).click();
  const form = panel.getByRole("form", { name: "New schedule" });
  await form.getByLabel("Name").fill("Spam");
  await form.getByLabel("When", { exact: true }).last().fill("every 1m");
  await form.getByLabel("What the coordinator does").fill("ping");
  await form.getByRole("button", { name: "Add schedule" }).click();
  await expect(form.getByText(/more often than every 5 minutes/)).toBeVisible();
});

test("an older backend shows no schedules", async ({ app }) => {
  const page = await app("#/p/site/coordinator", "older");
  await expect(page.getByRole("region", { name: "Schedules" })).toHaveCount(0);
});
