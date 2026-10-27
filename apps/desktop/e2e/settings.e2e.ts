import { expect, test } from "./fixtures.ts";

test("the theme setting applies at once and survives navigation", async ({ app }) => {
  const page = await app("#/settings/app");
  const theme = page.getByRole("group", { name: "Theme" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await theme.getByRole("button", { name: "light" }).click();
  await expect(theme.getByRole("button", { name: "light" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "All projects" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("a behavior checkbox keeps its new value", async ({ app }) => {
  const page = await app("#/settings/app");
  const advisory = page.getByRole("checkbox", { name: "Also notify for advisory items" });
  await expect(advisory).not.toBeChecked();
  await advisory.check();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "All projects" })
    .click();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Also notify for advisory items" }),
  ).toBeChecked();
});

// #1102: global commands are added, edited and deleted from Settings.
test("a global command is added, edited and deleted from Settings", async ({ app }) => {
  const page = await app("#/settings/commands");
  await expect(page.getByText("~/.baked/commands/", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "New command" }).click();
  const dialog = page.getByRole("dialog");
  const add = dialog.getByRole("button", { name: "Add command" });
  await expect(dialog.getByText("Give the command a name.")).toBeVisible();
  await expect(add).toBeDisabled();
  await dialog.getByLabel("Name").fill("Bad Name");
  await expect(dialog.getByText(/Use lowercase letters/)).toBeVisible();
  await dialog.getByLabel("Name").fill("explain");
  await expect(dialog.getByText("/explain already exists.")).toBeVisible();
  await dialog.getByLabel("Name").fill("weekly-notes");
  await dialog.getByLabel("Description").fill("Write my weekly notes");
  await dialog.getByLabel("Prompt").fill("Summarize what I did yesterday.");
  await add.click();
  await expect(dialog).toBeHidden();
  const list = page.getByRole("region", { name: "Global commands" });
  await expect(list.getByText("Write my weekly notes")).toBeVisible();

  await list.getByRole("button", { name: "Edit /weekly-notes" }).click();
  await expect(dialog.getByLabel("Prompt")).toHaveValue("Summarize what I did yesterday.");
  await dialog.getByLabel("Description").fill("Draft my weekly notes");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(list.getByText("Draft my weekly notes")).toBeVisible();

  await list.getByRole("button", { name: "Delete /weekly-notes" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(list.getByText("Draft my weekly notes")).toBeHidden();
});

test("the Providers page shows how much of each subscription is left", async ({ app }) => {
  const page = await app("#/settings/providers");
  const panel = page.getByRole("region", { name: "Subscription limits" });
  await expect(panel.getByRole("article", { name: "Codex" })).toContainText("62% left");
  await expect(panel.getByRole("article", { name: "Codex" })).toContainText("resets in 2 h");
  await expect(panel.getByRole("article", { name: "Claude Code" })).toContainText("seen 42 min ago");
  await expect(panel.getByRole("article", { name: "GitHub Copilot" })).toContainText(
    "0% left · 0 of 300",
  );
  await expect(panel.getByRole("article", { name: "GitHub Copilot" })).toContainText("unlimited");
});
