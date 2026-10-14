import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { choose, expectBakedStyle, failOnNativeDialogs } from "./baked-style.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The Hooks, MCP servers and Gates and checks screens of project setup against the repository's
 * own `baked serve`: seeded files show, edits and deletes reach the files the backend writes, and
 * invalid input is refused on screen with nothing written.
 */

async function openScreen(page: Page, screen: string, project = "gamma") {
  await page.getByRole("article", { name: project }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: screen }).click();
  await expect(page.getByRole("heading", { name: screen, level: 1 })).toBeVisible();
}

type Json = Record<string, unknown>;

const readJson = (file: string): Json =>
  existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Json) : {};
const projectFile = (root: string) => join(root, ".baked", "config.json");
const projectConfig = (root: string): Json => readJson(projectFile(root));
/** The home folder's BAKED config: HOME is `<workspace>/home` (fixtures.ts). */
const userFile = (dir: string) => join(dir, "home", ".baked", "config.json");

function seed(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** No model is needed: a script with no turns runs the real backend. */
const backend = { script: { turns: [] } };

// --- Hooks ----------------------------------------------------------------------------------

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const command = (text: string) => ({ type: "command", command: text });

/** The card of the hook that runs `text`: the innermost list item that shows it. */
const hookCard = (page: Page, text: string): Locator =>
  page
    .getByRole("listitem")
    .filter({ has: page.locator("code", { hasText: new RegExp(`^${escape(text)}$`) }) })
    .last();

test("hooks: a fresh project lists every event with no hooks and no files", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Hooks");
  await expect(page.getByText("No hooks yet.")).toBeVisible();
  const events = page.getByRole("list", { name: "Agent events" });
  await expect(events.getByRole("button", { name: "Add a hook to PreToolUse" })).toBeVisible();
  await expect(events.getByRole("button", { name: "Edit hook" })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: /hooks$/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Where hooks come from" }).click();
  const projectSource = page.getByRole("listitem").filter({ hasText: projectFile(root) });
  await expect(projectSource).toContainText("no file");
  await expect(projectSource).toContainText("saves here");
  await expectBakedStyle(page);
  expect(existsSync(projectFile(root))).toBe(false);
  expect(dialogs).toEqual([]);
});

test("hooks: the form refuses an empty command, a bad timeout and a broken matcher", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Hooks");
  await page.getByRole("button", { name: "New hook" }).click();
  const dialog = page.getByRole("dialog", { name: "New hook" });
  await expectBakedStyle(page);
  await dialog.getByRole("button", { name: "Blank hook" }).click();
  await expectBakedStyle(page);
  const add = dialog.getByRole("button", { name: "Add hook" });
  const commandField = dialog.getByRole("textbox", { name: /^Run this command/ });

  await expect(dialog.getByText("Add the command to run.")).toBeVisible();
  await expect(add).toBeDisabled();
  await commandField.fill("   ");
  await expect(add).toBeDisabled();

  await commandField.fill("./scripts/guard.sh");
  const timeout = dialog.getByRole("textbox", { name: "Timeout, seconds" });
  await timeout.fill("ten");
  await expect(dialog.getByText("The timeout is a whole number of seconds.")).toBeVisible();
  await expect(add).toBeDisabled();
  await timeout.fill("5000");
  await expect(dialog.getByText("The timeout is from 1 to 3600 seconds.")).toBeVisible();
  await expect(add).toBeDisabled();
  await timeout.fill("");

  await dialog.getByRole("textbox", { name: /^Only for these tool names/ }).fill("Bash(");
  await expect(dialog.getByText("The matcher is not a valid regular expression.")).toBeVisible();
  await expect(add).toBeDisabled();
  // Enter in a field submits the form; a problem keeps it from saving.
  await dialog.getByRole("textbox", { name: /^Only for these tool names/ }).press("Enter");
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("No hooks yet.")).toBeVisible();
  expect(existsSync(projectFile(root))).toBe(false);
  expect(dialogs).toEqual([]);
});

test("hooks: hooks seeded in BAKED and Claude Code files show where they come from", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  seed(projectFile(root), {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ ...command("./scripts/guard.sh"), timeout: 30 }] }],
      PostToolUse: [{ hooks: [{ ...command("./scripts/log.sh"), async: true, once: true }] }],
    },
  });
  seed(join(root, ".claude", "settings.json"), {
    hooks: { Stop: [{ hooks: [command("./scripts/notify.sh")] }] },
  });
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Hooks");
  await expect(page.getByText("3 hooks", { exact: true })).toBeVisible();
  await expect(page.getByText("2 in BAKED")).toBeVisible();
  await expect(page.getByText("1 from Claude Code")).toBeVisible();

  const guard = hookCard(page, "./scripts/guard.sh");
  await expect(guard).toContainText("for Bash");
  await expect(guard).toContainText("waits up to 30s");
  await expect(guard).toContainText("BAKED · this project");
  await expect(guard.getByRole("button", { name: "Edit hook" })).toBeVisible();

  const log = hookCard(page, "./scripts/log.sh");
  await expect(log).toContainText("background");
  await expect(log).toContainText("once per session");

  const notify = hookCard(page, "./scripts/notify.sh");
  await expect(notify).toContainText("Claude Code · this project · read-only");
  await expect(notify.getByRole("button", { name: "Edit hook" })).toHaveCount(0);
  await expect(notify.getByRole("button", { name: "Delete hook" })).toHaveCount(0);
  await expect(notify.getByRole("button", { name: "Copy to BAKED" })).toBeVisible();
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

test("hooks: editing a hook moves it to another event with a new command and matcher", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  seed(projectFile(root), {
    instructionFiles: ["agents"],
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [command("./scripts/guard.sh")] }] },
  });
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Hooks");
  await hookCard(page, "./scripts/guard.sh").getByRole("button", { name: "Edit hook" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit hook" });
  await expectBakedStyle(page);
  const commandField = dialog.getByRole("textbox", { name: /^Run this command/ });
  await expect(commandField).toHaveValue("./scripts/guard.sh");
  await expect(dialog.getByRole("textbox", { name: /^Only for these tool names/ })).toHaveValue(
    "Bash",
  );
  await expect(dialog.getByRole("button", { name: "Back to templates" })).toHaveCount(0);

  await choose(dialog, "When", /\(PostToolUse\)$/);
  await commandField.fill("bunx biome format --write");
  await dialog.getByRole("textbox", { name: /^Only for these tool names/ }).fill("Edit|Write");
  await dialog.getByRole("textbox", { name: "Timeout, seconds" }).fill("45");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByText("./scripts/guard.sh")).toHaveCount(0);
  const format = hookCard(page, "bunx biome format --write");
  await expect(format).toContainText("for Edit|Write");
  await expect(format).toContainText("waits up to 45s");
  const after = page
    .getByRole("list", { name: "Agent events" })
    .getByRole("listitem")
    .filter({
      has: page.getByRole("heading", { name: "After a tool succeeds", level: 3 }),
    })
    .last();
  await expect(after).toContainText("bunx biome format --write");

  expect(projectConfig(root)).toEqual({
    instructionFiles: ["agents"],
    hooks: {
      PostToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [{ type: "command", command: "bunx biome format --write", timeout: 45 }],
        },
      ],
    },
  });
  await page.reload();
  await expect(hookCard(page, "bunx biome format --write")).toContainText("for Edit|Write");
  await expect(page.getByText("./scripts/guard.sh")).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test("hooks: editing a hook with a hidden secret keeps the stored command", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const secret = 'curl -H "Authorization: Bearer s3cr3tvalue" https://hooks.example.com/done';
  seed(projectFile(root), { hooks: { Stop: [{ hooks: [command(secret)] }] } });
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Hooks");
  const shown = 'curl -H "Authorization: Bearer [redacted]" https://hooks.example.com/done';
  await expect(page.getByText("s3cr3tvalue")).toHaveCount(0);
  await hookCard(page, shown).getByRole("button", { name: "Edit hook" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit hook" });
  await expect(dialog.getByRole("textbox", { name: /^Run this command/ })).toHaveValue(shown);
  await expect(
    dialog.getByText("A secret in this command is hidden.", { exact: false }),
  ).toBeVisible();
  await dialog.getByRole("textbox", { name: "Timeout, seconds" }).fill("20");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  await expect(hookCard(page, shown)).toContainText("waits up to 20s");
  expect(projectConfig(root)).toEqual({
    hooks: { Stop: [{ hooks: [{ ...command(secret), timeout: 20 }] }] },
  });
  expect(dialogs).toEqual([]);
});

test("hooks: deleting one of several hooks keeps the others in the file", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  seed(projectFile(root), {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [command("./scripts/first.sh"), command("./scripts/second.sh")] },
      ],
      Stop: [{ hooks: [command("./scripts/done.sh")] }],
    },
  });
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Hooks");
  await hookCard(page, "./scripts/second.sh").getByRole("button", { name: "Delete hook" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete this hook?" });
  await expect(confirm).toContainText("./scripts/second.sh");
  await expect(confirm).toContainText(projectFile(root));
  await expectBakedStyle(page);
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(confirm).toBeHidden();

  await expect(page.getByText("./scripts/second.sh")).toHaveCount(0);
  await expect(hookCard(page, "./scripts/first.sh")).toBeVisible();
  await expect(hookCard(page, "./scripts/done.sh")).toBeVisible();
  await expect(page.getByText("2 hooks", { exact: true })).toBeVisible();
  expect(projectConfig(root)).toEqual({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [command("./scripts/first.sh")] }],
      Stop: [{ hooks: [command("./scripts/done.sh")] }],
    },
  });
  expect(dialogs).toEqual([]);
});

test("hooks: a hook saved for all projects goes to the home folder's config", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Hooks");
  await page.getByRole("button", { name: "Add a hook to Stop", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New hook" });
  await dialog.getByRole("textbox", { name: /^Run this command/ }).fill("./notify-me.sh");
  await dialog.getByRole("button", { name: "All my projects" }).click();
  await expect(dialog.getByText(userFile(workspace.dir))).toBeVisible();
  await dialog.getByRole("button", { name: "Add hook" }).click();
  await expect(dialog).toBeHidden();

  await expect(hookCard(page, "./notify-me.sh")).toContainText("BAKED · home folder");
  const home = readJson(userFile(workspace.dir));
  expect(home.defaultModel).toBe("openai/gpt-scripted");
  expect(home.hooks).toEqual({ Stop: [{ hooks: [command("./notify-me.sh")] }] });
  expect(existsSync(projectFile(root))).toBe(false);
  expect(dialogs).toEqual([]);
});

test("hooks: pausing an event changes no file", async ({ workspace, launch }) => {
  const root = workspace.project("gamma");
  seed(projectFile(root), { hooks: { Stop: [{ hooks: [command("./scripts/done.sh")] }] } });
  const before = readFileSync(projectFile(root), "utf8");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Hooks");
  await page.getByRole("switch", { name: "Pause Stop hooks" }).click();
  await expect(page.getByRole("switch", { name: "Resume Stop hooks" })).not.toBeChecked();
  await expect(page.getByText("paused", { exact: true })).toBeVisible();
  expect(readFileSync(projectFile(root), "utf8")).toBe(before);
  await page.getByRole("switch", { name: "Resume Stop hooks" }).click();
  await expect(page.getByRole("switch", { name: "Pause Stop hooks" })).toBeChecked();
  await expect(page.getByText("paused", { exact: true })).toHaveCount(0);
  expect(readFileSync(projectFile(root), "utf8")).toBe(before);
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

// --- MCP servers ----------------------------------------------------------------------------

const serverRow = (group: Locator, name: string): Locator =>
  group
    .getByRole("listitem")
    .filter({ has: group.page().getByRole("button", { name: `Remove ${name}`, exact: true }) });

test("mcp: a server seeded in the project config is edited: arguments and environment", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  seed(projectFile(root), {
    mcpServers: [
      { name: "notes", command: "bun", args: ["run", "notes.ts"], env: { NOTES_DIR: "notes" } },
      { name: "files", command: "bunx", args: ["files-mcp"] },
    ],
  });
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "MCP servers");
  const inProject = page.getByRole("region", { name: "In this project" });
  await expect(inProject.getByRole("heading", { name: "In this project · 2" })).toBeVisible();
  const notes = serverRow(inProject, "notes");
  await expect(notes).toContainText("bun run notes.ts · env NOTES_DIR");
  await expect(notes).toContainText("Not connected yet");
  await expectBakedStyle(page);

  await notes.getByRole("button", { name: "Edit notes" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit notes" });
  await expect(dialog.getByRole("textbox", { name: "Arguments" })).toHaveValue("run notes.ts");
  await expect(dialog.getByRole("textbox", { name: /^Environment/ })).toHaveValue(
    "NOTES_DIR=notes",
  );
  await expectBakedStyle(page);
  await dialog.getByRole("textbox", { name: "Arguments" }).fill('run notes.ts --root "my notes"');
  await dialog
    .getByRole("textbox", { name: /^Environment/ })
    .fill("NOTES_DIR=archive\nNOTES_TOKEN=abc123");
  await dialog.getByRole("textbox", { name: "Tool call timeout, s" }).fill("90");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Saved notes.")).toBeVisible();
  await expect(notes).toContainText('run notes.ts --root "my notes" · env NOTES_DIR, NOTES_TOKEN');

  expect(projectConfig(root).mcpServers).toEqual([
    {
      name: "notes",
      command: "bun",
      args: ["run", "notes.ts", "--root", "my notes"],
      env: { NOTES_DIR: "archive", NOTES_TOKEN: "abc123" },
      timeout: 90_000,
    },
    { name: "files", command: "bunx", args: ["files-mcp"] },
  ]);
  await page.reload();
  await expect(serverRow(inProject, "notes")).toContainText("env NOTES_DIR, NOTES_TOKEN");
  expect(dialogs).toEqual([]);
});

test("mcp: a global server is saved in the user config and moves to the project", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "MCP servers");
  const inProject = page.getByRole("region", { name: "In this project" });
  const global = page.getByRole("region", { name: "Global" });
  await expect(inProject.getByText("None yet.")).toBeVisible();
  await expect(global.getByText("None yet.")).toBeVisible();

  await page.getByRole("button", { name: "Add server" }).click();
  const dialog = page.getByRole("dialog", { name: "Add MCP server" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("search");
  const savedFor = dialog.getByRole("group", { name: "Saved for" });
  await savedFor.getByRole("button", { name: "All projects" }).click();
  await expect(dialog.getByText("Saved in your user config; every project gets it.")).toBeVisible();
  await dialog.getByRole("textbox", { name: "Command" }).fill("bunx");
  await dialog.getByRole("textbox", { name: "Arguments" }).fill("search-mcp");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(global.getByRole("heading", { name: "Global · 1" })).toBeVisible();
  await expect(inProject.getByRole("heading", { name: "In this project · 0" })).toBeVisible();

  const home = readJson(userFile(workspace.dir));
  expect(home.defaultModel).toBe("openai/gpt-scripted");
  expect(home.mcpServers).toEqual([{ name: "search", command: "bunx", args: ["search-mcp"] }]);
  expect(projectConfig(root).mcpServers).toBeUndefined();

  await serverRow(global, "search").getByRole("button", { name: "Edit search" }).click();
  const edit = page.getByRole("dialog", { name: "Edit search" });
  await edit
    .getByRole("group", { name: "Saved for" })
    .getByRole("button", {
      name: "This project",
    })
    .click();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(inProject.getByRole("heading", { name: "In this project · 1" })).toBeVisible();
  await expect(global.getByRole("heading", { name: "Global · 0" })).toBeVisible();
  expect(readJson(userFile(workspace.dir)).mcpServers ?? []).toEqual([]);
  expect(projectConfig(root).mcpServers).toEqual([
    { name: "search", command: "bunx", args: ["search-mcp"] },
  ]);
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

test("mcp: a project server with a global server's name replaces it until renamed", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "MCP servers");
  const add = async (name: string, scope: "This project" | "All projects") => {
    await page.getByRole("button", { name: "Add server" }).click();
    const dialog = page.getByRole("dialog", { name: "Add MCP server" });
    await dialog.getByRole("textbox", { name: "Name" }).fill(name);
    await dialog
      .getByRole("group", { name: "Saved for" })
      .getByRole("button", { name: scope })
      .click();
    await dialog.getByRole("textbox", { name: "Command" }).fill("bunx");
    await dialog.getByRole("textbox", { name: "Arguments" }).fill(`${name}-mcp`);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
  };
  await add("search", "All projects");
  await add("search", "This project");
  const inProject = page.getByRole("region", { name: "In this project" });
  const global = page.getByRole("region", { name: "Global" });
  await expect(serverRow(inProject, "search")).toContainText("replaces global");
  // The global server stays listed, greyed out, as replaced here.
  await expect(global.getByRole("heading", { name: "Global · 1" })).toBeVisible();
  await expect(global.getByText("replaced here")).toBeVisible();

  await serverRow(inProject, "search").getByRole("button", { name: "Remove search" }).click();
  const remove = page.getByRole("dialog", { name: "Remove search?" });
  await expect(remove).toContainText("The global server with the same name takes its place.");
  await remove.getByRole("button", { name: "Cancel" }).click();
  await expect(remove).toBeHidden();

  await serverRow(inProject, "search").getByRole("button", { name: "Edit search" }).click();
  const edit = page.getByRole("dialog", { name: "Edit search" });
  await edit.getByRole("textbox", { name: "Name" }).fill("search-local");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(serverRow(inProject, "search-local")).not.toContainText("replaces global");
  await expect(global.getByRole("heading", { name: "Global · 1" })).toBeVisible();
  await expect(global.getByText("replaced here")).toHaveCount(0);
  expect(projectConfig(root).mcpServers).toEqual([
    { name: "search-local", command: "bunx", args: ["search-mcp"] },
  ]);
  expect(readJson(userFile(workspace.dir)).mcpServers).toEqual([
    { name: "search", command: "bunx", args: ["search-mcp"] },
  ]);
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

test("mcp: the form refuses a bad name, a missing command or URL, bad pairs and a duplicate", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  seed(projectFile(root), { mcpServers: [{ name: "notes", command: "bun" }] });
  const before = readFileSync(projectFile(root), "utf8");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "MCP servers");
  await page.getByRole("button", { name: "Add server" }).click();
  const dialog = page.getByRole("dialog", { name: "Add MCP server" });
  const save = dialog.getByRole("button", { name: "Save" });
  const problem = (text: string | RegExp) =>
    expect(dialog.getByRole("alert").filter({ hasText: text })).toBeVisible();

  await save.click();
  await problem(/^Name: 1-64 letters/);
  await dialog.getByRole("textbox", { name: "Name" }).fill("my server");
  await save.click();
  await problem(/^Name: 1-64 letters/);
  await dialog.getByRole("textbox", { name: "Name" }).fill("notes");
  await save.click();
  await problem("A stdio server needs a command");
  await dialog.getByRole("textbox", { name: "Command" }).fill("bunx");
  await dialog.getByRole("textbox", { name: /^Environment/ }).fill("TOKEN");
  await save.click();
  await problem('Environment: write each one as KEY=value ("TOKEN")');
  await dialog.getByRole("textbox", { name: /^Environment/ }).fill("");
  await dialog.getByRole("textbox", { name: "Tool call timeout, s" }).fill("0");
  await save.click();
  await problem("Timeout: seconds from 1 to 3600");
  await dialog.getByRole("textbox", { name: "Tool call timeout, s" }).fill("");

  await dialog
    .getByRole("group", { name: "Transport" })
    .getByRole("button", { name: "HTTP" })
    .click();
  await dialog.getByRole("textbox", { name: "URL" }).fill("ftp://example.com");
  await save.click();
  await problem("Enter the server's http(s) URL");
  await dialog
    .getByRole("group", { name: "Transport" })
    .getByRole("button", { name: "Command" })
    .click();
  await expectBakedStyle(page);

  // The name is taken in this project: the backend refuses it and the dialog stays open.
  await save.click();
  await problem("A project MCP server named notes already exists");
  await expect(dialog).toBeVisible();
  expect(readFileSync(projectFile(root), "utf8")).toBe(before);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  const inProject = page.getByRole("region", { name: "In this project" });
  await expect(inProject.getByRole("heading", { name: "In this project · 1" })).toBeVisible();
  expect(readFileSync(projectFile(root), "utf8")).toBe(before);
  expect(dialogs).toEqual([]);
});

test("mcp: a server turned off is kept off in the file, and a failing one shows why", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  seed(projectFile(root), {
    mcpServers: [
      { name: "notes", command: "bun", args: ["run", "notes.ts"] },
      { name: "broken", command: "./no-such-mcp-server" },
    ],
  });
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "MCP servers");
  const inProject = page.getByRole("region", { name: "In this project" });
  const notes = serverRow(inProject, "notes");
  await notes.getByRole("switch", { name: "Turn off notes" }).click();
  await expect(page.getByText("Turned off notes.")).toBeVisible();
  await expect(notes).toContainText("Off");
  await expect(notes.getByRole("button", { name: /^Connect|^Reconnect/ })).toHaveCount(0);
  expect((projectConfig(root).mcpServers as Json[])[0]).toEqual({
    name: "notes",
    command: "bun",
    args: ["run", "notes.ts"],
    disabled: true,
  });
  await page.reload();
  await expect(
    serverRow(inProject, "notes").getByRole("switch", { name: "Turn on notes" }),
  ).not.toBeChecked();

  const broken = serverRow(inProject, "broken");
  await broken.getByRole("button", { name: "Connect" }).click();
  await expect(broken).toContainText("Failed", { timeout: 20_000 });
  await expect(broken.getByRole("button", { name: "Reconnect" })).toBeVisible();
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

// --- Gates and checks -----------------------------------------------------------------------

const check = (id: string, executable: string, args: string[], extra: Json = {}): Json => ({
  id,
  executable,
  args,
  cwd: ".",
  timeoutMs: 60_000,
  required: true,
  scope: "feature",
  envNames: [],
  writes: [],
  ...extra,
});

const seedChecks = (root: string, checks: Json[]) =>
  seed(projectFile(root), { workflows: { enabled: true, policy: { checks } } });

const checksOnDisk = (root: string): Json[] =>
  (((projectConfig(root).workflows as Json | undefined)?.policy as Json | undefined)?.checks ??
    []) as Json[];

const gateButton = (page: Page, id: string): Locator =>
  page
    .getByRole("region", { name: "Gates", exact: true })
    .getByRole("button", { name: new RegExp(`\\b${id}\\b`) });

test("checks: a seeded check is edited and renamed, and the old one is gone", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  seedChecks(root, [check("lint", "bun", ["run", "lint"])]);
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Gates and checks");
  await gateButton(page, "lint").click();
  const form = page.getByRole("form", { name: "Edit lint" });
  await expect(form.getByRole("textbox", { name: "ID" })).toHaveValue("lint");
  await expect(form.getByRole("textbox", { name: "Command" })).toHaveValue("bun run lint");
  await expectBakedStyle(page);

  await form.getByRole("textbox", { name: "ID" }).fill("biome");
  await form.getByRole("textbox", { name: "Command" }).fill('bunx biome check "src dir"');
  await form.getByRole("textbox", { name: "Timeout, s" }).fill("120");
  await form
    .getByRole("group", { name: "Required" })
    .getByRole("button", { name: "advisory" })
    .click();
  await form.getByRole("group", { name: "Scope" }).getByRole("button", { name: "task" }).click();
  await form.getByRole("textbox", { name: "Env names passed through" }).fill("CI, HOME");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("form", { name: "Edit biome" })).toBeVisible();

  await expect(gateButton(page, "lint")).toHaveCount(0);
  await expect(gateButton(page, "biome")).toContainText("advisory");
  expect(checksOnDisk(root)).toEqual([
    check("biome", "bunx", ["biome", "check", "src dir"], {
      timeoutMs: 120_000,
      required: false,
      scope: "task",
      envNames: ["CI", "HOME"],
    }),
  ]);
  await page.reload();
  await expect(gateButton(page, "biome")).toBeVisible();
  await expect(gateButton(page, "lint")).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test("checks: deleting one of two checks keeps the other", async ({ workspace, launch }) => {
  const root = workspace.project("gamma");
  seedChecks(root, [check("lint", "bun", ["run", "lint"]), check("test", "bun", ["test"])]);
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Gates and checks");
  await gateButton(page, "lint").click();
  await page
    .getByRole("form", { name: "Edit lint" })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(gateButton(page, "lint")).toHaveCount(0);
  await expect(gateButton(page, "test")).toBeVisible();
  expect(checksOnDisk(root)).toEqual([check("test", "bun", ["test"])]);
  await page.reload();
  await expect(gateButton(page, "lint")).toHaveCount(0);
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

test("checks: the form refuses a bad or taken ID, an empty command and a bad timeout", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Gates and checks");
  // A fresh project lists only BAKED's built-in review gates.
  const gates = page.getByRole("region", { name: "Gates", exact: true });
  await expect(gates.getByRole("button")).toHaveCount(2);
  await expect(gateButton(page, "correctness-review")).toContainText("built in");
  await expect(gateButton(page, "security-review")).toContainText("built in");

  await page.getByRole("button", { name: "New check" }).click();
  const form = page.getByRole("form", { name: "New check" });
  await expectBakedStyle(page);
  const save = form.getByRole("button", { name: "Save" });
  const problem = (text: string) =>
    expect(page.getByRole("alert").filter({ hasText: text })).toBeVisible();

  await form.getByRole("textbox", { name: "Command" }).fill("bun test");
  await save.click();
  await problem("ID: letters, digits, '-' and '_', starting with a letter or digit");
  await form.getByRole("textbox", { name: "ID" }).fill("-lint");
  await save.click();
  await problem("ID: letters, digits, '-' and '_', starting with a letter or digit");
  await form.getByRole("textbox", { name: "ID" }).fill("correctness-review");
  await save.click();
  await problem("A gate named correctness-review exists already.");
  await form.getByRole("textbox", { name: "ID" }).fill("unit");
  await form.getByRole("textbox", { name: "Command" }).fill("   ");
  await save.click();
  await problem("Enter the command to run");
  await form.getByRole("textbox", { name: "Command" }).fill("bun test");
  await form.getByRole("textbox", { name: "Timeout, s" }).fill("0");
  await save.click();
  await problem("Timeout: whole seconds from 1 to 3600");
  await form.getByRole("textbox", { name: "Timeout, s" }).fill("60");
  await form.getByRole("textbox", { name: "Directory" }).fill("../outside");
  await save.click();
  await problem("Directory: a path inside the project, like . or packages/api");
  await expect(form).toBeVisible();
  expect(existsSync(projectFile(root))).toBe(false);
  await expect(gates.getByRole("button")).toHaveCount(2);
  expect(dialogs).toEqual([]);
});

test("checks: a failing check shows its exit code and output", async ({ workspace, launch }) => {
  const root = workspace.project("gamma");
  writeFileSync(join(root, "fail.sh"), "echo 'lint found 2 problems' >&2\nexit 3\n");
  seedChecks(root, [check("lint", "sh", ["fail.sh"])]);
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Gates and checks");
  await gateButton(page, "lint").click();
  const form = page.getByRole("form", { name: "Edit lint" });
  await form.getByRole("button", { name: "Run now" }).click();
  const result = form.getByRole("region", { name: "Last result" });
  await expect(result).toContainText(/failed · exit 3/, { timeout: 20_000 });
  await expect(result).toContainText("lint found 2 problems");
  await expect(gateButton(page, "lint")).toContainText(/failed · exit 3/);
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

test("gates: a gate set up from a sentence is saved, confirmed and added to a workflow", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  // A workflow's checks stage needs a check before gates can be placed in it.
  seedChecks(root, [check("unit", "bun", ["test"])]);
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Gates and checks");
  await page.getByRole("button", { name: "Set up a gate…" }).click();
  const dialog = page.getByRole("dialog", { name: "Set up a gate" });
  const steps = dialog.getByRole("list", { name: "Steps" });
  await expect(steps.getByRole("listitem").filter({ hasText: "1. Kind" })).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expectBakedStyle(page);
  await dialog.getByRole("button", { name: /^Ask a person/ }).click();
  await expect(dialog.getByRole("button", { name: /^Ask a person/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await dialog.getByRole("button", { name: "Next" }).click();

  const text = dialog.getByRole("textbox", { name: /describe the check in plain words$/ });
  const draft = dialog.getByRole("button", { name: "Draft the gate" });
  await expect(draft).toBeDisabled();
  await text.fill("   ");
  await expect(draft).toBeDisabled();
  await text.fill("Product owner signs off the help text");
  await expectBakedStyle(page);
  await draft.click();

  await expect(dialog.getByText("The person is asked")).toBeVisible();
  await expect(dialog.getByText("Product owner signs off the help text").first()).toBeVisible();
  await expectBakedStyle(page);
  // Nothing is written until the draft is saved.
  expect(existsSync(join(root, "baked", "gates"))).toBe(false);
  await dialog.getByRole("button", { name: "Save gate" }).click();

  await expect(steps.getByRole("listitem").filter({ hasText: "4. Where" })).toHaveAttribute(
    "aria-current",
    "step",
  );
  const files = readdirSync(join(root, "baked", "gates"));
  expect(files).toHaveLength(1);
  const id = (files[0] ?? "").replace(/\.json$/, "");
  const gate = readJson(join(root, "baked", "gates", `${id}.json`));
  expect(gate.id).toBe(id);
  expect(gate.type).toBe("human");
  // Saving it here is the confirmation: runs use it in this checkout without asking again.
  const confirmations = readJson(join(root, ".baked", "gate-confirmations.json"));
  expect(Object.keys(confirmations.gates as Json)).toEqual([id]);

  await choose(dialog, "Workflow", "sdd");
  await expectBakedStyle(page);
  const where = dialog.getByRole("group", { name: "Where it runs" });
  await expect(where.getByRole("button", { pressed: true })).toHaveCount(1);
  await dialog.getByRole("button", { name: "Add to workflow" }).click();
  const bound = dialog.getByRole("status");
  await expect(bound).toContainText(`${id} runs in`);
  const workflowFiles = readdirSync(join(root, "baked", "workflows"));
  expect(workflowFiles.length).toBeGreaterThan(0);
  expect(
    workflowFiles.some((f) =>
      readFileSync(join(root, "baked", "workflows", f), "utf8").includes(id),
    ),
  ).toBe(true);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  await expect(gateButton(page, id)).toContainText("human");
  await expect(page.getByRole("region", { name: `Confirm ${id}` })).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test("gates: a gate that came with the repository waits for confirmation", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  seed(join(root, "baked", "gates", "signoff.json"), {
    schemaVersion: 1,
    id: "signoff",
    description: "Product owner signs off the release",
    required: true,
    scope: "transition",
    timeoutMs: 3_600_000,
    retries: { max: 0, retryOn: [] },
    evidence: { kind: "decision", keepOutputLines: 0, artifactPaths: [] },
    type: "human",
    human: { prompt: "Sign off the release", answer: "approve", bindsDigest: true },
  });
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Gates and checks");
  const banner = page.getByRole("region", { name: "Confirm signoff" });
  await expect(banner).toContainText("signoff came with the repository");
  await expect(gateButton(page, "signoff")).toContainText("not confirmed");

  await banner.getByRole("button", { name: "Inspect" }).click();
  const details = page.getByRole("region", { name: "Gate signoff" });
  await expect(details).toContainText(join("baked", "gates", "signoff.json"));
  await expect(details.getByRole("button", { name: "Confirm" })).toBeVisible();
  await expectBakedStyle(page);
  expect(existsSync(join(root, ".baked", "gate-confirmations.json"))).toBe(false);

  await banner.getByRole("button", { name: "Confirm" }).click();
  await expect(banner).toHaveCount(0);
  await expect(gateButton(page, "signoff")).not.toContainText("not confirmed");
  await expect(details.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  const confirmations = readJson(join(root, ".baked", "gate-confirmations.json"));
  expect(Object.keys(confirmations.gates as Json)).toEqual(["signoff"]);

  // A changed definition needs the confirmation again.
  const file = join(root, "baked", "gates", "signoff.json");
  const changed = readJson(file);
  seed(file, { ...changed, description: "Product owner and QA sign off the release" });
  await page.reload();
  await expect(page.getByRole("region", { name: "Confirm signoff" })).toBeVisible();
  expect(dialogs).toEqual([]);
});

test("gates: a gate file that does not parse is reported and not listed", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  seed(join(root, "baked", "gates", "broken.json"), { id: "broken", type: "human" });
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Gates and checks");
  await expect(page.getByRole("alert")).toContainText(
    `Not used, could not be read: ${join(root, "baked", "gates", "broken.json")}`,
  );
  await expect(gateButton(page, "broken")).toHaveCount(0);
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

test("gates: placing a gate in a workflow without checks is refused and writes no workflow", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Gates and checks");
  await page.getByRole("button", { name: "Set up a gate…" }).click();
  const dialog = page.getByRole("dialog", { name: "Set up a gate" });
  await dialog.getByRole("button", { name: /^Ask a person/ }).click();
  await dialog.getByRole("button", { name: "Next" }).click();
  await dialog
    .getByRole("textbox", { name: /describe the check in plain words$/ })
    .fill("QA signs off the release");
  await dialog.getByRole("button", { name: "Draft the gate" }).click();
  await dialog.getByRole("button", { name: "Save gate" }).click();
  await dialog.getByRole("button", { name: "Add to workflow" }).click();
  await expect(dialog.getByRole("alert")).toContainText("The checks stage has no checks yet");
  await expectBakedStyle(page);
  expect(existsSync(join(root, "baked", "workflows"))).toBe(false);

  // The gate itself is saved; it can be placed later.
  await dialog.getByRole("button", { name: "Later" }).click();
  await expect(dialog).toBeHidden();
  const [file] = readdirSync(join(root, "baked", "gates"));
  await expect(gateButton(page, (file ?? "").replace(/\.json$/, ""))).toContainText("human");
  expect(dialogs).toEqual([]);
});
