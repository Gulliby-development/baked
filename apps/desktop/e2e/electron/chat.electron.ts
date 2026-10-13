import { expect, test } from "./fixtures.ts";

const outside = "/tmp/baked-e2e-outside/note.md";

/** One turn: streamed text, a read, then a write outside the project that asks first. */
const script = {
  delayMs: 20,
  turns: [
    {
      steps: [
        { reasoning: "The note goes outside the project, so the write needs an approval." },
        { text: "Let me read the project first. " },
        { tool: "read", input: { files: [{ path: "README.md" }] }, output: "1 file, 3 lines" },
        {
          tool: "write_file",
          input: { path: outside, content: "# Note\n" },
          output: `Wrote ${outside}`,
          approval: { outsideCwd: outside },
        },
        { ifApproved: "The note is saved outside the project." },
        { ifDenied: "I left the note unwritten." },
      ],
    },
  ],
};

test("a chat turn against a real baked serve streams, calls tools and waits for an approval", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch({ script });
  await page.getByRole("article", { name: "gamma" }).getByRole("button", { name: "Open" }).click();
  // A project opens on its coordinator; Overview is the next item.
  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { name: "gamma", level: 1 })).toBeVisible();

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "New chat" })
    .click();
  const composer = page.getByRole("textbox", { name: "Message BAKED" });
  await composer.fill("Save a note outside the project");
  await composer.press("Enter");

  const conversation = page.getByRole("region", { name: "Conversation" });
  await expect(conversation.getByText("Let me read the project first.")).toBeVisible();
  await expect(conversation.getByRole("button", { name: /Read/ }).first()).toBeVisible();
  const approval = conversation.getByRole("region", { name: /outside the project/i });
  await expect(approval).toContainText(outside);
  await approval.getByRole("button", { name: "Allow" }).click();
  await expect(conversation.getByText("The note is saved outside the project.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(approval).toBeHidden();
});
