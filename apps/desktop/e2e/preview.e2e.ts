import { expect, test } from "./fixtures.ts";

test("the chat's documents open in the preview panel beside the conversation", async ({ app }) => {
  const page = await app("#/p/docs/chat/0b6e2f19-release");
  const toggle = page.getByRole("button", { name: "Preview · 3" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const panel = page.getByRole("complementary", { name: "Preview" });
  await expect(panel).toBeHidden();

  // A diff card's Preview button opens its document.
  await page
    .getByRole("figure", { name: "Changes to docs/release-notes-0.6.md" })
    .getByRole("button", { name: "Preview" })
    .click();
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const tabs = panel.getByRole("tablist", { name: "Documents" });
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await expect(tabs.getByRole("tab", { name: /release-notes-0\.6\.md/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel.getByRole("heading", { name: "BAKED 0.6" })).toBeVisible();
  await expect(panel.getByRole("table")).toContainText("Median review time");

  await panel.getByRole("button", { name: "Source" }).click();
  await expect(panel.getByText("# BAKED 0.6")).toBeVisible();

  // HTML draws in a sandboxed frame and starts rendered again.
  await tabs.getByRole("tab", { name: /whats-new\.html/ }).click();
  const frame = panel.getByTitle("Preview of whats-new.html");
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(
    page.frameLocator('[title="Preview of whats-new.html"]').getByRole("heading", {
      name: "What's new in 0.6",
    }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Open" }).click();

  // The saved artifact is the third document.
  await tabs.getByRole("tab", { name: /Release notes 0\.3/ }).click();
  await expect(panel.getByTitle("Preview of Release notes 0.3")).toBeVisible();

  // The resize handle takes the arrow keys; the panel remembers it was open.
  const handle = panel.getByRole("separator", { name: "Resize the preview" });
  const before = Number(await handle.getAttribute("aria-valuenow"));
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", String(before + 32));

  await panel.getByRole("button", { name: "Close the preview" }).click();
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(panel).toBeVisible();
});

test("a chat without documents has no preview", async ({ app }) => {
  const page = await app("#/p/docs/chat/1d0e5b42-guide");
  await expect(page.getByRole("button", { name: /^Preview/ })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Preview" })).toHaveCount(0);
});
