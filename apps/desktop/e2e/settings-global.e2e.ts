import { expect, test } from "./fixtures.ts";

test("telemetry is switched off and on, and the note says what is recorded", async ({ app }) => {
  const page = await app("#/settings/telemetry");
  await expect(page.getByRole("heading", { level: 1, name: "Telemetry" })).toBeVisible();
  const panel = page.getByRole("region", { name: "Telemetry" });
  const box = panel.getByRole("checkbox", { name: /^Record anonymous usage stats/ });
  await expect(box).toBeChecked();
  await expect(panel).toContainText("Recorded only in a local log under ~/.baked/telemetry");
  await expect(panel).toContainText("Prompts, paths and keys are never recorded.");

  await box.uncheck();
  await expect(box).not.toBeChecked();
  await expect(panel).toContainText("Nothing is recorded.");

  // The choice is kept in the global config, so it survives leaving the page.
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "Run notifications" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Run notifications" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "Telemetry" })
    .click();
  await expect(box).not.toBeChecked();

  await box.check();
  await expect(box).toBeChecked();
  await expect(panel).toContainText("nothing is sent");
});

test("subscription limits show a meter per window, the tightest one and live countdowns", async ({
  page,
  app,
}) => {
  await app("#/settings/providers");
  const panel = page.getByRole("region", { name: "Subscription limits" });
  const codex = panel.getByRole("article", { name: "Codex" });
  await expect(codex).toContainText("Pro");
  await expect(codex).toContainText("tightest: Weekly");
  await expect(codex.getByRole("listitem")).toHaveCount(2);
  await expect(codex.getByRole("listitem").first()).toContainText(/5-hour\s*62% left/);
  await expect(codex.getByRole("listitem").nth(1)).toContainText(/Weekly\s*16% left/);

  const copilot = panel.getByRole("article", { name: "GitHub Copilot" });
  await expect(copilot).toContainText("limit reached");
  await expect(copilot).toContainText("Paid overage allowed past the limit");
  await expect(copilot.getByRole("listitem").filter({ hasText: "Chat" })).toContainText(
    "unlimited",
  );

  // The reset countdown follows the clock without a reload.
  await expect(codex.getByRole("listitem").first()).toContainText("resets in 2 h 12 min");
  await page.clock.fastForward("01:00:00");
  await expect(codex.getByRole("listitem").first()).toContainText("resets in 1 h 1");

  // Refresh asks the backend again and is unavailable while it does.
  const refresh = panel.getByRole("button", { name: "Refresh" });
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(codex).toContainText("Read from Codex just now.");
});

test("each provider shows how it is signed in, with the actions that fit", async ({ app }) => {
  const page = await app("#/settings/providers");
  const providers = page.getByRole("region", { name: "Providers" });
  const row = (name: string) => providers.getByRole("listitem").filter({ hasText: name });
  await expect(row("Anthropic")).toContainText("key from an environment variable");
  await expect(row("OpenAI").getByRole("button", { name: "Remove key" })).toBeVisible();
  await expect(row("Google Gemini").getByRole("link", { name: "Get a key" })).toHaveAttribute(
    "href",
    /aistudio\.google\.com/,
  );
  await expect(row("Codex").getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(row("Claude Code").getByRole("button", { name: "Switch account" })).toBeVisible();
});
