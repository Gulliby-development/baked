import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/**
 * Setting BAKED up by asking the coordinator (`baked_setup`) against the repository's own
 * `baked serve`: the scripted model calls the real tool, every change waits for its card, and the
 * result is checked on disk and on the matching Setup screen.
 */

async function openCoordinator(page: Page, project = "gamma") {
  await page.getByRole("article", { name: project }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
  return page.getByRole("region", { name: "Conversation" });
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message BAKED" });
  await composer.fill(text);
  await expect(composer).toHaveValue(text);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const setup = (input: Record<string, unknown>) => ({ tool: "baked_setup", input, run: true });
/** Turns the coordinator takes on its own when launched work changes. */
const wakes = Array.from({ length: 8 }, () => ({ steps: [{ text: "Noted." }] }));

const read = (file: string): string => (existsSync(file) ? readFileSync(file, "utf8") : "");

test("a hook the coordinator adds waits for its card, then shows on the Hooks screen", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch({
    script: {
      delayMs: 2,
      turns: [
        {
          when: "guard every shell command",
          steps: [
            setup({
              area: "hook",
              action: "add",
              event: "PreToolUse",
              matcher: "Bash",
              command: "./scripts/guard.sh",
            }),
            { text: "Added the hook." },
          ],
        },
        ...wakes,
      ],
    },
  });
  const conversation = await openCoordinator(page);
  await send(page, "Please guard every shell command with ./scripts/guard.sh");
  const card = conversation.getByRole("region", { name: "Approve this step?" });
  await expect(card).toContainText("./scripts/guard.sh");
  expect(read(join(root, ".baked", "config.json"))).not.toContain("guard.sh");
  await card.getByRole("button", { name: "Allow" }).click();
  await expect(conversation.getByText("Added the hook.")).toBeVisible();
  expect(read(join(root, ".baked", "config.json"))).toContain("./scripts/guard.sh");

  await nav(page).getByRole("link", { name: "Hooks" }).click();
  await expect(page.getByText("./scripts/guard.sh")).toBeVisible();
});

test("a denied skill is not written", async ({ workspace, launch }) => {
  const root = workspace.project("gamma");
  const { page } = await launch({
    script: {
      delayMs: 2,
      turns: [
        {
          when: "release notes skill",
          steps: [
            setup({
              area: "skill",
              action: "create",
              name: "release-notes",
              description: "Writes release notes from merged pull requests.",
              content: "Read the merged pull requests and write notes.",
            }),
            { text: "Done." },
          ],
        },
        ...wakes,
      ],
    },
  });
  const conversation = await openCoordinator(page);
  await send(page, "Please add a release notes skill");
  const card = conversation.getByRole("region", { name: "Approve this step?" });
  await expect(card).toContainText("release-notes");
  await card.getByRole("button", { name: "Deny" }).click();
  await expect(card).toBeHidden();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  expect(existsSync(join(root, ".baked", "skills", "release-notes"))).toBe(false);

  await nav(page).getByRole("link", { name: "Skills" }).click();
  await expect(
    page.getByRole("region", { name: "In this project" }).getByRole("heading", { name: "In this project · 0" }),
  ).toBeVisible();
});

test("an MCP server and AGENTS.md set up in one turn show on their screens", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch({
    script: {
      delayMs: 2,
      turns: [
        {
          when: "connect the notes server",
          steps: [
            setup({
              area: "mcp",
              action: "add",
              name: "notes",
              server: { command: "bun", args: ["run", "notes-server.ts"] },
            }),
            setup({
              area: "agent_context",
              action: "write",
              content: "# Conventions\n\nUse Bun for every script.\n",
            }),
            { text: "Both are set up." },
          ],
        },
        ...wakes,
      ],
    },
  });
  const conversation = await openCoordinator(page);
  await send(page, "Please connect the notes server and write our conventions");
  const card = conversation.getByRole("region", { name: "Approve this step?" });
  await expect(card).toContainText("notes");
  await card.getByRole("button", { name: "Allow" }).click();
  await expect(card).toContainText("Use Bun for every script.");
  await card.getByRole("button", { name: "Allow" }).click();
  await expect(conversation.getByText("Both are set up.")).toBeVisible();
  expect(read(join(root, "AGENTS.md"))).toContain("Use Bun for every script.");

  await nav(page).getByRole("link", { name: "MCP servers" }).click();
  await expect(
    page.getByRole("region", { name: "In this project" }).getByText("notes", { exact: true }),
  ).toBeVisible();
  await nav(page).getByRole("link", { name: "Agent context" }).click();
  await expect(page.getByText("Use Bun for every script.").first()).toBeVisible();
});

/** A Git project whose feature check passes once the scripted run wrote its file. */
function runnableProject(root: string): void {
  execSync(
    "git init -q && git -c user.email=e2e@baked.dev -c user.name=e2e commit -q --allow-empty -m init",
    { cwd: root },
  );
  mkdirSync(join(root, ".baked"), { recursive: true });
  writeFileSync(
    join(root, ".baked", "config.json"),
    JSON.stringify({
      workflows: {
        enabled: true,
        importsEnabled: false,
        defaultWorkflow: "sdd",
        policy: {
          checks: [
            {
              id: "output",
              executable: "bun",
              args: ["-e", "if ((await Bun.file('e2e-output.txt').text()) !== 'ready') process.exit(1)"],
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

test("a workflow the coordinator creates is saved, then runs when it starts it", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  runnableProject(root);
  const { page } = await launch({
    env: { BAKED_TEST_WORKFLOW: "1" },
    script: {
      delayMs: 2,
      turns: [
        {
          when: "workflow for small fixes",
          steps: [
            setup({
              area: "workflow",
              action: "create",
              name: "small-fix",
              from: "quick",
              description: "A small fix with one approval.",
            }),
            {
              tool: "start_run",
              input: { prompt: "Write the output file", workflow: "small-fix", why: "a small fix" },
              run: true,
            },
          ],
        },
        ...wakes,
      ],
    },
  });
  const conversation = await openCoordinator(page);
  await send(page, "Please make a workflow for small fixes and use it");
  const card = conversation.getByRole("region", { name: "Approve this step?" });
  await expect(card).toContainText("small-fix");
  await card.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => existsSync(join(root, "baked", "workflows", "small-fix.json"))).toBe(true);

  // The run card names the new workflow; the run is approved in its own window.
  const proposal = conversation.getByRole("region", { name: "Workflow proposal" });
  await expect(proposal).toContainText("small-fix");
  await proposal.getByRole("button", { name: "Run workflow" }).click();
  const item = page
    .getByRole("region", { name: "Launched work" })
    .getByRole("listitem")
    .filter({ hasText: "Write the output file" });
  await expect(item).toContainText(/waiting/i, { timeout: 15_000 });
  await item.getByRole("link").first().click();
  await page
    .getByRole("region", { name: "Your part" })
    .getByRole("button", { name: "Approve and implement" })
    .click();
  await expect(
    page.getByRole("list", { name: "Stages" }).getByRole("button", { name: /^Done finish/ }),
  ).toHaveAccessibleName(/, done$/, { timeout: 30_000 });
  expect(read(join(root, "e2e-output.txt"))).toBe("ready");

  // The Workflows screen lists it as a project workflow.
  await nav(page).getByRole("link", { name: "Workflows" }).click();
  await expect(page.getByRole("link", { name: "small-fix", exact: true })).toBeVisible();
});
