import { expect, test } from "./fixtures.ts";

test("a chat turn streams text and tool cards, and waits for an approval", async ({ app }) => {
  const page = await app("#/p/baked/chat");
  const conversation = page.getByRole("region", { name: "Conversation" });
  await page
    .getByRole("textbox", { name: "Message BAKED" })
    .fill("Give each fallback model its own retries");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(conversation.getByText("Give each fallback model its own retries")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(conversation.getByText("Let me look at the current code first.")).toBeVisible();
  await expect(conversation.getByRole("button", { name: "Done Read 2 files" })).toBeVisible();
  await expect(
    conversation.getByRole("figure", { name: "Changes to src/core/llm/chain.ts" }),
  ).toBeVisible();

  const approval = conversation.getByRole("region", { name: "Run a destructive command?" });
  await expect(approval).toContainText("rm -rf .cache/router");
  await approval.getByRole("button", { name: "Allow" }).click();
  await expect(approval).toBeHidden();
  await expect(conversation.getByText(/All 13 tests pass/)).toBeVisible();

  await conversation.getByRole("button", { name: /^Yes, both paths/ }).click();
  await expect(conversation.getByText(/Noted: yes/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});

test("denying an approval skips the command", async ({ app }) => {
  const page = await app("#/p/baked/chat");
  const conversation = page.getByRole("region", { name: "Conversation" });
  await page
    .getByRole("textbox", { name: "Message BAKED" })
    .fill("Clear the router cache and test");
  await page.getByRole("textbox", { name: "Message BAKED" }).press("Enter");

  const approval = conversation.getByRole("region", { name: "Run a destructive command?" });
  await approval.getByRole("button", { name: "Deny" }).click();
  await expect(conversation.getByText(/Okay, I did not run it/)).toBeVisible();
});
