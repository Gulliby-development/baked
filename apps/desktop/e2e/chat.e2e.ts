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
  // The command has not run while its approval waits.
  await expect(conversation.getByRole("button", { name: /Running rm -rf \.cache\/router/ })).toBeVisible();
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

test("Rewind to here drops the later turns and Redo brings them back", async ({ app }) => {
  const page = await app("#/p/baked/chat");
  const conversation = page.getByRole("region", { name: "Conversation" });
  await page.getByRole("textbox", { name: "Message BAKED" }).fill("Clear the router cache and test");
  await page.getByRole("textbox", { name: "Message BAKED" }).press("Enter");
  const approval = conversation.getByRole("region", { name: "Run a destructive command?" });
  await approval.getByRole("button", { name: "Deny" }).click();
  await expect(conversation.getByText(/Okay, I did not run it/)).toBeVisible();
  await conversation.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  const rewinds = conversation.getByRole("button", { name: "Rewind to here" });
  await expect(rewinds).toHaveCount(1);
  await rewinds.click();
  await conversation
    .getByRole("group", { name: "Rewind to here" })
    .getByRole("button", { name: "Rewind" })
    .click();
  await expect(conversation.getByText("Clear the router cache and test")).toBeHidden();
  await expect(page.getByText(/Undid the chat back to checkpoint #1/)).toBeVisible();
  await expect(rewinds).toHaveCount(0);

  await page.getByRole("button", { name: "Redo" }).click();
  await expect(conversation.getByText("Clear the router cache and test")).toBeVisible();
});

test("Undo asks in the app before it drops the last turn", async ({ app }) => {
  const page = await app("#/p/baked/chat");
  const conversation = page.getByRole("region", { name: "Conversation" });
  await page.getByRole("textbox", { name: "Message BAKED" }).fill("Clear the router cache and test");
  await page.getByRole("textbox", { name: "Message BAKED" }).press("Enter");
  await conversation
    .getByRole("region", { name: "Run a destructive command?" })
    .getByRole("button", { name: "Deny" })
    .click();
  await conversation.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Undo the last turn?" });
  await dialog.getByRole("button", { name: "Keep" }).click();
  await expect(dialog).toBeHidden();
  await expect(conversation.getByText("Clear the router cache and test")).toBeVisible();

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await dialog.getByRole("button", { name: "Undo" }).click();
  await expect(conversation.getByText("Clear the router cache and test")).toBeHidden();
});
