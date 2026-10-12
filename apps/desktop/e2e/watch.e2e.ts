import { expect, test } from "./fixtures.ts";

test("Watch files turns watch mode on for a chat, and another chat can take it over", async ({
  app,
}) => {
  const page = await app("#/p/baked/chat");
  const prompt = page.getByRole("textbox", { name: "Message BAKED" });
  const watch = page.getByRole("button", { name: "Watch files" });
  await expect(watch).toHaveAttribute("aria-pressed", "false");
  await expect(watch).toHaveAttribute("title", /saving a baked! comment changes the code/);
  await watch.click();
  const watching = page.getByRole("button", { name: "Watching files" });
  await expect(watching).toHaveAttribute("aria-pressed", "true");
  await expect(watching).toHaveAttribute("title", /^Watching .*: 0 turns so far\. Click to stop\.$/);

  await page.getByRole("link", { name: "New chat" }).first().click();
  // A new chat has no watch until its first message saves it.
  await expect(page.getByRole("heading", { name: "New chat" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Watch/ })).toBeHidden();
  await prompt.fill("Explain the router");
  await prompt.press("Enter");
  const other = page.getByRole("button", { name: "Watch files" });
  await expect(other).toHaveAttribute("title", /^Another chat watches the files/);
  await other.click();
  await expect(page.getByRole("button", { name: "Watching files" })).toBeVisible();
  await page.getByRole("button", { name: "Watching files" }).click();
  await expect(page.getByRole("button", { name: "Watch files" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});
