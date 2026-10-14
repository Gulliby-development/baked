import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/**
 * The coordinator against the repository's own `baked serve` with a scripted model: its launch
 * tools run for real (`"run": true`), so the sessions it starts are real sessions that take
 * their own scripted turns (matched by `when` on their brief).
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
  await composer.press("Enter");
}

const launch = (brief: string, mode: "architect" | "default" = "architect") => ({
  tool: "launch_session",
  input: { title: "Audit docs", brief, mode, why: "focused work" },
  run: true,
});

/** Turns the coordinator takes on its own when launched work changes (wake notes). */
const wakes = Array.from({ length: 6 }, () => ({ steps: [{ text: "Noted." }] }));

test("an editing session starts after an approval, asks in its thread and reports back", async ({
  workspace,
  launch: start,
}) => {
  workspace.project("gamma");
  const { page } = await start({
    script: {
      delayMs: 2,
      turns: [
        {
          when: "audit the docs",
          steps: [{ text: "Starting a session. " }, launch("child: audit every doc", "default")],
        },
        {
          when: "child: audit every doc",
          steps: [
            { text: "Looking. " },
            { ask: "Which docs?", options: ["All", "Only the API"] },
            { ifAnswer: "Only the API", reply: "The API docs are current." },
          ],
        },
        ...wakes,
      ],
    },
  });
  const { conversation, launched } = await openCoordinator(page);
  await send(page, "Please audit the docs");

  // Starting a session that edits files waits for a yes, worded as a step, not a command.
  const approval = conversation.getByRole("region", { name: "Approve this step?" });
  await expect(approval).toContainText('Start a default-mode session that can edit files: "Audit docs"');
  await approval.getByRole("button", { name: "Allow" }).click();

  await expect(launched.getByRole("link", { name: "Audit docs" })).toBeVisible();
  const thread = conversation.getByRole("article", { name: /^Thread Audit docs/ });
  await expect(thread).toContainText("Asks: Which docs?");
  await thread.getByRole("link", { name: "Open" }).click();

  // The session's own window: its brief, what it streamed, and its question.
  await expect(page.getByRole("heading", { name: "Audit docs", level: 1 })).toBeVisible();
  const child = page.getByRole("region", { name: "Conversation" });
  await expect(child.getByText("child: audit every doc")).toBeVisible();
  await expect(child.getByText("Looking.")).toBeVisible();
  await child.getByRole("region", { name: "Question" }).getByRole("button", { name: "Only the API" }).click();
  await expect(child.getByText("The API docs are current.")).toBeVisible();

  // Back in the coordinator, the thread shows the answer and the item can be closed.
  await page.getByRole("link", { name: "Coordinator" }).first().click();
  await expect(conversation.getByRole("article", { name: "Thread Audit docs: done" })).toContainText(
    "The API docs are current.",
  );
  await expect(launched.getByRole("listitem")).toContainText(/done/i);
  await launched.getByRole("button", { name: "Close Audit docs" }).click();
  await expect(launched.getByRole("link", { name: "Audit docs" })).toHaveCount(0);
  await expect(launched.getByRole("button", { name: /Show closed \(1\)/ })).toBeVisible();
});

test("a denied launch starts nothing and the coordinator hears why", async ({
  workspace,
  launch: start,
}) => {
  workspace.project("gamma");
  const { page } = await start({
    script: {
      delayMs: 2,
      turns: [{ when: "edit the docs", steps: [launch("child: edit", "default")] }, ...wakes],
    },
  });
  const { conversation, launched } = await openCoordinator(page);
  await send(page, "Please edit the docs");
  const approval = conversation.getByRole("region", { name: "Approve this step?" });
  await approval.getByRole("button", { name: "Deny" }).click();
  await expect(approval).toBeHidden();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await conversation.getByRole("button", { name: /Launch session/ }).click();
  await expect(conversation.getByText(/declined to start a session/)).toBeVisible();
  await expect(launched.getByText(/Nothing yet/)).toBeVisible();
});

test("Stop in Launched work interrupts a session that is still streaming", async ({
  workspace,
  launch: start,
}) => {
  workspace.project("gamma");
  const long = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
  const { page } = await start({
    script: {
      delayMs: 30,
      turns: [
        { when: "read slowly", steps: [launch("child: read everything")] },
        { when: "child: read everything", steps: [{ text: long }] },
        ...wakes,
      ],
    },
  });
  const { launched } = await openCoordinator(page);
  await send(page, "Please read slowly");
  await expect(launched.getByRole("listitem")).toContainText(/working/i);
  await launched.getByRole("button", { name: "Stop Audit docs" }).click();
  await expect(launched.getByRole("listitem")).not.toContainText(/working/i, { timeout: 10_000 });
  await launched.getByRole("link", { name: "Audit docs" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  // The session stopped well before the end of its answer.
  await expect(page.getByRole("region", { name: "Conversation" }).getByText(/w299/)).toHaveCount(0);
});

test("a launched session writes to the coordinator, which answers in its own turn", async ({
  workspace,
  launch: start,
}) => {
  workspace.project("gamma");
  const { page } = await start({
    script: {
      delayMs: 2,
      turns: [
        { when: "check the build", steps: [launch("child: check the build")] },
        {
          when: "child: check the build",
          steps: [
            {
              tool: "send_message",
              input: { to: "coordinator", text: "The build needs Node 24." },
              run: true,
            },
            { text: "Told the coordinator." },
          ],
        },
        { when: "The build needs Node 24.", steps: [{ text: "Thanks, I will pin Node 24." }] },
        ...wakes,
      ],
    },
  });
  const { conversation } = await openCoordinator(page);
  await send(page, "Please check the build");
  await expect(conversation.getByText("Thanks, I will pin Node 24.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(conversation.getByText(/The build needs Node 24\./).first()).toBeVisible();
});
