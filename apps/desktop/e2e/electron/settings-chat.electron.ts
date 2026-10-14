import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { choose, expectBakedStyle, failOnNativeDialogs } from "./baked-style.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Settings > Chat against the repository's own `baked serve`: every page of the backend's settings
 * schema, each kind of control, the file a change lands in (~/.baked/config.json for All projects,
 * the project's .baked/config.json for This project), reloads, resets and refused values.
 */

const PAGES = [
  "Chat model",
  "Provider options",
  "Chat router",
  "Tools",
  "Agent features",
  "Baked map",
  "Compaction",
  "Timeouts and limits",
  "Code quality",
  "Coordinator",
] as const;

/** No model is needed: a script with no turns runs the real backend. */
const backend = { script: { turns: [] } };

const readJson = (file: string): Record<string, unknown> =>
  existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
const globalFile = (dir: string) => join(dir, "home", ".baked", "config.json");
const projectFile = (root: string) => join(root, ".baked", "config.json");

/** Opens the project so its backend runs, then the chat settings page named `title`. */
async function openSettings(page: Page, title: (typeof PAGES)[number], project = "gamma") {
  await page.getByRole("article", { name: project }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await openPage(page, title);
}

async function openPage(page: Page, title: (typeof PAGES)[number]) {
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: title, exact: true })
    .click();
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  // The rows come from GET /v1/settings; the scope tabs show once it answered.
  await expect(page.getByRole("tab", { name: "All projects" })).toBeVisible();
}

/** Reloads the window and waits for the same page to show its saved values again. */
async function reload(page: Page, title: (typeof PAGES)[number]) {
  await page.reload();
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "All projects" })).toBeVisible();
}

const row = (page: Page, label: string) => page.getByRole("group", { name: label, exact: true });

async function thisProject(page: Page) {
  await page.getByRole("tab", { name: "This project" }).click();
  await expect(page.getByText("in .baked/config.json", { exact: false })).toBeVisible();
}

/**
 * Types a model ID and closes the model list the typing opened, as a user does before Save: the
 * list sits in the dialog's flow, so it would move Save away under the pointer.
 */
async function typeModel(field: Locator, model: string) {
  await field.fill(model);
  if ((await field.getAttribute("aria-expanded")) === "true") await field.press("Escape");
  await expect(field).toHaveAttribute("aria-expanded", "false");
}

/** `GET /v1/settings` of the open project through the app's own bridge. */
async function settingsValue(page: Page, id: string): Promise<unknown> {
  const href = await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /^G gamma/ })
    .getAttribute("href");
  const key = /#\/p\/([^/]+)/.exec(href ?? "")?.[1];
  expect(key, "project key in the sidebar link").toBeTruthy();
  return page.evaluate(
    async ([projectKey, settingId]) => {
      const bridge = (
        window as unknown as {
          baked: {
            request: (
              key: string,
              method: string,
              path: string,
            ) => Promise<{ status: number; body: { values: Record<string, unknown> } }>;
          };
        }
      ).baked;
      const answer = await bridge.request(projectKey as string, "GET", "/v1/settings");
      return answer.body.values[settingId as string];
    },
    [key, id],
  );
}

test("without an open project the chat settings say how to see them", async ({ launch }) => {
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "Compaction", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Chat settings", level: 1 })).toBeVisible();
  await expect(page.getByText(/Open a project to see these settings/)).toBeVisible();
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

test("every chat settings page opens with its sections and BAKED controls", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openSettings(page, "Chat model");
  for (const title of PAGES) {
    await openPage(page, title);
    await expect(page.getByRole("region").first()).toBeVisible();
    await expect(page.getByText("in ~/.baked/config.json")).toBeVisible();
    await expectBakedStyle(page);
  }
  expect(dialogs).toEqual([]);
});

test("a switch saves to all projects, survives a reload and resets to the default", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openSettings(page, "Agent features");
  const reviewer = row(page, "Approval reviewer");
  const toggle = reviewer.getByRole("switch", { name: "Approval reviewer" });
  await expect(toggle).not.toBeChecked();
  await expect(reviewer.getByText("default", { exact: true })).toBeVisible();
  await expect(reviewer.getByRole("button", { name: "Reset", exact: true })).toHaveCount(0);

  await toggle.click();
  await expect(page.getByRole("status")).toContainText("Approval reviewer on in All projects");
  await expect(toggle).toBeChecked();
  expect(readJson(globalFile(workspace.dir)).agentFeatures).toEqual({ approvalReview: true });
  // The model the harness seeded stays next to it.
  expect(readJson(globalFile(workspace.dir)).defaultModel).toBe("openai/gpt-scripted");
  expect(existsSync(projectFile(root))).toBe(false);

  await reload(page, "Agent features");
  await expect(toggle).toBeChecked();
  await expect(reviewer.getByText("all projects", { exact: true })).toBeVisible();
  expect(await settingsValue(page, "agentFeatures.approvalReview")).toMatchObject({
    value: true,
    source: "global",
  });

  await reviewer.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await expect(reviewer.getByText("default", { exact: true })).toBeVisible();
  // Reset leaves no empty `agentFeatures: {}` behind.
  expect(readJson(globalFile(workspace.dir))).toEqual({ defaultModel: "openai/gpt-scripted" });
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

test("This project writes the project config and wins over all projects", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openSettings(page, "Agent features");
  const toggle = row(page, "De-sloppify").getByRole("switch", { name: "De-sloppify" });
  await toggle.click();
  await expect(toggle).toBeChecked();

  await thisProject(page);
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(page.getByRole("status")).toContainText("De-sloppify off in gamma");
  await expect(toggle).not.toBeChecked();
  expect(readJson(projectFile(root)).agentFeatures).toEqual({ desloppify: false });
  expect(readJson(globalFile(workspace.dir)).agentFeatures).toEqual({ desloppify: true });
  await expect(row(page, "De-sloppify").getByText("this project", { exact: true })).toBeVisible();
  expect(await settingsValue(page, "agentFeatures.desloppify")).toMatchObject({
    value: false,
    source: "project",
    global: true,
    project: false,
  });

  // Resetting the project value lets all projects apply again.
  await row(page, "De-sloppify").getByRole("button", { name: "Reset", exact: true }).click();
  await expect(toggle).toBeChecked();
  await expect(row(page, "De-sloppify").getByText("all projects", { exact: true })).toBeVisible();
  expect(readJson(projectFile(root)).agentFeatures).toBeUndefined();
  expect(readJson(globalFile(workspace.dir)).agentFeatures).toEqual({ desloppify: true });
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

test("a setting saved for all projects only is locked on This project", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openSettings(page, "Timeouts and limits");
  await thisProject(page);
  const timeout = row(page, "Tool timeout");
  await expect(timeout.getByText("Saved for all projects only")).toBeVisible();
  await expect(timeout.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();
  await expect(row(page, "Watchdog").getByRole("switch", { name: "Watchdog" })).toBeDisabled();
  // Cost cap is saved per project too.
  await expect(
    row(page, "Cost cap").getByRole("button", { name: "Edit", exact: true }),
  ).toBeEnabled();
  expect(existsSync(projectFile(root))).toBe(false);
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

test("a number is saved in its display unit, refused out of range, and reset", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openSettings(page, "Timeouts and limits");
  const wait = row(page, "Edit diagnostics wait");
  await expect(wait.getByText("2.5 s")).toBeVisible();
  await wait.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit diagnostics wait" });
  const field = dialog.getByRole("textbox", { name: "Edit diagnostics wait (s)" });
  await expect(field).toHaveValue("2.5");
  await expectBakedStyle(page);

  for (const [typed, error] of [
    ["31", "Between 0.25 s and 30 s"],
    ["0.1", "Between 0.25 s and 30 s"],
    ["soon", "Enter a number"],
  ] as const) {
    await field.fill(typed);
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toHaveAccessibleDescription(error);
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  }
  await field.press("Enter");
  await expect(dialog).toBeVisible();
  expect(readJson(globalFile(workspace.dir)).diagnostics).toBeUndefined();

  await field.fill("5");
  await expect(field).not.toHaveAttribute("aria-invalid", "true");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(wait.getByText("5 s")).toBeVisible();
  expect(readJson(globalFile(workspace.dir)).diagnostics).toEqual({ timeoutMs: 5000 });

  await reload(page, "Timeouts and limits");
  await expect(wait.getByText("5 s")).toBeVisible();
  await wait.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(wait.getByText("2.5 s")).toBeVisible();
  expect(readJson(globalFile(workspace.dir)).diagnostics).toBeUndefined();
  expect(dialogs).toEqual([]);
});

test("a whole-number setting refuses fractions and an empty cost cap means none", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openSettings(page, "Compaction");
  const keep = row(page, "Keep recent messages");
  await keep.getByRole("button", { name: "Edit", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Keep recent messages" });
  let field = dialog.getByRole("textbox", { name: "Keep recent messages" });
  await field.fill("2.5");
  await expect(field).toHaveAccessibleDescription("Enter a whole number");
  await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  await field.fill("");
  await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  await field.fill("12");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(keep.getByText("12", { exact: true })).toBeVisible();
  expect(readJson(globalFile(workspace.dir)).compaction).toEqual({ keepRecent: 12 });

  await openPage(page, "Timeouts and limits");
  await thisProject(page);
  const cap = row(page, "Cost cap");
  await expect(cap.getByText("none", { exact: true })).toBeVisible();
  await cap.getByRole("button", { name: "Edit", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Cost cap" });
  field = dialog.getByRole("textbox", { name: "Cost cap (USD)" });
  await field.fill("0");
  await expect(field).toHaveAccessibleDescription("Between 0.01 USD and 100,000 USD");
  await field.fill("12.5");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(cap.getByText("12.5 USD")).toBeVisible();
  expect(readJson(projectFile(root)).runBudget).toEqual({ maxCostUsd: 12.5 });

  // Empty is the nullable setting's "none": the key leaves the file.
  await cap.getByRole("button", { name: "Edit", exact: true }).click();
  await field.fill("");
  await expect(field).not.toHaveAttribute("aria-invalid", "true");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(cap.getByText("none", { exact: true })).toBeVisible();
  expect(readJson(projectFile(root)).runBudget).toBeUndefined();
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

test("a choice saves, dims the settings it turns off, and resets", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openSettings(page, "Compaction");
  await thisProject(page);
  const kept = row(page, "Tool results kept");
  await expect(kept.getByText(/^Used when/)).toHaveCount(0);

  await choose(row(page, "Strategy"), "Strategy", /^Summarize/);
  await expect(page.getByRole("status")).toContainText("Saved Strategy in gamma");
  expect(readJson(projectFile(root)).compaction).toEqual({ strategy: "v1" });
  await expect(kept.getByText("Used when Strategy is Incremental")).toBeVisible();
  await expect(row(page, "Compact at").getByText(/^Used when/)).toHaveCount(0);

  await choose(row(page, "Strategy"), "Strategy", /^Off/);
  await expect(
    row(page, "Compact at").getByText("Used when Strategy is Summarize or Incremental"),
  ).toBeVisible();
  expect(readJson(projectFile(root)).compaction).toEqual({ strategy: "disabled" });

  await reload(page, "Compaction");
  await thisProject(page);
  await expect(row(page, "Strategy").getByRole("combobox", { name: "Strategy" })).toHaveValue(
    "disabled",
  );
  expect(await settingsValue(page, "compaction.strategy")).toMatchObject({
    value: "disabled",
    source: "project",
  });
  await row(page, "Strategy").getByRole("button", { name: "Reset", exact: true }).click();
  await expect(row(page, "Strategy").getByRole("combobox", { name: "Strategy" })).toHaveValue(
    "v2",
  );
  expect(readJson(projectFile(root)).compaction).toBeUndefined();
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

test("the default chat model is typed, kept, refused when too long, and unset", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openSettings(page, "Chat model");
  await thisProject(page);
  const model = row(page, "Default chat model");
  await expect(model.getByText("openai/gpt-scripted")).toBeVisible();
  await expect(model.getByText("all projects", { exact: true })).toBeVisible();

  await model.getByRole("button", { name: "Change", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Default chat model" });
  const field = dialog.getByRole("combobox", { name: "Model" });
  await expectBakedStyle(page);
  await typeModel(field, `openai/${"x".repeat(200)}`);
  await dialog.getByRole("button", { name: "Save" }).click();
  // The backend's refusal shows in the dialog, not behind it.
  await expect(dialog.getByRole("alert")).toContainText(
    "Default chat model: Too big: expected string to have <=200 characters",
  );
  await expect(dialog).toBeVisible();
  expect(existsSync(projectFile(root))).toBe(false);

  await typeModel(field, "anthropic/claude-test");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(model.getByText("anthropic/claude-test")).toBeVisible();
  expect(readJson(projectFile(root)).defaultModel).toBe("anthropic/claude-test");
  expect(readJson(globalFile(workspace.dir)).defaultModel).toBe("openai/gpt-scripted");

  await reload(page, "Chat model");
  await thisProject(page);
  await expect(model.getByText("anthropic/claude-test")).toBeVisible();
  // An empty model unsets it here, so all projects' model applies again.
  await model.getByRole("button", { name: "Change", exact: true }).click();
  await typeModel(field, "   ");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(model.getByText("openai/gpt-scripted")).toBeVisible();
  expect(readJson(projectFile(root)).defaultModel).toBeUndefined();
  expect(dialogs).toEqual([]);
});

test("the library docs source checks its fields before it saves", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openSettings(page, "Code quality");
  await thisProject(page);
  const docs = row(page, "Library docs source");
  await expect(docs.getByText("not set")).toBeVisible();
  await docs.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Library docs source" });
  const save = dialog.getByRole("button", { name: "Save" });
  await choose(dialog, "Source", "Directory of Markdown files");
  await expectBakedStyle(page);
  await expect(dialog.getByRole("alert")).toHaveText("Name the directory.");
  await expect(save).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Directory" }).fill("docs/libraries");
  await dialog.getByRole("textbox", { name: "Max characters per library" }).fill("100");
  await expect(dialog.getByRole("alert")).toHaveText(
    "Max characters is a whole number from 500 to 50000.",
  );
  await expect(save).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Max characters per library" }).fill("4000");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await save.click();
  await expect(dialog).toBeHidden();
  await expect(docs.getByText("directory docs/libraries")).toBeVisible();
  expect(readJson(projectFile(root)).libraryDocs).toEqual({
    dir: "docs/libraries",
    maxChars: 4000,
  });

  await docs.getByRole("button", { name: "Edit", exact: true }).click();
  await choose(dialog, "Source", "MCP tool");
  await dialog.getByRole("textbox", { name: "Server" }).fill("context7");
  await dialog.getByRole("textbox", { name: "Tool" }).fill("get-docs");
  await dialog.getByRole("textbox", { name: "Arguments" }).fill("libraryName={name}\nbroken");
  await expect(dialog.getByRole("alert")).toHaveText("Write each argument as key=value: broken");
  await expect(save).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Arguments" }).fill("libraryName={name}");
  await save.click();
  await expect(dialog).toBeHidden();
  await expect(docs.getByText("MCP context7 / get-docs")).toBeVisible();
  expect(readJson(projectFile(root)).libraryDocs).toEqual({
    mcp: { server: "context7", tool: "get-docs", args: { libraryName: "{name}" } },
    maxChars: 4000,
  });

  await reload(page, "Code quality");
  await thisProject(page);
  await expect(docs.getByText("MCP context7 / get-docs")).toBeVisible();
  await docs.getByRole("button", { name: "Edit", exact: true }).click();
  await choose(dialog, "Source", "None");
  await save.click();
  await expect(dialog).toBeHidden();
  await expect(docs.getByText("not set")).toBeVisible();
  expect(readJson(projectFile(root)).libraryDocs).toBeUndefined();
  expect(dialogs).toEqual([]);
});

test("a tool switched off joins the default disabled tools", async ({ workspace, launch }) => {
  workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openSettings(page, "Tools");
  const tools = row(page, "Available tools");
  await tools.getByRole("switch", { name: "shell", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("shell off in All projects");
  expect(readJson(globalFile(workspace.dir)).disabledTools).toEqual([
    "request_tools",
    "release_tools",
    "skills",
    "shell",
  ]);
  await tools.getByRole("switch", { name: "skills", exact: true }).click();
  await expect(tools.getByRole("switch", { name: "skills", exact: true })).toBeChecked();
  expect(readJson(globalFile(workspace.dir)).disabledTools).toEqual([
    "request_tools",
    "release_tools",
    "shell",
  ]);

  await reload(page, "Tools");
  await expect(tools.getByRole("switch", { name: "shell", exact: true })).not.toBeChecked();
  await expect(tools.getByRole("switch", { name: "skills", exact: true })).toBeChecked();
  await tools.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(tools.getByRole("switch", { name: "shell", exact: true })).toBeChecked();
  await expect(tools.getByRole("switch", { name: "skills", exact: true })).not.toBeChecked();
  expect(readJson(globalFile(workspace.dir)).disabledTools).toBeUndefined();
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

test("a context window override is checked, added and removed", async ({ workspace, launch }) => {
  workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openSettings(page, "Timeouts and limits");
  const overrides = row(page, "Context window overrides");
  await expect(overrides.getByText("None yet.")).toBeVisible();
  await overrides.getByRole("button", { name: "Add override" }).click();
  const dialog = page.getByRole("dialog", { name: "Context window overrides" });
  const save = dialog.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  await typeModel(dialog.getByRole("combobox", { name: "Model" }), "local/llama-test");
  const tokens = dialog.getByRole("textbox", { name: "Context window (tokens)" });
  await tokens.fill("500");
  await expect(tokens).toHaveAttribute("aria-invalid", "true");
  await expect(tokens).toHaveAccessibleDescription("A whole number from 1,000 to 10,000,000.");
  await expect(save).toBeDisabled();
  await expectBakedStyle(page);
  await tokens.fill("128,000");
  await save.click();
  await expect(dialog).toBeHidden();
  await expect(overrides.getByText("128,000 tokens")).toBeVisible();
  expect(readJson(globalFile(workspace.dir)).contextWindowOverrides).toEqual({
    "local/llama-test": 128000,
  });

  await reload(page, "Timeouts and limits");
  await expect(overrides.getByText("local/llama-test")).toBeVisible();
  await overrides.getByRole("button", { name: "Remove" }).click();
  await expect(overrides.getByText("None yet.")).toBeVisible();
  expect(readJson(globalFile(workspace.dir)).contextWindowOverrides).toEqual({});
  expect(dialogs).toEqual([]);
});

const STYLES = [
  ["Workflows only", "workflows-only"],
  ["Mostly workflows", "prefer-workflows"],
  ["Mostly chats", "prefer-chats"],
  ["Chats only", "chats-only"],
  ["Not set", "ask"],
] as const;

test("each coordinator work style saves, survives a reload and reaches the backend", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openSettings(page, "Coordinator");
  const style = row(page, "Work style");
  const field = style.getByRole("combobox", { name: "Work style" });
  await expect(field).toHaveValue("ask");
  await expectBakedStyle(page);
  for (const [label, value] of STYLES) {
    await choose(style, "Work style", new RegExp(`^${label}`));
    await expect(page.getByRole("status")).toContainText("Saved Work style in All projects");
    expect(readJson(globalFile(workspace.dir)).coordinator).toEqual({ workStyle: value });
    await reload(page, "Coordinator");
    await expect(field).toHaveValue(value);
    expect(await settingsValue(page, "coordinator.workStyle")).toMatchObject({
      value,
      source: "global",
    });
  }

  // A project's own style wins over the one for all projects.
  await thisProject(page);
  await choose(style, "Work style", /^Chats only/);
  await expect(page.getByRole("status")).toContainText("Saved Work style in gamma");
  expect(readJson(projectFile(root)).coordinator).toEqual({ workStyle: "chats-only" });
  expect(await settingsValue(page, "coordinator.workStyle")).toMatchObject({
    value: "chats-only",
    source: "project",
  });
  await style.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(field).toHaveValue("ask");
  expect(readJson(projectFile(root)).coordinator).toBeUndefined();
  expect(dialogs).toEqual([]);
});

/** Two coordinator turns that call the real launch tools the work style can turn off. */
const launchScript = {
  delayMs: 5,
  turns: [
    {
      steps: [
        {
          tool: "start_run",
          input: { prompt: "Add a settings page", why: "It changes several files" },
          run: true,
        },
      ],
    },
    {
      steps: [
        {
          tool: "propose_chats",
          input: { chats: [{ title: "Page", brief: "Add the page" }] },
          run: true,
        },
      ],
    },
  ],
};

async function askCoordinator(page: Page, text: string) {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /^G gamma/ })
    .click();
  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message BAKED" });
  await composer.fill(text);
  await composer.press("Enter");
}

test("the running coordinator follows a work style changed in Settings at once", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch({ script: launchScript });
  const dialogs = failOnNativeDialogs(page);
  await openSettings(page, "Coordinator");
  await choose(row(page, "Work style"), "Work style", /^Chats only/);
  await expect(page.getByRole("status")).toContainText("Saved Work style");

  await askCoordinator(page, "Add a settings page");
  const conversation = page.getByRole("region", { name: "Conversation" });
  const startRun = conversation.getByRole("button", { name: /Start run/ });
  await expect(startRun).toBeVisible({ timeout: 15_000 });
  await startRun.click();
  await expect(conversation.getByText(/The user works only through chats/)).toBeVisible();

  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await openPage(page, "Coordinator");
  await choose(row(page, "Work style"), "Work style", /^Workflows only/);
  await expect(page.getByRole("status")).toContainText("Saved Work style");
  await askCoordinator(page, "Then split it into chats");
  const proposeChats = conversation.getByRole("button", { name: /Propose chats/i });
  await expect(proposeChats).toBeVisible({ timeout: 15_000 });
  await proposeChats.click();
  await expect(conversation.getByText(/The user works only through workflows/)).toBeVisible();
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});
