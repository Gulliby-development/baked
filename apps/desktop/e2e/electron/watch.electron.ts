import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";

const script = {
  delayMs: 10,
  turns: [
    { steps: [{ text: "Hello there." }] },
    { steps: [{ text: "Added the retry to load." }] },
  ],
};

test("a saved baked! comment starts a turn in the chat that watches the files", async ({
  workspace,
  launch,
}) => {
  const project = workspace.project("delta");
  const { page } = await launch({ script });
  await page.getByRole("article", { name: "delta" }).getByRole("button", { name: "Open" }).click();
  // The project opens on its coordinator; start the chat once it has loaded.
  await expect(page.getByRole("complementary", { name: "Coordinator brief" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "New chat" })
    .click();
  const composer = page.getByRole("textbox", { name: "Message BAKED" });
  await composer.fill("Hello");
  await composer.press("Enter");
  const conversation = page.getByRole("region", { name: "Conversation" });
  await expect(conversation.getByText("Hello there.")).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Watch files" }).click();
  const watching = page.getByRole("button", { name: "Watching files" });
  await expect(watching).toHaveAttribute("title", /^Watching .*delta/);
  writeFileSync(
    join(project, "load.ts"),
    "export function load() {\n  // baked! retry twice on a network error\n  return fetch('/items');\n}\n",
  );
  await expect(
    conversation.getByText("From load.ts:2 (baked!): retry twice on a network error"),
  ).toBeVisible({ timeout: 15_000 });
  await expect(conversation.getByText("Added the retry to load.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(watching).toHaveAttribute("title", /1 turn so far, the last from load\.ts:2/);
});
