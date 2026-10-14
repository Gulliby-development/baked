import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import type { HttpMethod } from "../../src/shared/bridge.ts";
import { choose, expectBakedStyle, failOnNativeDialogs } from "./baked-style.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The content screens of a project's setup against the repository's own `baked serve`: skills,
 * packages, language servers, chat and run memory, and agent context. What a screen saves is
 * checked on disk, through the local API and after a reload.
 */

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

/** No model is needed: a script with no turns runs the real backend. */
const backend = { script: { turns: [] } };

async function openScreen(page: Page, screen: string, project = "gamma") {
  await page.getByRole("article", { name: project }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: screen }).click();
  await expect(page.getByRole("heading", { name: screen, level: 1 })).toBeVisible();
}

/** Calls the project's local API the way the renderer does, through the preload bridge. */
async function api<T>(page: Page, method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const response = await page.evaluate(
    async ([method, path, body]) => {
      // The open project's key is the route's second part: #/p/KEY/section.
      const key = decodeURIComponent(window.location.hash.split("/")[2] ?? "");
      if (!window.baked) throw new Error("No preload bridge");
      return await window.baked.request(key, method, path, body);
    },
    [method, path, body] as const,
  );
  expect(response.status, `${method} ${path}`).toBeLessThan(300);
  return response.body as T;
}

const home = (dir: string) => join(dir, "home");
const read = (file: string) => readFileSync(file, "utf8");
const readJson = (file: string): Record<string, unknown> =>
  existsSync(file) ? (JSON.parse(read(file)) as Record<string, unknown>) : {};

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function skill(dir: string, name: string, description: string): void {
  write(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`,
  );
}

/** A package folder with its files and a `baked-package.json` listing their hashes. */
function makePackage(folder: string, name: string, files: Record<string, string>): void {
  const listed = Object.entries(files).map(([path, content]) => {
    write(join(folder, path), content);
    return { path, sha256: createHash("sha256").update(content).digest("hex") };
  });
  write(
    join(folder, "baked-package.json"),
    JSON.stringify({ schemaVersion: 1, name, version: "1.0.0", files: listed }, null, 2),
  );
}

const notesSkill = "---\nname: release-notes\ndescription: Writes release notes.\n---\n\nWrite.\n";

/** Writes chat memories into the project and global stores with the repository's own code. */
function seedChatMemory(
  root: string,
  dir: string,
  entries: { scope: "project" | "global"; summary: string; details?: string }[],
): void {
  const script = join(dir, "seed-memory.ts");
  writeFileSync(
    script,
    `import { MemoryManager } from ${JSON.stringify(join(repoRoot, "src", "core", "memory", "manager.ts"))};
const memory = new MemoryManager(process.env.SEED_ROOT!, process.env.SEED_GLOBAL!);
for (const e of JSON.parse(process.env.SEED_ENTRIES!))
  memory.write(e.scope, { category: null, summary: e.summary, details: e.details ?? "", source: "user" });
memory.close();
`,
  );
  execFileSync("bun", [script], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home(dir),
      SEED_ROOT: root,
      SEED_GLOBAL: join(home(dir), ".baked"),
      SEED_ENTRIES: JSON.stringify(entries),
    },
    timeout: 60_000,
  });
}

interface SkillList {
  skills: { id: string; scope: string }[];
}

test.describe("Skills", () => {
  test("a project without skills shows both empty groups", async ({ workspace, launch }) => {
    workspace.project("gamma");
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Skills");
    for (const group of ["In this project", "Global"]) {
      const region = page.getByRole("region", { name: group });
      await expect(region.getByRole("heading", { name: `${group} · 0` })).toBeVisible();
      await expect(region.getByText("None yet. Find one below.")).toBeVisible();
    }
    await expectBakedStyle(page);
    expect(dialogs).toEqual([]);
  });

  test("a project skill replaces a global one until it is removed", async ({
    workspace,
    launch,
  }) => {
    const root = workspace.project("gamma");
    skill(join(home(workspace.dir), ".baked", "skills"), "review", "Global review steps.");
    skill(join(root, ".agents", "skills"), "review", "Project review steps.");
    skill(join(home(workspace.dir), ".claude", "skills"), "deploy", "Deploys the site.");
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Skills");
    const inProject = page.getByRole("region", { name: "In this project" });
    const global = page.getByRole("region", { name: "Global" });
    await expect(inProject.getByRole("heading", { name: "In this project · 1" })).toBeVisible();
    await expect(inProject.getByText("Project review steps.")).toBeVisible();
    await expect(global.getByRole("heading", { name: "Global · 1" })).toBeVisible();
    await expect(global.getByText("deploy", { exact: true })).toBeVisible();

    await inProject.getByRole("button", { name: "Open" }).click();
    const view = page.getByRole("dialog", { name: "review" });
    await expect(view).toContainText("Project review steps.");
    await expect(view).toContainText(join(root, ".agents", "skills", "review", "SKILL.md"));
    await expectBakedStyle(page);
    await page.keyboard.press("Escape");
    await expect(view).toBeHidden();

    await inProject.getByRole("button", { name: "Remove review" }).click();
    const confirm = page.getByRole("dialog", { name: "Remove review?" });
    await expect(confirm).toContainText(join(root, ".agents", "skills", "review"));
    await expectBakedStyle(page);
    await confirm.getByRole("button", { name: "Remove" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByText("Removed review.")).toBeVisible();
    expect(existsSync(join(root, ".agents", "skills", "review"))).toBe(false);
    expect(existsSync(join(home(workspace.dir), ".baked", "skills", "review", "SKILL.md"))).toBe(
      true,
    );

    // The global skill of the same name is the one agents get now.
    await expect(inProject.getByRole("heading", { name: "In this project · 0" })).toBeVisible();
    await expect(global.getByRole("heading", { name: "Global · 2" })).toBeVisible();
    await expect(global.getByText("Global review steps.")).toBeVisible();
    const { skills } = await api<SkillList>(page, "GET", "/v1/skills");
    expect(skills.map((s) => `${s.scope}/${s.id}`)).toEqual(["global/deploy", "global/review"]);

    await page.reload();
    await expect(
      page.getByRole("region", { name: "Global" }).getByRole("heading", { name: "Global · 2" }),
    ).toBeVisible();
    expect(dialogs).toEqual([]);
  });

  test("a global skill is removed from the home folder", async ({ workspace, launch }) => {
    workspace.project("gamma");
    const skills = join(home(workspace.dir), ".agents", "skills");
    skill(skills, "deploy", "Deploys the site.");
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Skills");
    const global = page.getByRole("region", { name: "Global" });
    await global.getByRole("button", { name: "Remove deploy" }).click();
    const confirm = page.getByRole("dialog", { name: "Remove deploy?" });
    await expect(confirm).toContainText("for every project");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    expect(existsSync(join(skills, "deploy", "SKILL.md"))).toBe(true);

    await global.getByRole("button", { name: "Remove deploy" }).click();
    await confirm.getByRole("button", { name: "Remove" }).click();
    await expect(global.getByRole("heading", { name: "Global · 0" })).toBeVisible();
    expect(existsSync(join(skills, "deploy"))).toBe(false);
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Global" }).getByText("None yet. Find one below."),
    ).toBeVisible();
    expect(dialogs).toEqual([]);
  });

  test("a SKILL.md outside its own folder is not removed", async ({ workspace, launch }) => {
    const root = workspace.project("gamma");
    const loose = join(root, ".claude", "skills", "SKILL.md");
    write(loose, "---\nname: loose\ndescription: Lies in the skills folder.\n---\n");
    skill(join(root, ".claude", "skills"), "keep-me", "Must survive.");
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Skills");
    const inProject = page.getByRole("region", { name: "In this project" });
    await inProject.getByRole("button", { name: "Remove skills" }).click();
    const confirm = page.getByRole("dialog", { name: "Remove skills?" });
    await confirm.getByRole("button", { name: "Remove" }).click();
    await expect(
      confirm.getByText(/is not in its own skill folder; remove it by hand/),
    ).toBeVisible();
    await expectBakedStyle(page);
    expect(existsSync(loose)).toBe(true);
    expect(existsSync(join(root, ".claude", "skills", "keep-me", "SKILL.md"))).toBe(true);
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(inProject.getByRole("heading", { name: "In this project · 2" })).toBeVisible();
    expect(dialogs).toEqual([]);
  });
});

test.describe("Packages", () => {
  test("a missing folder or a broken manifest is refused and nothing is written", async ({
    workspace,
    launch,
  }) => {
    const root = workspace.project("gamma");
    const broken = join(workspace.dir, "broken");
    write(join(broken, "baked-package.json"), "{ not json");
    const tampered = join(workspace.dir, "tampered");
    makePackage(tampered, "tampered", { "skills/release-notes/SKILL.md": notesSkill });
    write(join(tampered, "skills", "release-notes", "SKILL.md"), `${notesSkill}Changed.\n`);
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Packages");
    const installed = page.getByRole("region", { name: "Installed packages" });
    await expect(installed.getByText("No packages installed in this project yet.")).toBeVisible();
    await expectBakedStyle(page);

    await page.getByRole("button", { name: /^Install package/ }).click();
    const install = page.getByRole("dialog", { name: "Install a package" });
    const folder = install.getByRole("textbox", { name: "Package folder" });
    const showPlan = install.getByRole("button", { name: "Show plan" });
    await expect(showPlan).toBeDisabled();
    await folder.fill("   ");
    await expect(showPlan).toBeDisabled();

    const missing = join(workspace.dir, "nowhere");
    await folder.fill(missing);
    await showPlan.click();
    await expect(install.getByRole("alert")).toHaveText(`${missing} does not exist`);
    await expectBakedStyle(page);

    await folder.fill(broken);
    await showPlan.click();
    await expect(install.getByRole("alert")).toContainText("baked-package.json is not JSON");

    await folder.fill(tampered);
    await showPlan.click();
    await expect(install.getByRole("alert")).toContainText(
      "skills/release-notes/SKILL.md: SHA-256 is",
    );
    // Still on the first step: no plan, no install.
    await expect(folder).toBeVisible();
    await expect(install.getByRole("button", { name: "Install" })).toHaveCount(0);
    expect(existsSync(join(root, "baked", "packages.json"))).toBe(false);
    expect(existsSync(join(root, "baked", "skills"))).toBe(false);
    expect(dialogs).toEqual([]);
  });

  test("an installed package is removed and its files go, edited ones stay", async ({
    workspace,
    launch,
  }) => {
    const root = workspace.project("gamma");
    const folder = join(workspace.dir, "acme-notes");
    makePackage(folder, "acme-notes", {
      "skills/release-notes/SKILL.md": notesSkill,
      "skills/release-notes/checklist.md": "- Mention breaking changes\n",
    });
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Packages");
    await page.getByRole("button", { name: /^Install package/ }).click();
    const install = page.getByRole("dialog", { name: "Install a package" });
    await install.getByRole("textbox", { name: "Package folder" }).fill(folder);
    await install.getByRole("button", { name: "Show plan" }).click();
    await expect(install.getByRole("region", { name: "Plan for acme-notes" })).toBeVisible();
    await expectBakedStyle(page);
    await install.getByRole("button", { name: "Install", exact: true }).click();
    await expect(install.getByRole("status")).toContainText(
      "Installed acme-notes 1.0.0: 2 files written.",
    );
    await install.getByRole("button", { name: "Done" }).click();
    await expect(install).toBeHidden();

    const lock = join(root, "baked", "packages.json");
    const skillFile = join(root, "baked", "skills", "release-notes", "SKILL.md");
    const checklist = join(root, "baked", "skills", "release-notes", "checklist.md");
    expect(read(skillFile)).toBe(notesSkill);
    expect(read(lock)).toContain("acme-notes");
    // An edit after the install keeps that file when the package goes.
    writeFileSync(checklist, "- Mention breaking changes\n- And the migration\n");

    await page.reload();
    const installed = page.getByRole("region", { name: "Installed packages" });
    await expect(installed.getByText("1 edited")).toBeVisible();
    await installed.getByRole("button", { name: "Remove acme-notes" }).click();
    const confirm = page.getByRole("dialog", { name: "Remove acme-notes?" });
    await expectBakedStyle(page);
    await confirm.getByRole("button", { name: "Remove" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByRole("status")).toHaveText(
      "Removed acme-notes 1.0.0: 1 file deleted; kept 1 edited: baked/skills/release-notes/checklist.md.",
    );
    await expect(installed.getByText("No packages installed in this project yet.")).toBeVisible();
    expect(existsSync(skillFile)).toBe(false);
    expect(read(checklist)).toContain("And the migration");
    expect(read(lock)).not.toContain("acme-notes");
    expect(await api(page, "GET", "/v1/packages")).toEqual({ packages: [] });
    expect(dialogs).toEqual([]);
  });

  test("a package whose files belong to another one cannot be installed", async ({
    workspace,
    launch,
  }) => {
    const root = workspace.project("gamma");
    const first = join(workspace.dir, "first");
    const second = join(workspace.dir, "second");
    makePackage(first, "first", { "skills/release-notes/SKILL.md": notesSkill });
    makePackage(second, "second", { "skills/release-notes/SKILL.md": `${notesSkill}More.\n` });
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Packages");
    const plan = await api<{ planHash: string; source: string }>(
      page,
      "POST",
      "/v1/packages/inspect",
      { path: first },
    );
    await api(page, "POST", "/v1/packages/install", { path: plan.source, planHash: plan.planHash });
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Installed packages" }).getByRole("listitem"),
    ).toContainText("first 1.0.0");

    await page.getByRole("button", { name: /^Install package/ }).click();
    const install = page.getByRole("dialog", { name: "Install a package" });
    await install.getByRole("textbox", { name: "Package folder" }).fill(second);
    await install.getByRole("button", { name: "Show plan" }).click();
    const details = install.getByRole("region", { name: "Plan for second" });
    await expect(details).toContainText("This package cannot be installed:");
    await expect(details).toContainText(
      "baked/skills/release-notes/SKILL.md belongs to the installed package first",
    );
    await expectBakedStyle(page);
    await expect(install.getByRole("button", { name: "Cannot be installed" })).toBeDisabled();
    expect(read(join(root, "baked", "skills", "release-notes", "SKILL.md"))).toBe(notesSkill);
    expect(dialogs).toEqual([]);
  });
});

test.describe("Language servers", () => {
  test("a server turned off in the project's own list is switched back on", async ({
    workspace,
    launch,
  }) => {
    const root = workspace.project("gamma");
    write(join(root, "data.json"), "{}\n");
    write(
      join(root, ".baked", "config.json"),
      JSON.stringify({ disabledLspServers: ["vscode-json-language-server"] }),
    );
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Language servers");
    const servers = page.getByRole("region", { name: "Servers" });
    await expect(servers.getByText("Turned off in this project.")).toBeVisible();
    await expectBakedStyle(page);
    await servers.getByRole("switch", { name: "Turn on vscode-json-language-server" }).click();
    await expect(
      servers.getByRole("switch", { name: "Turn off vscode-json-language-server" }),
    ).toBeChecked();
    await expect(page.getByText("Turned on vscode-json-language-server.")).toBeVisible();
    await expect(servers.getByText("Turned off in this project.")).toHaveCount(0);
    expect(readJson(join(root, ".baked", "config.json")).disabledLspServers).toEqual([]);

    // With its own list, the project keeps the next switch-off to itself.
    await servers.getByRole("switch", { name: "Turn off vscode-json-language-server" }).click();
    await expect(servers.getByText("Turned off in this project.")).toBeVisible();
    expect(readJson(join(root, ".baked", "config.json")).disabledLspServers).toEqual([
      "vscode-json-language-server",
    ]);
    expect(readJson(join(home(workspace.dir), ".baked", "config.json")).disabledLspServers).toBe(
      undefined,
    );
    expect(dialogs).toEqual([]);
  });

  test("a server turned off for every project is on again after a switch", async ({
    workspace,
    launch,
  }) => {
    const root = workspace.project("gamma");
    write(join(root, "data.json"), "{}\n");
    const globalConfig = join(home(workspace.dir), ".baked", "config.json");
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Language servers");
    const servers = page.getByRole("region", { name: "Servers" });
    await servers.getByRole("switch", { name: "Turn off vscode-json-language-server" }).click();
    await expect(servers.getByText("Turned off in your user config.")).toBeVisible();
    expect(readJson(globalConfig).disabledLspServers).toEqual(["vscode-json-language-server"]);
    // The model the harness set stays.
    expect(readJson(globalConfig).defaultModel).toBe("openai/gpt-scripted");

    await page.reload();
    await servers.getByRole("switch", { name: "Turn on vscode-json-language-server" }).click();
    await expect(
      servers.getByRole("switch", { name: "Turn off vscode-json-language-server" }),
    ).toBeChecked();
    expect(readJson(globalConfig).disabledLspServers).toEqual([]);
    expect(existsSync(join(root, ".baked", "config.json"))).toBe(false);
    expect(dialogs).toEqual([]);
  });

  test("Show all lists servers for languages the project does not use", async ({
    workspace,
    launch,
  }) => {
    const root = workspace.project("gamma");
    write(join(root, "data.json"), "{}\n");
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Language servers");
    const servers = page.getByRole("region", { name: "Servers" });
    // BAKED's own baked/project.json is not counted, so data.json makes JSON the one language.
    await expect(servers.getByText(/^Languages found: json\./)).toBeVisible();
    const pyright = servers.getByRole("switch", { name: /^Turn (on|off) pyright-langserver$/ });
    await expect(pyright).toHaveCount(0);
    await expectBakedStyle(page);
    const all = servers.getByRole("switch", { name: "Show all" });
    await all.click();
    await expect(all).toBeChecked();
    await expect(servers.getByRole("heading", { name: /^All servers · \d+$/ })).toBeVisible();
    await expect(pyright).toBeVisible();
    await all.click();
    await expect(
      servers.getByRole("heading", { name: /^For this project's languages/ }),
    ).toBeVisible();
    await expect(pyright).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });
});

interface ChatMemoryView {
  entries: {
    id: string;
    scope: string;
    summary: string;
    details: string;
    category: string | null;
    pinned: boolean;
  }[];
  hidden: { id: string; summary: string }[];
  settings: { shareWithRuns: boolean };
}

test.describe("Memory", () => {
  test("chat and run memory show their empty states", async ({ workspace, launch }) => {
    workspace.project("gamma");
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Memory");
    const memories = page.getByRole("region", { name: "Memories" });
    await expect(memories.getByText(/^Nothing yet\. The agent saves/)).toBeVisible();
    await expect(page.getByRole("region", { name: "Delete all" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Cleanup" })).toHaveCount(0);
    await expectBakedStyle(page);
    await page.getByRole("tab", { name: "Runs" }).click();
    await expect(page.getByText(/^Nothing yet\. Runs record the answers/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Add note" })).toBeDisabled();
    await expectBakedStyle(page);
    expect(dialogs).toEqual([]);
  });

  test("a chat memory is edited, pinned, hidden and restored", async ({ workspace, launch }) => {
    const root = workspace.project("gamma");
    seedChatMemory(root, workspace.dir, [
      { scope: "project", summary: "Use tabs in Makefiles", details: "Make needs them." },
      { scope: "project", summary: "Run the linter first" },
      { scope: "global", summary: "Answer in short sentences" },
    ]);
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Memory");
    const memories = page.getByRole("region", { name: "Memories" });
    const tabs = memories.getByRole("listitem").filter({ hasText: "Use tabs in Makefiles" });
    await expect(tabs).toContainText("Make needs them.");
    await expect(memories.getByText("Answer in short sentences")).toBeVisible();

    await tabs.getByRole("button", { name: "Edit" }).click();
    const summary = memories.getByRole("textbox", { name: "Summary" });
    const save = memories.getByRole("button", { name: "Save" });
    await summary.fill("  ");
    await expect(save).toBeDisabled();
    // The text of another memory of the project is refused, and the draft stays.
    await summary.fill("Run the linter first");
    await memories.getByRole("textbox", { name: "Details" }).fill("");
    await save.click();
    await expect(page.getByRole("alert")).toHaveText(
      "Another project memory already has this summary and details",
    );
    await expectBakedStyle(page);
    await expect(summary).toHaveValue("Run the linter first");
    let view = await api<ChatMemoryView>(page, "GET", "/v1/memory");
    expect(view.entries.map((e) => e.summary).sort()).toEqual([
      "Answer in short sentences",
      "Run the linter first",
      "Use tabs in Makefiles",
    ]);
    await summary.fill("Makefiles need tabs");
    await memories.getByRole("textbox", { name: "Details" }).fill("Spaces break the recipes.");
    await choose(memories, "Category", "Gotcha");
    await expectBakedStyle(page);
    await save.click();
    const edited = memories.getByRole("listitem").filter({ hasText: "Makefiles need tabs" });
    await expect(edited).toContainText("Spaces break the recipes.");
    await expect(edited).toContainText("gotcha");

    await edited.getByRole("button", { name: "Pin" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(edited.getByRole("img", { name: "Pinned" })).toBeVisible();
    view = await api<ChatMemoryView>(page, "GET", "/v1/memory");
    expect(view.entries.find((e) => e.summary === "Makefiles need tabs")).toMatchObject({
      scope: "project",
      summary: "Makefiles need tabs",
      details: "Spaces break the recipes.",
      category: "gotcha",
      pinned: true,
    });

    await memories.getByRole("button", { name: "Hide Answer in short sentences" }).click();
    const hidden = page.getByRole("region", { name: "Hidden" });
    await expect(hidden.getByText("Answer in short sentences")).toBeVisible();
    await expect(memories.getByText("Answer in short sentences")).toHaveCount(0);
    await page.reload();
    await expect(hidden.getByText("Answer in short sentences")).toBeVisible();
    await hidden.getByRole("button", { name: "Restore" }).click();
    await expect(memories.getByText("Answer in short sentences")).toBeVisible();
    await expect(hidden).toHaveCount(0);
    view = await api<ChatMemoryView>(page, "GET", "/v1/memory");
    expect(view.hidden).toEqual([]);
    expect(dialogs).toEqual([]);
  });

  test("delete all removes every chat memory after a confirmation", async ({
    workspace,
    launch,
  }) => {
    const root = workspace.project("gamma");
    seedChatMemory(root, workspace.dir, [
      { scope: "project", summary: "Run bun test before a commit" },
      { scope: "global", summary: "Prefer small pull requests" },
    ]);
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Memory");
    const purge = page.getByRole("region", { name: "Delete all" });
    await purge.getByRole("button", { name: "Delete all memories…" }).click();
    await purge.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Prefer small pull requests")).toBeVisible();
    await purge.getByRole("button", { name: "Delete all memories…" }).click();
    await purge.getByRole("button", { name: "Delete 2 memories" }).click();
    await expect(page.getByText(/^Nothing yet\. The agent saves/)).toBeVisible();
    await expect(purge).toHaveCount(0);
    expect((await api<ChatMemoryView>(page, "GET", "/v1/memory")).entries).toEqual([]);
    expect(dialogs).toEqual([]);
  });

  test("share with runs is saved in the project's memory settings", async ({
    workspace,
    launch,
  }) => {
    const root = workspace.project("gamma");
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Memory");
    const share = page.getByRole("switch", { name: "Share memory between chats and runs" });
    await expect(share).not.toBeChecked();
    await share.click();
    await expect(share).toBeChecked();
    const file = join(root, ".baked", "memory-config.json");
    await expect.poll(() => readJson(file).shareWithRuns).toBe(true);
    await page.reload();
    await expect(share).toBeChecked();
    expect((await api<ChatMemoryView>(page, "GET", "/v1/memory")).settings.shareWithRuns).toBe(
      true,
    );
    await share.click();
    await expect(share).not.toBeChecked();
    await expect.poll(() => readJson(file).shareWithRuns).toBeUndefined();
    expect(dialogs).toEqual([]);
  });

  test("a run note is added, edited and deleted", async ({ workspace, launch }) => {
    workspace.project("gamma");
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Memory");
    await page.getByRole("tab", { name: "Runs" }).click();
    const note = page.getByRole("textbox", { name: "New note" });
    const add = page.getByRole("button", { name: "Add note" });
    await note.fill("   ");
    await expect(add).toBeDisabled();
    await note.fill("Public APIs keep their names");
    await add.click();
    await expect(note).toHaveValue("");
    const notes = page.getByRole("region", { name: "Notes" });
    await expect(notes.getByText("Public APIs keep their names")).toBeVisible();

    await notes.getByRole("button", { name: "Edit" }).click();
    const text = notes.getByRole("textbox", { name: "New text" });
    await text.fill(" ");
    await expect(notes.getByRole("button", { name: "Save" })).toBeDisabled();
    await text.fill("Public APIs keep their names and signatures");
    await notes.getByRole("button", { name: "Save" }).click();
    await expect(notes.getByText("Public APIs keep their names and signatures")).toBeVisible();
    await expectBakedStyle(page);

    await page.reload();
    await expect(notes.getByText("Public APIs keep their names and signatures")).toBeVisible();
    let view = await api<{ entries: { kind: string; text: string }[] }>(
      page,
      "GET",
      "/v1/workflow/memory",
    );
    expect(view.entries.filter((e) => e.kind === "note").map((e) => e.text)).toEqual([
      "Public APIs keep their names and signatures",
    ]);

    await notes
      .getByRole("button", { name: "Delete Public APIs keep their names and signatures" })
      .click();
    // A note of your own cannot be restored, so deleting it asks first.
    const confirm = page.getByRole("dialog", { name: "Delete this note?" });
    await expect(confirm).toContainText("A deleted note cannot be restored.");
    await expectBakedStyle(page);
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toBeHidden();
    await expect(notes).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Forgotten" })).toHaveCount(0);
    await expect(page.getByText(/^Nothing yet\. Runs record the answers/)).toBeVisible();
    view = await api(page, "GET", "/v1/workflow/memory");
    expect(view.entries).toEqual([]);
    expect(dialogs).toEqual([]);
  });
});

test.describe("Agent context", () => {
  test("rules edited in the app are saved to the file and shown in the preview", async ({
    workspace,
    launch,
  }) => {
    const root = workspace.project("gamma");
    write(join(root, "baked.md"), "# Rules\n\nUse Bun.\n");
    write(join(root, "AGENTS.md"), "Read the contributing guide.\n");
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Agent context");
    const editor = page.getByRole("region", { name: "baked.md" });
    const text = editor.getByRole("textbox", { name: "baked.md contents" });
    await expect(text).toHaveValue("# Rules\n\nUse Bun.\n");
    const save = editor.getByRole("button", { name: "Save" });
    await expect(save).toBeDisabled();
    await text.fill("# Rules\n\nUse Bun.\nThrowaway edit.\n");
    await editor.getByRole("button", { name: "Revert" }).click();
    await expect(text).toHaveValue("# Rules\n\nUse Bun.\n");
    await expect(save).toBeDisabled();

    await text.fill("# Rules\n\nUse Bun.\nKeep commits small.\n");
    await save.click();
    await expect(editor.getByText(/Saved\.$/)).toBeVisible();
    expect(read(join(root, "baked.md"))).toBe("# Rules\n\nUse Bun.\nKeep commits small.\n");
    await expectBakedStyle(page);

    const preview = async () => {
      await page.getByRole("tab", { name: "Preview" }).click();
      return page.getByRole("region", { name: "Rules" });
    };
    let rules = await preview();
    await expect(rules).toContainText("Keep commits small.");
    // AGENTS.md is read only once its source is on.
    await expect(rules).not.toContainText("Read the contributing guide.");
    await expect(page.getByRole("region", { name: "Files" })).toContainText(
      "Nothing: agents get no working set.",
    );
    await expectBakedStyle(page);

    await page.getByRole("tab", { name: "Rules" }).click();
    const agents = page.getByRole("switch", { name: /^AGENTS\.md/ });
    await expect(agents).not.toBeChecked();
    await agents.click();
    await expect(agents).toBeChecked();
    rules = await preview();
    await expect(rules).toContainText("Read the contributing guide.");
    await expect(rules).toContainText("Keep commits small.");
    expect(dialogs).toEqual([]);
  });

  test("a rules file changed on disk since it was opened is not overwritten", async ({
    workspace,
    launch,
  }) => {
    const root = workspace.project("gamma");
    write(join(root, "AGENTS.md"), "# Rules\n");
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Agent context");
    const editor = page.getByRole("region", { name: "AGENTS.md" });
    await expect(editor.getByRole("textbox", { name: "AGENTS.md contents" })).toHaveValue(
      "# Rules\n",
    );
    writeFileSync(join(root, "AGENTS.md"), "# Rules\n\nWritten by someone else.\n");
    await editor.getByRole("textbox", { name: "AGENTS.md contents" }).fill("# Mine\n");
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor.getByText(/changed on disk since it was opened/)).toBeVisible();
    await expectBakedStyle(page);
    expect(read(join(root, "AGENTS.md"))).toBe("# Rules\n\nWritten by someone else.\n");
    await expect(editor.getByRole("textbox", { name: "AGENTS.md contents" })).toHaveValue(
      "# Mine\n",
    );
    expect(dialogs).toEqual([]);
  });

  test("a project without rules offers to create one and previews nothing", async ({
    workspace,
    launch,
  }) => {
    const root = workspace.project("gamma");
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Agent context");
    await expect(page.getByText(/^No instruction files\./)).toBeVisible();
    await page.getByRole("button", { name: "Create baked.md" }).click();
    const editor = page.getByRole("region", { name: "baked.md" });
    await expect(editor.getByText("new", { exact: true })).toBeVisible();
    await editor.getByRole("button", { name: "Discard" }).click();
    await expect(page.getByText(/^No instruction files\./)).toBeVisible();
    expect(existsSync(join(root, "baked.md"))).toBe(false);
    await expectBakedStyle(page);

    await page.getByRole("tab", { name: "Preview" }).click();
    await expect(page.getByRole("region", { name: "Rules" })).toContainText(
      "Nothing: agents get no instruction files.",
    );
    await page.getByRole("tab", { name: "Files" }).click();
    // Registering the folder wrote its baked/project.json, with an empty working set.
    await expect(
      page.getByRole("region", { name: "Entries" }).getByText(/^No entries yet\./),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Files" })).toHaveCount(0);
    await expectBakedStyle(page);
    expect(dialogs).toEqual([]);
  });

  test("working set files are added and removed in baked/project.json", async ({
    workspace,
    launch,
  }) => {
    const root = workspace.project("gamma");
    write(join(root, "docs", "guide.md"), "# Guide\n\nStart here.\n");
    write(join(root, "src", "a.ts"), "export const a = 1;\n");
    write(join(root, "src", "b.ts"), "export const b = 2;\n");
    const { page } = await launch(backend);
    const dialogs = failOnNativeDialogs(page);
    await openScreen(page, "Agent context");
    await page.getByRole("tab", { name: "Files" }).click();
    const entries = page.getByRole("region", { name: "Entries" });
    await expect(
      entries.getByText("No entries yet. Add a file, a folder or a glob."),
    ).toBeVisible();
    const entry = page.getByRole("textbox", { name: "Path or glob" });
    const add = page.getByRole("button", { name: "Add", exact: true });
    await expect(add).toBeDisabled();

    await entry.fill("../outside.md");
    await add.click();
    await expect(page.getByText("../outside.md: outside the project roots")).toBeVisible();
    await expectBakedStyle(page);
    const projectFile = join(root, "baked", "project.json");
    expect(readJson(projectFile).workingSet).toEqual([]);

    await entry.fill("docs/guide.md");
    await add.click();
    await expect(entry).toHaveValue("");
    await entry.fill("src/*.ts");
    await add.click();
    await expect(entries.getByText("src/*.ts")).toBeVisible();
    const files = page.getByRole("region", { name: "Files" });
    await expect(files.getByRole("heading", { name: /^Files · 3 · / })).toBeVisible();
    await expect(files.getByRole("cell", { name: "src/b.ts" })).toBeVisible();
    expect(readJson(projectFile).workingSet).toEqual(["docs/guide.md", "src/*.ts"]);

    await page.getByRole("tab", { name: "Preview" }).click();
    await expect(page.getByRole("region", { name: "Files" })).toContainText("Start here.");
    await page.getByRole("tab", { name: "Files" }).click();
    await entries.getByRole("button", { name: "Remove docs/guide.md" }).click();
    await expect(entries.getByText("docs/guide.md")).toHaveCount(0);
    expect(readJson(projectFile).workingSet).toEqual(["src/*.ts"]);
    await page.getByRole("tab", { name: "Preview" }).click();
    const preview = page.getByRole("region", { name: "Files" });
    await expect(preview).toContainText("export const b = 2;");
    await expect(preview).not.toContainText("Start here.");

    await page.getByRole("tab", { name: "Files" }).click();
    await entries.getByRole("button", { name: "Remove src/*.ts" }).click();
    await expect(
      entries.getByText("No entries yet. Add a file, a folder or a glob."),
    ).toBeVisible();
    expect(readJson(projectFile).workingSet).toEqual([]);
    expect(dialogs).toEqual([]);
  });
});
