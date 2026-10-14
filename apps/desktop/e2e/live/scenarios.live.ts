import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, liveModel, test } from "./fixtures.ts";

/**
 * What a person does with BAKED, asked of a real model in plain words. Each scenario checks the
 * outcome (a file, a setting, a screen), never the model's wording, and allows every approval
 * the model asks for: the scenario is about getting the work done, the approval flow has its own
 * scripted tests in e2e/electron.
 */

test.skip(!liveModel, "set BAKED_LIVE_MODEL to a provider/model to run the live scenarios");

const read = (file: string): string => (existsSync(file) ? readFileSync(file, "utf8") : "");
const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });

async function openProject(page: Page, project: string) {
  await page.getByRole("article", { name: project }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message BAKED" });
  await composer.fill(text);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
}

/**
 * Waits for `done`, allowing each approval card on the way. A question card fails the scenario:
 * every prompt here says all the model needs, so a question is a finding in itself.
 */
async function until(page: Page, done: () => boolean | Promise<boolean>, timeoutMs = 10 * 60_000) {
  const conversation = page.getByRole("region", { name: "Conversation" });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await done()) return;
    const question = conversation.getByRole("region", { name: "Question" });
    if (await question.count())
      throw new Error(`The model asked instead of acting: ${await question.first().innerText()}`);
    const allow = conversation.getByRole("button", { name: "Allow", exact: true });
    if (await allow.count()) await allow.first().click().catch(() => undefined);
    await page.waitForTimeout(1000);
  }
  throw new Error(`Not done within ${Math.round(timeoutMs / 1000)}s`);
}

/** A Git project whose feature check passes once `greet.txt` says hello. */
function runnableProject(root: string): void {
  execSync(
    "git init -q && git -c user.email=live@baked.dev -c user.name=live commit -q --allow-empty -m init",
    { cwd: root },
  );
  mkdirSync(join(root, ".baked"), { recursive: true });
  writeFileSync(
    join(root, ".baked", "config.json"),
    JSON.stringify({
      workflows: {
        enabled: true,
        policy: {
          checks: [
            {
              id: "greet",
              executable: "bun",
              args: ["-e", "if (!(await Bun.file('greet.txt').text()).toLowerCase().includes('hello')) process.exit(1)"],
              cwd: ".",
              timeoutMs: 20000,
              required: true,
              scope: "feature",
              envNames: [],
              writes: [],
            },
          ],
        },
      },
    }),
  );
}

test("a chat creates the file it was asked for", async ({ workspace, launch }) => {
  const root = workspace.project("alpha");
  const { page } = await launch();
  await openProject(page, "alpha");
  await nav(page).getByRole("link", { name: "New chat" }).click();
  await send(page, "Create a file named hello.txt in the project root containing exactly: hello from baked");
  await until(page, () => read(join(root, "hello.txt")).trim() === "hello from baked");
  // The turn ends: the composer offers Send again.
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 5 * 60_000 });
});

test("the coordinator adds a hook that shows on the Hooks screen", async ({ workspace, launch }) => {
  const root = workspace.project("beta");
  const { page } = await launch();
  await openProject(page, "beta");
  await send(
    page,
    "Add a project hook: before every Bash tool call (PreToolUse, matcher Bash) run ./scripts/guard.sh. Do not create the script.",
  );
  await until(page, () => read(join(root, ".baked", "config.json")).includes("./scripts/guard.sh"));
  await nav(page).getByRole("link", { name: "Hooks" }).click();
  await expect(page.getByText("./scripts/guard.sh").first()).toBeVisible();
});

test("a quick workflow run builds the change and passes its check", async ({ workspace, launch }) => {
  const root = workspace.project("gamma");
  runnableProject(root);
  const { page } = await launch();
  await openProject(page, "gamma");
  await nav(page).getByRole("link", { name: "New run" }).click();
  const form = page.getByRole("form", { name: "New workflow run" });
  await form
    .getByRole("textbox", { name: "What should change?" })
    .fill("Add a file greet.txt in the project root that says hello to the reader.");
  await form.getByRole("button", { name: /^quick/ }).click();
  await form.getByRole("button", { name: "Start run" }).click();

  const part = page.getByRole("region", { name: "Your part" });
  const done = page.getByRole("list", { name: "Stages" }).getByRole("button", { name: /^Done finish/ });
  await until(page, async () => {
    const approve = part.getByRole("button", { name: "Approve and implement" });
    if (await approve.count()) await approve.click().catch(() => undefined);
    return expect(done)
      .toHaveAccessibleName(/, done$/, { timeout: 1000 })
      .then(
        () => true,
        () => false,
      );
  });
  await expect(done).toHaveAccessibleName(/, done$/);
  expect(read(join(root, "greet.txt")).toLowerCase()).toContain("hello");
});
