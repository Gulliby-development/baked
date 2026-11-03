import { expect, test } from "./fixtures.ts";

test("Diagnostics shows storage, model events, the error log and the sandbox", async ({ app }) => {
  const page = await app("#/p/baked/diagnostics");
  const nav = page.getByRole("navigation", { name: "Diagnostics sections" });
  await expect(nav.getByRole("button", { name: /^Storage/ })).toContainText("63.0 MB");
  await expect(nav.getByRole("button", { name: /^Model events/ })).toContainText("3 calls");
  await expect(nav.getByRole("button", { name: /^Error log/ })).toContainText("2");
  await expect(nav.getByRole("button", { name: /^Sandbox/ })).toContainText("off");

  const storage = page.getByRole("region", { name: "Storage" });
  await expect(storage.getByRole("img", { name: /^This project: Code map 88%/ })).toBeVisible();

  const events = page.getByRole("region", { name: "Model events" });
  const totals = events.getByRole("table", { name: "Model totals" });
  await expect(totals.getByRole("row", { name: /^claude-sonnet-4-5/ })).toContainText("2");

  await nav.getByRole("button", { name: /^Sandbox/ }).click();
  await expect(page.getByRole("region", { name: "Sandbox" })).toBeInViewport();
  await nav.getByRole("button", { name: /^Error log/ }).click();
  await expect(page.getByRole("region", { name: "Error log" })).toBeInViewport();
});

test("clearing a kind of storage asks in the app's dialog first; Keep leaves it", async ({
  app,
}) => {
  const page = await app("#/p/baked/diagnostics");
  const storage = page.getByRole("region", { name: "Storage" });
  const plans = storage.getByRole("listitem").filter({ hasText: "Plans" });
  await expect(plans).toContainText("40.0 KB");

  await storage.getByRole("button", { name: "Clear plans" }).click();
  const dialog = page.getByRole("dialog", { name: "Clear plans?" });
  await expect(dialog).toContainText("This cannot be undone.");
  await dialog.getByRole("button", { name: "Keep" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(plans).toContainText("40.0 KB");

  await storage.getByRole("button", { name: "Clear plans" }).click();
  await dialog.getByRole("button", { name: "Clear" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(plans).not.toContainText("40.0 KB");
});

test("model event recording is switched off and on", async ({ app }) => {
  const page = await app("#/p/baked/diagnostics");
  const events = page.getByRole("region", { name: "Model events" });
  const recording = events.getByRole("switch", { name: "Record model events" });
  await expect(recording).toBeChecked();
  await recording.click();
  await expect(recording).not.toBeChecked();
  await recording.click();
  await expect(recording).toBeChecked();
});
