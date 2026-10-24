import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { ApiResponse } from "../../src/shared/api.ts";
import type { DesktopBridge } from "../../src/shared/bridge.ts";
import { choose, expectBakedStyle, failOnNativeDialogs } from "./baked-style.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Settings of this app (`<userData>/settings.json`) and the All projects pages
 * (`~/.baked/config.json`, keys in the system keychain) against the repository's own
 * `baked serve`: what a page saves is checked on disk, through the local API and after a reload.
 */

/** No model is needed: a script with no turns runs the real backend. */
const backend = { script: { turns: [] } };

const homeOf = (dir: string) => join(dir, "home");
const readJson = (file: string): Record<string, unknown> =>
  existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
const appSettings = (dir: string) =>
  readJson(join(homeOf(dir), ".config", "@baked", "desktop", "settings.json"));
const globalConfig = (dir: string) => readJson(join(homeOf(dir), ".baked", "config.json"));

/** Opens a project so its backend runs: the All projects pages read the config through it. */
async function openProject(page: Page, project = "gamma") {
  await page.getByRole("article", { name: project }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
}

/** Opens a Settings page from the sidebar and the settings menu. */
async function openScreen(page: Page, screen: string, heading = screen) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: screen }).click();
  await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
}

/** Calls the local API of the open project the way the renderer does. */
async function request(
  page: Page,
  projectKey: string,
  method: "GET" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ApiResponse<unknown>> {
  return page.evaluate(
    ([key, m, p, b]) =>
      (window as unknown as { baked: DesktopBridge }).baked.request(key, m, p, b) as Promise<
        ApiResponse<unknown>
      >,
    [projectKey, method, path, body] as const,
  );
}

/** The key of the project the app shows, from the `#/p/KEY/...` route. */
async function shownProjectKey(page: Page): Promise<string> {
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^G gamma/ }).click();
  const key = /#\/p\/([^/]+)/.exec(page.url())?.[1];
  expect(key, "project key in the route").toBeTruthy();
  return key ?? "";
}

/**
 * A `secret-tool` (libsecret) on PATH that keeps each secret in a file of `store`, so saving a key
 * goes through the system-keychain path of src/core/secrets.ts without touching a real keychain.
 */
function fakeKeychain(dir: string): { env: Record<string, string>; store: string } {
  const bin = join(dir, "bin");
  const store = join(dir, "keychain");
  mkdirSync(bin, { recursive: true });
  mkdirSync(store, { recursive: true });
  const tool = join(bin, "secret-tool");
  writeFileSync(
    tool,
    [
      "#!/bin/sh",
      'cmd="$1"; shift',
      'for a; do key="$a"; done',
      'case "$cmd" in',
      `  store) cat > "${store}/$key" ;;`,
      `  lookup) [ -f "${store}/$key" ] && cat "${store}/$key" || exit 1 ;;`,
      `  clear) [ -f "${store}/$key" ] && rm -f "${store}/$key" || exit 1 ;;`,
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(tool, 0o755);
  return { env: { PATH: `${bin}:${process.env.PATH ?? ""}` }, store };
}

test("every settings page and dialog draws its controls with BAKED", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openProject(page);
  await openScreen(page, "Appearance and behavior");
  await expectBakedStyle(page);
  const menu = page.getByRole("navigation", { name: "Settings" });
  const links = await menu.getByRole("link").allTextContents();
  expect(links.length).toBeGreaterThan(10);
  for (const name of links) {
    await menu.getByRole("link", { name, exact: true }).click();
    await expect(menu.getByRole("link", { name, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(/^Loading/)).toHaveCount(0);
    await expectBakedStyle(page);
  }
  await openScreen(page, "Model routing");
  await page
    .getByRole("table", { name: "Agent roles" })
    .getByRole("button", { name: "Edit Reviewer" })
    .click();
  await expect(page.getByRole("dialog", { name: "Model for Reviewer" })).toBeVisible();
  await expectBakedStyle(page);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Add model name" }).click();
  await expect(page.getByRole("dialog", { name: "New model name" })).toBeVisible();
  await expectBakedStyle(page);
  expect(dialogs).toEqual([]);
});

test("the All projects pages ask for an open project when no backend runs", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  for (const screen of [
    "Providers and keys",
    "Model routing",
    "Global commands",
    "Run notifications",
    "Telemetry",
  ]) {
    await openScreen(page, screen);
    await expect(page.getByText(/^Open a project to see these settings/)).toBeVisible();
    await expectBakedStyle(page);
  }
  expect(dialogs).toEqual([]);
});

test("theme and density apply at once and are kept in the app settings", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Appearance and behavior");
  await expectBakedStyle(page);
  const root = page.locator("html");
  const theme = page.getByRole("group", { name: "Theme" });
  await expect(theme.getByRole("button", { name: "system" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await theme.getByRole("button", { name: "dark" }).click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => appSettings(workspace.dir).theme).toBe("dark");
  await theme.getByRole("button", { name: "light" }).click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect.poll(() => appSettings(workspace.dir).theme).toBe("light");

  const density = page.getByRole("group", { name: "Density" });
  await density.getByRole("button", { name: "compact" }).click();
  await expect(root).toHaveAttribute("data-density", "compact");
  await expect.poll(() => appSettings(workspace.dir).density).toBe("compact");

  await page.reload();
  await expect(theme.getByRole("button", { name: "light" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(density.getByRole("button", { name: "compact" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(root).toHaveAttribute("data-density", "compact");

  await theme.getByRole("button", { name: "system" }).click();
  await expect.poll(() => appSettings(workspace.dir).theme).toBe("system");
  await expect(root).toHaveAttribute("data-theme", /^(dark|light)$/);
  expect(dialogs).toEqual([]);
});

test("every behavior switch is saved to the app settings and survives a reload", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Appearance and behavior");
  await expectBakedStyle(page);
  const behavior = page.getByRole("region", { name: "Behavior" });
  const switches: [string, string, boolean][] = [
    ["Open the last projects on start", "openLastProjects", false],
    ["Keep runs going in the tray when the window closes", "keepRunningInTray", false],
    ["System notification when something needs me", "notifyBlocking", true],
    ["Also notify for advisory items", "notifyAdvisory", false],
  ];
  for (const [label, field, initial] of switches) {
    const box = behavior.getByRole("checkbox", { name: label });
    await expect(box).toBeChecked({ checked: initial });
    await box.click();
    await expect(box).toBeChecked({ checked: !initial });
    await expect.poll(() => appSettings(workspace.dir)[field]).toBe(!initial);
  }

  await page.reload();
  for (const [label, field, initial] of switches) {
    const box = behavior.getByRole("checkbox", { name: label });
    await expect(box).toBeChecked({ checked: !initial });
    await box.click();
    await expect.poll(() => appSettings(workspace.dir)[field]).toBe(initial);
  }

  // A blank executable means the bundled one: the field is saved as null, not as spaces.
  const executable = page
    .getByRole("region", { name: "Backend" })
    .getByRole("textbox", { name: "BAKED executable" });
  const original = await executable.inputValue();
  expect(appSettings(workspace.dir).bakedPath).toBe(original);
  await executable.fill("   ");
  await executable.blur();
  await expect.poll(() => appSettings(workspace.dir).bakedPath).toBeNull();
  await executable.fill(` ${original} `);
  await executable.blur();
  await expect.poll(() => appSettings(workspace.dir).bakedPath).toBe(original);
  expect(dialogs).toEqual([]);
});

test("voice input can be switched off and its language is kept", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openScreen(page, "Appearance and behavior");
  const voice = page.getByRole("region", { name: "Voice input" });
  await expect(voice.getByRole("status")).toBeVisible();
  await expectBakedStyle(page);
  const language = voice.getByRole("combobox", { name: "Language" });
  await expect(language).toBeEnabled();

  await choose(voice, "Language", "German");
  await expect.poll(() => appSettings(workspace.dir).voiceLanguage).toBe("de");

  const microphone = voice.getByRole("checkbox", { name: "Microphone button in the chat composer" });
  await microphone.click();
  await expect(microphone).not.toBeChecked();
  await expect(language).toBeDisabled();
  await expect.poll(() => appSettings(workspace.dir).voiceInput).toBe(false);

  await page.reload();
  await expect(microphone).not.toBeChecked();
  await expect(language).toBeDisabled();
  await expect(language).toContainText("German");
  await microphone.click();
  await expect(language).toBeEnabled();
  await choose(voice, "Language", "Detect automatically");
  await expect.poll(() => appSettings(workspace.dir)).toMatchObject({
    voiceInput: true,
    voiceLanguage: "auto",
  });
  expect(dialogs).toEqual([]);
});

test("a provider key is saved to the keychain, replaced and removed, never shown", async ({
  workspace,
  launch,
}) => {
  // Elsewhere the backend would use the real macOS keychain or Windows credential file.
  test.skip(process.platform !== "linux", "the keychain is faked through secret-tool on Linux");
  workspace.project("gamma");
  const keychain = fakeKeychain(workspace.dir);
  const { page } = await launch({ ...backend, env: keychain.env });
  const dialogs = failOnNativeDialogs(page);
  await openProject(page);
  const projectKey = await shownProjectKey(page);
  await openScreen(page, "Providers and keys");
  await expectBakedStyle(page);
  const openai = page
    .getByRole("region", { name: "Providers" })
    .getByRole("listitem")
    .filter({ hasText: /^OpenAI/ });
  await expect(openai).toContainText("not configured");
  const getKey = openai.getByRole("link", { name: "Get a key" });
  await expect(getKey).toHaveAttribute("href", /^https:\/\/platform\.openai\.com/);

  await openai.getByRole("button", { name: "Set key" }).click();
  const input = openai.getByLabel("OpenAI API key");
  await expect(input).toHaveAttribute("type", "password");
  const save = openai.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  await input.fill("   ");
  await expect(save).toBeDisabled();
  await openai.getByRole("button", { name: "Cancel" }).click();
  await expect(input).toHaveCount(0);
  expect(readdirSync(keychain.store)).toEqual([]);

  const first = "sk-test-first-0123456789";
  await openai.getByRole("button", { name: "Set key" }).click();
  await input.fill(` ${first} `);
  await save.click();
  await expect(openai).toContainText("configured · key saved by BAKED");
  await expect(openai.getByRole("button", { name: "Replace key" })).toBeVisible();
  expect(readFileSync(join(keychain.store, "openai-api-key"), "utf8")).toBe(first);
  // Never in a config file, the fallback secrets file or the page.
  expect(JSON.stringify(globalConfig(workspace.dir))).not.toContain(first);
  expect(existsSync(join(homeOf(workspace.dir), ".baked", "secrets.json"))).toBe(false);
  expect(await page.content()).not.toContain(first);

  const second = "sk-test-second-9876543210";
  await openai.getByRole("button", { name: "Replace key" }).click();
  await expect(input).toHaveValue("");
  await input.fill(second);
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  expect(readFileSync(join(keychain.store, "openai-api-key"), "utf8")).toBe(second);
  const listed = await request(page, projectKey, "GET", "/v1/providers");
  expect(JSON.stringify(listed.body)).not.toContain(second);
  expect(listed.body).toMatchObject({
    providers: expect.arrayContaining([
      expect.objectContaining({ id: "openai", configured: true, source: "app" }),
    ]),
  });

  await page.reload();
  await expect(openai).toContainText("configured · key saved by BAKED");
  expect(await page.content()).not.toContain(second);
  await openai.getByRole("button", { name: "Remove key" }).click();
  await expect(openai).toContainText("not configured");
  await expect(openai.getByRole("button", { name: "Set key" })).toBeVisible();
  await expect(openai.getByRole("button", { name: "Remove key" })).toHaveCount(0);
  expect(readdirSync(keychain.store)).toEqual([]);
  expect(dialogs).toEqual([]);
});

test("the key API refuses an empty key and a provider without keys", async ({
  workspace,
  launch,
}) => {
  test.skip(process.platform !== "linux", "the keychain is faked through secret-tool on Linux");
  workspace.project("gamma");
  const keychain = fakeKeychain(workspace.dir);
  const { page } = await launch({ ...backend, env: keychain.env });
  await openProject(page);
  const projectKey = await shownProjectKey(page);
  const empty = await request(page, projectKey, "PUT", "/v1/providers/openai/key", { key: "  " });
  expect(empty.status).toBe(400);
  const unknown = await request(page, projectKey, "PUT", "/v1/providers/nobody/key", {
    key: "sk-test",
  });
  expect(unknown.status).toBe(404);
  expect(readdirSync(keychain.store)).toEqual([]);
  expect(existsSync(join(homeOf(workspace.dir), ".baked", "secrets.json"))).toBe(false);
});

test("a model name is added, used by a role, refused when invalid and cleared", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openProject(page);
  await openScreen(page, "Model routing");
  await expectBakedStyle(page);
  const routing = () => globalConfig(workspace.dir).modelRouting as Record<string, unknown> | undefined;
  const addClass = async (name: string, model: string) => {
    await page.getByRole("button", { name: "Add model name" }).click();
    const dialog = page.getByRole("dialog", { name: "New model name" });
    await dialog.getByRole("textbox", { name: /^Name/ }).fill(name);
    await dialog.getByRole("combobox", { name: /^Model/ }).fill(model);
    await dialog.getByRole("button", { name: "Save" }).click();
    return dialog;
  };

  // Empty and invalid drafts are refused with the reasons, and nothing is written.
  let dialog = await addClass("", "");
  await expect(dialog.getByRole("alert")).toContainText("Name a model");
  await expect(dialog.getByRole("alert")).toContainText("A class name is lowercase");
  await expectBakedStyle(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  dialog = await addClass("Deep!", "openai/gpt-5");
  await expect(dialog.getByRole("alert")).toContainText("A class name is lowercase");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  dialog = await addClass("deep", "$fast");
  await expect(dialog.getByRole("alert")).toContainText("A class names a model, not another class");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(routing()).toBeUndefined();

  dialog = await addClass("deep", "openai/gpt-5");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Saved $deep in All projects" })).toBeVisible();
  const classes = page.getByRole("table", { name: "Model names" });
  await expect(classes.getByRole("row", { name: /^\$deep/ })).toContainText("openai/gpt-5");
  expect(routing()).toEqual({ classes: { deep: "openai/gpt-5" } });
  // Saving routes leaves the rest of the config alone.
  expect(globalConfig(workspace.dir).defaultModel).toBe("openai/gpt-scripted");

  dialog = await addClass("deep", "openai/gpt-5-mini");
  await expect(dialog.getByRole("alert")).toContainText("Class $deep already exists");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(routing()).toEqual({ classes: { deep: "openai/gpt-5" } });

  const roles = page.getByRole("table", { name: "Agent roles" });
  await roles.getByRole("button", { name: "Edit Reviewer" }).click();
  dialog = page.getByRole("dialog", { name: "Model for Reviewer" });
  await dialog.getByRole("combobox", { name: /^Model/ }).fill("$deep");
  await choose(dialog, /^Effort/, "high");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  const reviewer = roles.getByRole("row", { name: /^Reviewer reviewer/ });
  await expect(reviewer).toContainText("$deep");
  await expect(reviewer).toContainText("openai/gpt-5");
  expect(routing()).toEqual({
    classes: { deep: "openai/gpt-5" },
    roles: { reviewer: { model: "$deep", effort: "high" } },
  });

  await page.reload();
  await expect(reviewer).toContainText("$deep");
  // The class is still used by the reviewer: clearing it would leave a run unable to start.
  await page.getByRole("button", { name: "Clear $deep" }).click();
  await expect(page.getByRole("alert")).toContainText("Not saved");
  await expect(page.getByRole("alert")).toContainText("deep");
  expect(routing()).toMatchObject({ classes: { deep: "openai/gpt-5" } });

  await roles.getByRole("button", { name: "Clear Reviewer" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cleared roles.reviewer" })).toBeVisible();
  await page.getByRole("button", { name: "Clear $deep" }).click();
  await expect(classes.getByRole("row", { name: /^\$deep/ })).toHaveCount(0);
  expect(routing()).toBeUndefined();
  expect(globalConfig(workspace.dir).defaultModel).toBe("openai/gpt-scripted");
  expect(dialogs).toEqual([]);
});

test("routing policies and a project layer route are saved to their own files", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openProject(page);
  await openScreen(page, "Model routing");
  const routing = () => globalConfig(workspace.dir).modelRouting as Record<string, unknown> | undefined;

  const review = page.getByRole("group", { name: "Independent review" });
  await review.getByRole("button", { name: "warn" }).click();
  await expect(review.getByRole("button", { name: "warn" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(routing).toEqual({ independentReview: "warn" });
  const confidence = page.getByRole("group", { name: "Review confidence" });
  await confidence.getByRole("button", { name: "0.6" }).click();
  await expect.poll(routing).toEqual({ independentReview: "warn", reviewMinConfidence: 0.6 });
  const critic = page.getByRole("group", { name: "Critic" });
  await critic.getByRole("button", { name: "advise" }).click();
  await expect.poll(routing).toMatchObject({ critic: "advise" });
  const sonnet = page.getByRole("group", { name: "Specify on Sonnet" });
  await expect(page.getByText("Opus runs write their spec on Sonnet. In effect: on.")).toBeVisible();
  await sonnet.getByRole("button", { name: "off" }).click();
  await expect.poll(routing).toMatchObject({ specifyOnSonnet: false });
  const search = page.getByRole("group", { name: "Code web search" });
  await expect(page.getByText("Codex code attempts may search the web. In effect: off.")).toBeVisible();
  await search.getByRole("button", { name: "on" }).click();
  await expect.poll(routing).toMatchObject({ codeWebSearch: true });
  const context = page.getByRole("group", { name: "Context window" });
  await expect(page.getByText("Which window a model with several runs with. In effect: default.")).toBeVisible();
  await context.getByRole("button", { name: "auto" }).click();
  await expect.poll(routing).toMatchObject({ context: "auto" });

  await page.reload();
  await expect(review.getByRole("button", { name: "warn" })).toHaveAttribute("aria-pressed", "true");
  await expect(confidence.getByRole("button", { name: "0.6" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(critic.getByRole("button", { name: "advise" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(sonnet.getByRole("button", { name: "off" })).toHaveAttribute("aria-pressed", "true");
  await expect(search.getByRole("button", { name: "on" })).toHaveAttribute("aria-pressed", "true");
  await expect(context.getByRole("button", { name: "auto" })).toHaveAttribute("aria-pressed", "true");
  for (const group of [review, confidence, critic, sonnet, search, context])
    await group.getByRole("button", { name: "inherit" }).click();
  await expect.poll(routing).toBeUndefined();

  // The This project layer writes the project's own config, never the global one.
  await page.getByRole("tablist", { name: "Layer" }).getByRole("tab", { name: "This project" }).click();
  await page.getByRole("button", { name: "Edit $fast" }).click();
  const dialog = page.getByRole("dialog", { name: "Model for $fast" });
  await expect(dialog).toContainText("This project");
  await dialog.getByRole("combobox", { name: /^Model/ }).fill("openai/gpt-5-mini");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  const projectFile = join(root, ".baked", "config.json");
  expect(readJson(projectFile).modelRouting).toEqual({ classes: { fast: "openai/gpt-5-mini" } });
  expect(routing()).toBeUndefined();
  await page.getByRole("button", { name: "Clear $fast" }).click();
  await expect.poll(() => readJson(projectFile).modelRouting).toBeUndefined();
  expect(dialogs).toEqual([]);
});

test("global commands list the Markdown templates of the home folder", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const commands = join(homeOf(workspace.dir), ".baked", "commands");
  mkdirSync(commands, { recursive: true });
  writeFileSync(
    join(commands, "fix-ci.md"),
    "---\ndescription: Fix the failing CI job\nargument-hint: <job>\n---\nFix $ARGUMENTS.\n",
  );
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openProject(page);
  await openScreen(page, "Global commands");
  await expectBakedStyle(page);
  const list = page.getByRole("region", { name: "Global commands" });
  const entry = list.getByRole("listitem");
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("/fix-ci <job>");
  await expect(entry).toContainText("Fix the failing CI job");
  await expect(entry).toContainText(join(commands, "fix-ci.md"));
  expect(dialogs).toEqual([]);
});

// #1102: a global command is created, renamed and deleted from the page, in the home folder.
test("a global command is created, edited and deleted in the home folder", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const commands = join(homeOf(workspace.dir), ".baked", "commands");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openProject(page);
  await openScreen(page, "Global commands");
  await page.getByRole("button", { name: "New command" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name").fill("fix-ci");
  await form.getByLabel("Argument hint").fill("<job>");
  await form.getByLabel("Description").fill("Fix the failing CI job");
  await form.getByLabel("Prompt").fill("Fix $ARGUMENTS.");
  await expectBakedStyle(page);
  await form.getByRole("button", { name: "Add command" }).click();
  await expect(form).toBeHidden();
  const list = page.getByRole("region", { name: "Global commands" });
  await expect(list.getByRole("listitem")).toContainText("/fix-ci <job>");
  expect(readFileSync(join(commands, "fix-ci.md"), "utf8")).toBe(
    "---\ndescription: Fix the failing CI job\nargument-hint: <job>\n---\nFix $ARGUMENTS.\n",
  );

  await list.getByRole("button", { name: "Edit /fix-ci" }).click();
  await expect(form.getByLabel("Prompt")).toHaveValue("Fix $ARGUMENTS.");
  await form.getByLabel("Name").fill("ci:fix");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form).toBeHidden();
  await expect(list.getByRole("listitem")).toContainText("/ci:fix <job>");
  expect(existsSync(join(commands, "ci", "fix.md"))).toBe(true);
  expect(existsSync(join(commands, "fix-ci.md"))).toBe(false);

  await list.getByRole("button", { name: "Delete /ci:fix" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete /ci:fix?" });
  await expectBakedStyle(page);
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(list).toContainText("No global commands.");
  expect(existsSync(join(commands, "ci"))).toBe(false);
  expect(dialogs).toEqual([]);
});

test("global commands show an empty state, and project commands stay off the page", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  mkdirSync(join(root, ".baked", "commands"), { recursive: true });
  writeFileSync(join(root, ".baked", "commands", "local.md"), "Only in this project.\n");
  const { page } = await launch(backend);
  await openProject(page);
  await openScreen(page, "Global commands");
  const list = page.getByRole("region", { name: "Global commands" });
  await expect(list).toContainText("No global commands.");
  await expect(list).not.toContainText("local");
  await expectBakedStyle(page);
});

test("a run notification webhook is validated, saved, narrowed and removed", async ({
  workspace,
  launch,
}) => {
  workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openProject(page);
  await openScreen(page, "Run notifications");
  await expectBakedStyle(page);
  const section = page.getByRole("region", { name: "Run notifications" });
  const notifications = () =>
    globalConfig(workspace.dir).notifications as Record<string, unknown> | undefined;
  const url = section.getByRole("textbox", { name: "Webhook URL" });
  const save = section.getByRole("button", { name: "Save" });
  await expect(section).toContainText("No webhook: nothing is sent.");
  await expect(save).toBeDisabled();
  for (const invalid of ["example.com/hook", "ftp://example.com/hook", "https://", "   "]) {
    await url.fill(invalid);
    await expect(save).toBeDisabled();
    await url.press("Enter");
  }
  expect(notifications()).toBeUndefined();

  await url.fill(" https://example.com/hook ");
  await save.click();
  await expect(section).toContainText("Each waiting run is posted once to https://example.com/hook");
  expect(notifications()).toEqual({ webhook: { url: "https://example.com/hook" } });
  await expect(save).toBeDisabled();

  const blocking = section.getByRole("checkbox", { name: /^Only requests the run waits for/ });
  await blocking.click();
  await expect.poll(notifications).toEqual({
    webhook: { url: "https://example.com/hook", blockingOnly: true },
  });
  const system = section.getByRole("checkbox", {
    name: "Desktop notifications from the terminal app and the CLI",
  });
  await system.click();
  await expect.poll(() => notifications()?.system).toBe(false);

  await page.reload();
  await expect(url).toHaveValue("https://example.com/hook");
  await expect(blocking).toBeChecked();
  await expect(system).not.toBeChecked();

  await section.getByRole("button", { name: "Remove" }).click();
  await expect(section).toContainText("No webhook: nothing is sent.");
  await expect(url).toHaveValue("");
  await expect(blocking).toHaveCount(0);
  await expect.poll(notifications).toEqual({ system: false });
  await system.click();
  await expect.poll(notifications).toEqual({ system: true });
  expect(globalConfig(workspace.dir).defaultModel).toBe("openai/gpt-scripted");
  expect(dialogs).toEqual([]);
});

test("telemetry is switched off and on in the global config", async ({ workspace, launch }) => {
  workspace.project("gamma");
  const { page } = await launch(backend);
  const dialogs = failOnNativeDialogs(page);
  await openProject(page);
  await openScreen(page, "Telemetry");
  await expectBakedStyle(page);
  const section = page.getByRole("region", { name: "Telemetry" });
  const record = section.getByRole("checkbox", { name: /^Record anonymous usage stats/ });
  await expect(record).toBeChecked();
  await expect(section).toContainText("Recorded only in a local log");
  expect(globalConfig(workspace.dir).telemetry).toBeUndefined();

  await record.click();
  await expect(section).toContainText("Nothing is recorded.");
  await expect.poll(() => globalConfig(workspace.dir).telemetry).toBe(false);
  await page.reload();
  await expect(record).not.toBeChecked();
  await record.click();
  await expect(record).toBeChecked();
  await expect.poll(() => globalConfig(workspace.dir).telemetry).toBe(true);
  expect(globalConfig(workspace.dir).defaultModel).toBe("openai/gpt-scripted");
  expect(dialogs).toEqual([]);
});
