import { execSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/**
 * Work the coordinator splits into parallel chats (`propose_chats`) and work a chat hands to the
 * coordinator, against the repository's own `baked serve` with a scripted model. The chats are real
 * sessions that take their own scripted turns, matched by `when` on their brief.
 */

async function openCoordinator(page: Page, project = "gamma") {
  await page.getByRole("article", { name: project }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
  return {
    conversation: page.getByRole("region", { name: "Conversation" }),
    launched: page.getByRole("region", { name: "Launched work" }),
  };
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message BAKED" });
  await composer.fill(text);
  await expect(composer).toHaveValue(text);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
}

/** Turns the coordinator takes on its own when launched work changes. */
const wakes = Array.from({ length: 8 }, () => ({ steps: [{ text: "Noted." }] }));

const docsSplit = {
  tool: "propose_chats",
  input: {
    title: "Docs",
    chats: [
      { id: "api", title: "API docs", brief: "chat: write the api docs", mode: "architect" },
      { id: "cli", title: "CLI docs", brief: "chat: write the cli docs", mode: "default" },
    ],
    why: "two independent parts",
  },
  run: true,
};

/** A long enough answer that both chats are still streaming when the other one starts. */
const long = (what: string) => `${"Reading the sources and drafting the pages. ".repeat(8)}${what}`;

test("approved parallel chats work side by side and both report back", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  // The editing chat works in its own worktree, so the project needs Git.
  execSync(
    "git init -q && git -c user.email=e2e@baked.dev -c user.name=e2e commit -q --allow-empty -m init",
    { cwd: root },
  );
  const { page } = await launch({
    script: {
      delayMs: 30,
      turns: [
        { when: "split the docs work", steps: [docsSplit] },
        { when: "chat: write the api docs", steps: [{ text: long("The API docs are written.") }] },
        { when: "chat: write the cli docs", steps: [{ text: long("The CLI docs are written.") }] },
        ...wakes,
      ],
    },
  });
  const { conversation, launched } = await openCoordinator(page);
  await send(page, "Please split the docs work");

  const card = conversation.getByRole("region", { name: "Split proposal" });
  await expect(card).toContainText('Split "Docs" into 2 parallel chats?');
  await expect(card).toContainText("API docs");
  await expect(card).toContainText("CLI docs");
  await card.getByRole("button", { name: "Approve split" }).click();

  const api = launched.getByRole("listitem").filter({ hasText: "API docs" });
  const cli = launched.getByRole("listitem").filter({ hasText: "CLI docs" });
  // Both are working at the same moment, not one after the other.
  await expect(async () => {
    await expect(api).toContainText("working", { timeout: 200 });
    await expect(cli).toContainText("working", { timeout: 200 });
  }).toPass({ timeout: 15_000 });
  await expect(api).toContainText("done", { timeout: 30_000 });
  await expect(cli).toContainText("done", { timeout: 30_000 });

  // Only the editing chat got its own worktree.
  const worktrees = execSync("git worktree list", { cwd: root, encoding: "utf8" }).trim().split("\n");
  expect(worktrees).toHaveLength(2);

  // Each chat's own window holds its brief and answer.
  await api.getByRole("link", { name: "API docs" }).click();
  await expect(page.getByRole("heading", { name: "API docs", level: 1 })).toBeVisible();
  const child = page.getByRole("region", { name: "Conversation" });
  await expect(child.getByText("chat: write the api docs")).toBeVisible();
  await expect(child.getByText(/The API docs are written\./)).toBeVisible();
  await expect(child.getByText(/The CLI docs are written\./)).toHaveCount(0);
});

test("Edit on a split rejects it and starts a message saying what to change", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch({
    script: {
      delayMs: 2,
      turns: [
        { when: "split the docs work", steps: [docsSplit, { text: "Tell me what to change." }] },
        { when: "Change the split: one chat", steps: [{ text: "One chat it is." }] },
        ...wakes,
      ],
    },
  });
  const { conversation, launched } = await openCoordinator(page);
  await send(page, "Please split the docs work");
  const card = conversation.getByRole("region", { name: "Split proposal" });
  await card.getByRole("button", { name: "Edit" }).click();
  await expect(card).toBeHidden();
  await expect(conversation.getByText("Tell me what to change.")).toBeVisible();
  await expect(launched.getByText(/Nothing yet/)).toBeVisible();

  const composer = page.getByRole("textbox", { name: "Message BAKED" });
  await expect(composer).toHaveValue("Change the split: ");
  await composer.pressSequentially("one chat is enough");
  await composer.press("Enter");
  await expect(conversation.getByText("One chat it is.")).toBeVisible();
});

test("a chat handed to the coordinator arrives there with its request", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch({
    script: {
      delayMs: 2,
      turns: [
        { when: "migrate the logs", steps: [{ text: "This touches many parts." }] },
        {
          when: "Take over this request",
          steps: [{ text: "I will plan the log migration from here." }],
        },
        ...wakes,
      ],
    },
  });
  await openCoordinator(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "New chat" }).click();
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
  await send(page, "Please migrate the logs to the new format");
  const chat = page.getByRole("region", { name: "Conversation" });
  await expect(chat.getByText("This touches many parts.")).toBeVisible();

  await page.getByRole("button", { name: /switch chat$/ }).click();
  await page.getByRole("button", { name: "Hand to coordinator" }).click();

  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
  const conversation = page.getByRole("region", { name: "Conversation" });
  await expect(conversation.getByText(/Take over this request from the chat/)).toBeVisible();
  await expect(conversation.getByText("Please migrate the logs to the new format")).toBeVisible();
  await expect(conversation.getByText("I will plan the log migration from here.")).toBeVisible();
});
