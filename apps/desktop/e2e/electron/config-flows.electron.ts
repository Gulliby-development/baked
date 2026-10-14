import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/**
 * Every kind of project configuration made in the app against the repository's own
 * `baked serve`: what the screen saves is checked on disk and after a reload.
 */

async function openScreen(page: Page, screen: string, project = "gamma") {
  await page.getByRole("article", { name: project }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: screen }).click();
  await expect(page.getByRole("heading", { name: screen, level: 1 })).toBeVisible();
}

const projectConfig = (root: string): Record<string, unknown> => {
  const file = join(root, ".baked", "config.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
};

/** No model is needed: a script with no turns runs the real backend. */
const backend = { script: { turns: [] } };

test("a hook is added, kept in the project config, and removed", async ({ workspace, launch }) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  await openScreen(page, "Hooks");
  await page.getByRole("button", { name: "Add a hook to PreToolUse" }).click();
  const dialog = page.getByRole("dialog", { name: "New hook" });
  await dialog.getByRole("button", { name: "Bash", exact: true }).click();
  await dialog.getByRole("textbox", { name: /^Run this command/ }).fill("./scripts/guard.sh");
  await dialog.getByRole("button", { name: "Add hook" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("./scripts/guard.sh")).toBeVisible();
  expect(JSON.stringify(projectConfig(root))).toContain("./scripts/guard.sh");

  await page.reload();
  await expect(page.getByText("./scripts/guard.sh")).toBeVisible();
  await page.getByRole("button", { name: /^Remove|^Delete/ }).first().click();
  const confirm = page.getByRole("dialog");
  if (await confirm.count()) await confirm.getByRole("button", { name: /^Remove|^Delete/ }).click();
  await expect(page.getByText("./scripts/guard.sh")).toHaveCount(0);
  expect(JSON.stringify(projectConfig(root))).not.toContain("./scripts/guard.sh");
});

test("an MCP server is added to the project and removed", async ({ workspace, launch }) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  await openScreen(page, "MCP servers");
  await page.getByRole("button", { name: "Add server" }).click();
  const dialog = page.getByRole("dialog", { name: "Add MCP server" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("notes");
  await dialog.getByRole("textbox", { name: "Command" }).fill("bun");
  await dialog.getByRole("textbox", { name: "Arguments" }).fill("run notes-server.ts");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  const inProject = page.getByRole("region", { name: "In this project" });
  await expect(inProject.getByRole("heading", { name: "In this project · 1" })).toBeVisible();
  await expect(inProject.getByText("notes", { exact: true })).toBeVisible();
  expect(projectConfig(root).mcpServers).toEqual([
    { name: "notes", command: "bun", args: ["run", "notes-server.ts"] },
  ]);

  await page.reload();
  await expect(inProject.getByText("notes", { exact: true })).toBeVisible();
  await inProject.getByRole("button", { name: /^Remove/ }).click();
  const confirm = page.getByRole("dialog");
  if (await confirm.count()) await confirm.getByRole("button", { name: /^Remove/ }).click();
  await expect(inProject.getByRole("heading", { name: "In this project · 0" })).toBeVisible();
});

test("a new check is saved, runs, and its result shows", async ({ workspace, launch }) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  await openScreen(page, "Gates and checks");
  await page.getByRole("button", { name: "New check" }).click();
  const form = page.getByRole("form", { name: "New check" });
  await form.getByRole("textbox", { name: "ID" }).fill("bun-version");
  await form.getByRole("textbox", { name: "Command" }).fill("bun --version");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  const check = page.getByRole("button", { name: /bun-version/ }).first();
  await expect(check).toBeVisible();
  expect(JSON.stringify(projectConfig(root))).toContain("bun-version");

  await check.click();
  await page.getByRole("button", { name: /^Run/ }).first().click();
  await expect(page.getByText(/passed/i).first()).toBeVisible({ timeout: 20_000 });
});

test("agent context creates AGENTS.md and keeps a source switched on", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const { page } = await launch(backend);
  await openScreen(page, "Agent context");
  await page.getByRole("button", { name: "Create AGENTS.md" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => existsSync(join(root, "AGENTS.md"))).toBe(true);

  const claude = page.getByRole("switch", { name: /^CLAUDE\.md/ });
  await expect(claude).not.toBeChecked();
  await claude.click();
  await expect(claude).toBeChecked();
  await page.reload();
  await expect(page.getByRole("switch", { name: /^CLAUDE\.md/ })).toBeChecked();
  expect(projectConfig(root).instructionFiles).toContain("claude");
});

test("memory settings are saved for the project", async ({ workspace, launch }) => {
  workspace.project("gamma");
  const { page } = await launch(backend);
  await openScreen(page, "Memory");
  const save = page.getByRole("group", { name: "Save new memories to" });
  await save.getByRole("button", { name: "Global" }).click();
  await expect(save.getByRole("button", { name: "Global" })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(
    page.getByRole("group", { name: "Save new memories to" }).getByRole("button", { name: "Global" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("a skill in the project folder shows with its description", async ({ workspace, launch }) => {
  const root = workspace.project("gamma");
  const skill = join(root, ".baked", "skills", "release-notes");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: release-notes\ndescription: Writes release notes from merged pull requests.\n---\n\nRead the merged pull requests and write notes.\n",
  );
  const { page } = await launch(backend);
  await openScreen(page, "Skills");
  const inProject = page.getByRole("region", { name: "In this project" });
  await expect(inProject.getByRole("heading", { name: "In this project · 1" })).toBeVisible();
  await expect(inProject.getByText("release-notes").first()).toBeVisible();
  await expect(inProject.getByText(/Writes release notes/)).toBeVisible();
});

test("a language server switched off stays off", async ({ workspace, launch }) => {
  const root = workspace.project("gamma");
  writeFileSync(join(root, "package.json"), '{ "name": "gamma" }\n');
  const { page } = await launch(backend);
  await openScreen(page, "Language servers");
  const servers = page.getByRole("region", { name: "Servers" });
  const toggle = servers.getByRole("switch", { name: /^Turn off / }).first();
  const name = ((await toggle.getAttribute("aria-label")) ?? "").replace(/^Turn off /, "");
  await toggle.click();
  await expect(servers.getByRole("switch", { name: `Turn on ${name}` })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Servers" }).getByRole("switch", { name: `Turn on ${name}` }),
  ).toBeVisible();
});

test("a package is created from a folder and installed into the project", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const folder = join(workspace.dir, "acme-notes");
  mkdirSync(join(folder, "skills", "release-notes"), { recursive: true });
  writeFileSync(
    join(folder, "skills", "release-notes", "SKILL.md"),
    "---\nname: release-notes\ndescription: Writes release notes.\n---\n\nWrite the notes.\n",
  );
  const { page } = await launch(backend);
  await openScreen(page, "Packages");
  await page.getByRole("button", { name: /^Create package/ }).click();
  const create = page.getByRole("dialog", { name: "Create a package" });
  await create.getByRole("textbox", { name: "Package folder" }).fill(folder);
  await create.getByRole("button", { name: "Next" }).click();
  const naming = create.getByRole("form", { name: "Name and version" });
  await naming.getByRole("textbox", { name: "Name" }).fill("acme-notes");
  await naming.getByRole("textbox", { name: "Version" }).fill("1.0.0");
  await create.getByRole("button", { name: "Pack it" }).click();
  await expect.poll(() => existsSync(join(folder, "baked-package.json"))).toBe(true);
  await expect(create.getByRole("img", { name: "Packed: acme-notes 1.0.0" })).toBeVisible();
  await create.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: /^Install package/ }).click();
  const install = page.getByRole("dialog", { name: "Install a package" });
  await install.getByRole("textbox", { name: "Package folder" }).fill(folder);
  await install.getByRole("button", { name: "Show plan" }).click();
  await expect(install.getByRole("region", { name: "Plan for acme-notes" })).toContainText("1 skill");
  await install.getByRole("button", { name: "Install" }).click();
  await expect(install.getByText(/Installed|installed/).first()).toBeVisible();
  await install.getByRole("button", { name: "Close" }).click();
  const installed = page.getByRole("region", { name: "Installed packages" });
  await expect(installed.getByText("acme-notes").first()).toBeVisible();

  // Its files are now project content under baked/, recorded in baked/packages.json.
  expect(existsSync(join(root, "baked", "skills", "release-notes", "SKILL.md"))).toBe(true);
  expect(readFileSync(join(root, "baked", "packages.json"), "utf8")).toContain("acme-notes");
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Installed packages" }).getByText("acme-notes").first(),
  ).toBeVisible();
});
