import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/**
 * What users do in a chat, against the repository's own `baked serve` with a scripted model
 * (BAKED_TEST_SCRIPT): every request, event and saved message is the real server's.
 */

/** Opens the project and a new chat in it; returns the composer and the conversation. */
async function newChat(page: Page, project = "gamma") {
  await page.getByRole("article", { name: project }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "New chat" }).click();
  return chatParts(page);
}

function chatParts(page: Page) {
  return {
    composer: page.getByRole("textbox", { name: "Message BAKED" }),
    conversation: page.getByRole("region", { name: "Conversation" }),
  };
}

async function send(page: Page, text: string): Promise<void> {
  const { composer } = chatParts(page);
  await composer.fill(text);
  await expect(composer).toHaveValue(text);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
}

const idle = (page: Page) => expect(page.getByRole("button", { name: "Send" })).toBeVisible();

/** A long answer that streams for a few seconds at 30 ms a word. */
const longText = (tag: string) =>
  Array.from({ length: 150 }, (_, i) => `${tag}${i}`).join(" ");

test("a streamed answer renders its Markdown", async ({ workspace, launch }) => {
  workspace.project("gamma");
  const markdown = [
    "## Findings",
    "",
    "The **retry** loop lives in `chain.ts`:",
    "",
    "- first item",
    "- second item",
    "",
    "```ts",
    "const retries = 3;",
    "```",
    "",
    "| Model | Retries |",
    "| --- | --- |",
    "| opus | 3 |",
  ].join("\n");
  const { page } = await launch({ script: { delayMs: 2, turns: [{ steps: [{ text: markdown }] }] } });
  const { conversation } = await newChat(page);
  await send(page, "Where are the retries?");
  await expect(conversation.getByRole("heading", { name: "Findings" })).toBeVisible();
  await expect(conversation.locator("strong", { hasText: "retry" })).toBeVisible();
  await expect(conversation.getByRole("listitem")).toHaveText(["first item", "second item"]);
  await expect(conversation.locator("pre code")).toContainText("const retries = 3;");
  await expect(conversation.getByRole("table")).toBeVisible();
  await expect(conversation.getByRole("cell", { name: "opus" })).toBeVisible();
  await idle(page);
});

test("Stop ends a streaming turn and the chat takes the next message", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch({
    script: {
      delayMs: 30,
      turns: [{ steps: [{ text: longText("slow") }] }, { steps: [{ text: "Back again." }] }],
    },
  });
  const { conversation } = await newChat(page);
  await send(page, "Write a long answer");
  await expect(conversation.getByText(/slow3 /)).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await idle(page);
  // The rest of the answer never arrives.
  await expect(conversation.getByText(/slow149/)).toHaveCount(0);
  await send(page, "Again");
  await expect(conversation.getByText("Back again.")).toBeVisible();
  await idle(page);
});

test("a denied write outside the project fails the call and the answer says so", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const outside = "/tmp/baked-e2e-outside/denied.md";
  const { page } = await launch({
    script: {
      delayMs: 2,
      turns: [
        {
          steps: [
            {
              tool: "write_file",
              input: { path: outside, content: "x" },
              output: `Wrote ${outside}`,
              approval: { outsideCwd: outside },
            },
            { ifApproved: "Saved it." },
            { ifDenied: "I left the file alone." },
          ],
        },
      ],
    },
  });
  const { conversation } = await newChat(page);
  await send(page, "Write outside");
  const approval = conversation.getByRole("region", { name: /outside the project/i });
  await approval.getByRole("button", { name: "Deny" }).click();
  await expect(conversation.getByText("I left the file alone.")).toBeVisible();
  await expect(conversation.getByText("Saved it.")).toHaveCount(0);
  await expect(approval).toBeHidden();
  await idle(page);
});

test("a question card takes an option and the turn goes on with it", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch({
    script: {
      delayMs: 2,
      turns: [
        {
          steps: [
            { ask: "Which database?", options: ["SQLite", "Postgres"] },
            { ifAnswer: "SQLite", reply: "SQLite it is." },
            { ifAnswer: "Postgres", reply: "Postgres it is." },
          ],
        },
      ],
    },
  });
  const { conversation } = await newChat(page);
  await send(page, "Set up storage");
  const question = conversation.getByRole("region", { name: "Question" });
  await expect(question).toContainText("Which database?");
  await question.getByRole("button", { name: "Postgres" }).click();
  await expect(conversation.getByText("Postgres it is.")).toBeVisible();
  await expect(conversation.getByText("SQLite it is.")).toHaveCount(0);
  await idle(page);
});

test("reopening a chat in the middle of a turn shows what it already streamed", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch({
    script: { delayMs: 30, turns: [{ steps: [{ text: `Opening line. ${longText("w")}` }] }] },
  });
  const { conversation } = await newChat(page);
  await send(page, "Explain it slowly");
  await expect(conversation.getByText(/Opening line\. w0 w1/)).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { name: "gamma", level: 1 })).toBeVisible();
  await page.goBack();
  // The words streamed before the chat was reopened are still there, while the turn runs.
  await expect(conversation.getByText(/Opening line\. w0 w1/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await idle(page);
  await expect(conversation.getByText(/Opening line\. w0 .* w149/)).toBeVisible();
});

test("two chats run their turns at the same time", async ({ workspace, launch }) => {
  workspace.project("gamma");
  const { page } = await launch({
    script: {
      delayMs: 20,
      turns: [
        { when: "first chat", steps: [{ text: `First chat answer. ${longText("a")}` }] },
        { when: "second chat", steps: [{ text: "Second chat answer." }] },
      ],
    },
  });
  const { conversation } = await newChat(page);
  await send(page, "This is the first chat");
  await expect(conversation.getByText(/First chat answer\. a0/)).toBeVisible();
  const first = page.url();

  await page.getByRole("link", { name: "New chat" }).first().click();
  await send(page, "This is the second chat");
  await expect(conversation.getByText("Second chat answer.")).toBeVisible();
  await idle(page);

  // The first chat kept streaming meanwhile and finishes on its own.
  await page.goto(first);
  await expect(conversation.getByText(/First chat answer\. a0/)).toBeVisible();
  await expect(conversation.getByText(/a149/)).toBeVisible({ timeout: 15_000 });
  await expect(conversation.getByText("Second chat answer.")).toHaveCount(0);
  const chats = page.getByRole("navigation", { name: "Main" });
  await expect(chats.getByRole("link", { name: /This is the first chat/ })).toBeVisible();
  await expect(chats.getByRole("link", { name: /This is the second chat/ })).toBeVisible();
});

test("Compact now summarizes the older messages", async ({ workspace, launch }) => {
  workspace.project("gamma");
  const turns = ["one", "two", "three", "four"].map((n) => ({
    steps: [{ text: `Answer ${n}.` }],
  }));
  const { page } = await launch({
    script: { delayMs: 2, compaction: "We talked about three things.", turns },
  });
  const { conversation } = await newChat(page);
  for (const n of ["one", "two", "three"]) {
    await send(page, `Question ${n}`);
    await expect(conversation.getByText(`Answer ${n}.`)).toBeVisible();
    await idle(page);
  }
  await page.getByRole("button", { name: /context$/ }).click();
  await page.getByRole("dialog", { name: "Context" }).getByRole("button", { name: "Compact now" }).click();
  // Six messages: the last two stay, the four before them become the summary.
  await expect(conversation.getByText(/Compacted 4 messages into a summary/)).toBeVisible();
  await idle(page);
  await send(page, "Question four");
  await expect(conversation.getByText("Answer four.")).toBeVisible();
});

test("Undo drops the last turn on the server and Redo puts it back", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch({
    script: {
      delayMs: 2,
      turns: [{ steps: [{ text: "First answer." }] }, { steps: [{ text: "Second answer." }] }],
    },
  });
  const { conversation } = await newChat(page);
  await send(page, "First question");
  await expect(conversation.getByText("First answer.")).toBeVisible();
  await idle(page);
  await send(page, "Second question");
  await expect(conversation.getByText("Second answer.")).toBeVisible();
  await idle(page);

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("dialog", { name: "Undo the last turn?" }).getByRole("button", { name: "Undo" }).click();
  await expect(conversation.getByText("Second question")).toBeHidden();
  await expect(conversation.getByText("First answer.")).toBeVisible();
  // The server dropped it too: a reload shows the same transcript.
  await page.reload();
  await expect(conversation.getByText("First answer.")).toBeVisible();
  await expect(conversation.getByText("Second question")).toHaveCount(0);

  await page.getByRole("button", { name: "Redo" }).click();
  await expect(conversation.getByText("Second answer.")).toBeVisible();
});
