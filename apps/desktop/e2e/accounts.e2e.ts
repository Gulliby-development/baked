import { expect, test } from "./fixtures.ts";

// Several accounts of one provider (#2303) in the sample backend: Claude Code has "Personal",
// allowed for the baked project, and "Client seat", allowed only for another project.

test("a run starts on a chosen account from Oven settings", async ({ app }) => {
  const page = await app("#/p/baked/runs/new");
  const form = page.getByRole("form", { name: "New workflow run" });
  await form.getByRole("textbox", { name: "What should change?" }).fill("Add a --json flag to baked usage");
  await form.locator("summary", { hasText: "Oven settings" }).click();

  const account = form.getByRole("combobox", { name: "Claude Code account" });
  await expect(account).toBeVisible();
  // Only the accounts this project may use are offered; a provider without one has no field.
  await expect(account.getByRole("option")).toHaveText(["Project's: the CLI's own sign-in", "Personal"]);
  await expect(form.getByRole("combobox", { name: "Codex account" })).toHaveCount(0);
  await expect(form.getByText("Every Claude Code turn of this run, and of its resumes, uses this account.")).toBeVisible();

  await account.selectOption({ label: "Personal" });
  await expect(form.getByText(/Claude Code: Personal/)).toBeVisible();
  await account.selectOption({ index: 0 });
  await expect(form.getByText(/Claude Code: Personal/)).toHaveCount(0);
  await account.selectOption({ label: "Personal" });

  await form.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/#\/p\/baked\/runs\/run-add-a-json-flag/);
});

test("each account's own limits are shown next to its provider's", async ({ app }) => {
  const page = await app("#/settings/providers");
  const panel = page.getByRole("region", { name: "Subscription limits" });
  const cards = panel.getByRole("article");
  await expect(cards).toHaveCount(5);
  await expect(cards.nth(1)).toHaveAccessibleName("Claude Code");
  await expect(cards.nth(2)).toHaveAccessibleName("Claude Code · Personal");
  await expect(cards.nth(2)).toContainText("5-hour session");
  await expect(cards.nth(3)).toHaveAccessibleName("Claude Code · Client seat");
  await expect(cards.nth(3)).toContainText("has not signed in yet");
});
