import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/**
 * The project tools (Git, Code graph, Artifacts, Workflows, Agents from other tools) against the
 * repository's own `baked serve`: every action is checked by what it left on disk, in Git or in
 * the backend, and every question is the app's own dialog, never a native one.
 */

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

const git = (cwd: string, command: string): string =>
  execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();

/** A Git repository with its own identity, one commit and README.md. */
function repository(root: string): void {
  execSync("git init -q -b main", { cwd: root });
  git(root, "config user.email e2e@baked.dev");
  git(root, "config user.name e2e");
  writeFileSync(join(root, "README.md"), "first\n");
  git(root, "add README.md");
  git(root, "commit -q -m init");
}

/** A feature check in the project's policy, which a saved copy of `quick` needs. */
function withFeatureCheck(root: string): void {
  mkdirSync(join(root, ".baked"), { recursive: true });
  writeFileSync(
    join(root, ".baked", "config.json"),
    JSON.stringify({
      workflows: {
        enabled: true,
        policy: {
          checks: [
            {
              id: "readme",
              executable: "bun",
              args: ["-e", "0"],
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

async function openProject(page: Page, project = "gamma") {
  await page.getByRole("article", { name: project }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });

/** Fails the test on any native alert, confirm or prompt: questions are the app's own dialogs. */
function noNativeDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on("dialog", (dialog) => {
    seen.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return seen;
}

const scripted = { script: { turns: [] } };

test("Git commits, branches, stashes and reports a failed pull in the app", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  repository(root);
  const { page } = await launch(scripted);
  const native = noNativeDialogs(page);
  await openProject(page);
  await nav(page).getByRole("link", { name: "Git", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Git", level: 1 })).toBeVisible();
  // Everything `baked projects add` left behind goes into the first commit with the change.
  writeFileSync(join(root, "README.md"), "second\n");
  await page.getByRole("button", { name: "Refresh" }).click();
  const changes = page.getByRole("region", { name: "Changes" });
  await expect(changes.getByRole("listitem").filter({ hasText: "README.md" })).toBeVisible();

  // Commit with Stage all changes.
  const commit = changes.getByRole("button", { name: "Commit" });
  await expect(commit).toBeDisabled();
  await changes.getByRole("textbox", { name: "Commit message" }).fill("Update the readme");
  await changes.getByRole("checkbox", { name: "Stage all changes" }).check();
  await commit.click();
  await expect(changes.getByText("Working tree clean.")).toBeVisible();
  expect(git(root, "log -1 --format=%s")).toBe("Update the readme");
  expect(git(root, "status --porcelain")).toBe("");
  await expect(
    page.getByRole("region", { name: "History" }).getByRole("button", { name: /^Update the readme/ }),
  ).toBeVisible();

  // A new branch from here, switched to.
  const branches = page.getByRole("region", { name: "Branches" });
  await branches.getByRole("button", { name: "+ New branch" }).click();
  await branches.getByRole("textbox", { name: "New branch" }).fill("feature/e2e-branch");
  await branches.getByRole("button", { name: "Create and switch" }).click();
  await expect(branches.getByRole("button", { name: /^feature\/e2e-branch/ })).toBeVisible();
  expect(git(root, "branch --show-current")).toBe("feature/e2e-branch");
  expect(git(root, "branch --format='%(refname:short)'").split("\n").sort()).toEqual([
    "feature/e2e-branch",
    "main",
  ]);

  // Stash a change, then pop it back.
  writeFileSync(join(root, "README.md"), "stashed\n");
  await page.getByRole("button", { name: "Refresh" }).click();
  const stashes = page.getByRole("region", { name: "Stashes" });
  await stashes.getByRole("textbox", { name: "Stash message" }).fill("e2e work in progress");
  await stashes.getByRole("button", { name: "Stash changes" }).click();
  await expect(stashes.getByRole("listitem").filter({ hasText: "e2e work in progress" })).toBeVisible();
  expect(readFileSync(join(root, "README.md"), "utf8")).toBe("second\n");
  expect(git(root, "stash list")).toContain("e2e work in progress");
  await stashes.getByRole("button", { name: "Pop latest" }).click();
  await expect(stashes.getByRole("listitem")).toHaveCount(0);
  await expect(stashes.getByRole("button", { name: "Pop latest" })).toBeDisabled();
  expect(readFileSync(join(root, "README.md"), "utf8")).toBe("stashed\n");
  expect(git(root, "stash list")).toBe("");

  // Pull without an upstream fails in a status line; the screen keeps working.
  await page.getByRole("button", { name: "Pull" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText(
    /Pull failed: There is no tracking information/,
  );
  await expect(changes.getByRole("listitem").filter({ hasText: "README.md" })).toBeVisible();

  // Push asks in the app's dialog first, and the refusal stays in that dialog.
  await page.getByRole("button", { name: "Push", exact: true }).click();
  const ask = page.getByRole("dialog", { name: "Push to the remote?" });
  await expect(ask).toContainText("has no upstream branch");
  await ask.getByRole("button", { name: "Push", exact: true }).click();
  await expect(ask).toContainText("Push failed");
  await ask.getByRole("button", { name: "Keep" }).click();
  await expect(ask).toBeHidden();
  expect(git(root, "log -1 --format=%s")).toBe("Update the readme");
  expect(native).toEqual([]);
});

test("the code graph draws the files, finds one and inspects its imports", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  repository(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "b.ts"), "export const b = () => 1;\n");
  writeFileSync(join(root, "src", "a.ts"), 'import { b } from "./b";\nexport const a = () => b();\n');
  writeFileSync(join(root, "src", "main.ts"), 'import { a } from "./a";\nconsole.log(a());\n');
  workspace.project("empty");
  const { page } = await launch(scripted);
  await openProject(page);
  await nav(page).getByRole("link", { name: "Code graph" }).click();

  const blocks = page.locator('svg[aria-label="Code graph of gamma"] g.unit');
  await expect(blocks).toHaveCount(3, { timeout: 30_000 });
  expect((await blocks.evaluateAll((all) => all.map((g) => g.getAttribute("aria-label")))).sort())
    .toEqual(["a.ts, 3 lines", "b.ts, 2 lines", "src/main.ts, 3 lines"]);
  await expect(page.getByText("3 files · every file shown")).toBeVisible();
  const inspector = page.getByRole("complementary");
  await expect(inspector.getByRole("button", { name: "src/b.ts #1" })).toBeVisible();

  // Find a file: the match is selected and the inspector shows who uses it.
  const find = page.getByRole("searchbox", { name: "Find a file" });
  await find.fill("b.ts");
  await page.getByRole("button", { name: "src/b.ts", exact: true }).click();
  await expect(inspector.getByRole("heading", { name: "src/b.ts", level: 3 })).toBeVisible();
  const usedBy = inspector.locator("section").filter({ has: page.getByRole("heading", { name: "Used by" }) });
  await expect(usedBy.getByRole("button", { name: /src\/a\.ts/ })).toBeVisible();
  await find.fill("nothing-like-this");
  await expect(page.getByText("No file matches")).toBeVisible();

  // Clicking a block opens its details.
  await blocks.and(page.locator('[aria-label^="a.ts,"]')).click();
  await expect(inspector.getByRole("heading", { name: "src/a.ts", level: 3 })).toBeVisible();
  const imports = inspector.locator("section").filter({ has: page.getByRole("heading", { name: "Imports from" }) });
  await expect(imports.getByRole("button", { name: /src\/b\.ts/ })).toBeVisible();

  // A project without code has nothing to draw.
  await nav(page).getByRole("link", { name: "All projects" }).click();
  await openProject(page, "empty");
  await nav(page).getByRole("link", { name: "Code graph" }).click();
  await expect(page.getByText("Nothing to draw yet")).toBeVisible({ timeout: 30_000 });
});

test("an artifact saved by the CLI shows, previews and is deleted after the app's question", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  const home = join(workspace.dir, "home");
  const store = join(home, ".baked", "artifacts");
  const { page } = await launch(scripted);
  const native = noNativeDialogs(page);
  await openProject(page);
  await nav(page).getByRole("link", { name: "Artifacts" }).click();
  await expect(page.getByText(/^No artifacts yet\./)).toBeVisible();

  writeFileSync(
    join(root, "page.html"),
    "<!doctype html><title>Launch notes</title><h1>Hello from the artifact</h1>",
  );
  const cli = (...args: string[]) =>
    execFileSync("bun", ["run", join(repoRoot, "src", "boot.tsx"), "artifacts", ...args], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      encoding: "utf8",
      timeout: 60_000,
    });
  const saved = JSON.parse(cli("save", "page.html", "--title", "Launch notes", "--json")) as {
    id: string;
    version: number;
  };
  expect(saved).toMatchObject({ id: "launch-notes", version: 1 });
  expect(existsSync(join(store, "launch-notes", "v1.html"))).toBe(true);

  // The screen keeps its last answer for a while; a reload reads the store again.
  await page.reload();
  const item = page.getByRole("list", { name: "Artifacts" }).getByRole("button", {
    name: /^Launch notes launch-notes v1/,
  });
  await expect(item).toHaveAttribute("aria-pressed", "true");
  const details = page.getByRole("region", { name: "Artifact Launch notes" });
  await expect(details.getByText("Not deployed yet.")).toBeVisible();
  await expect(
    details.frameLocator('iframe[title="Preview of Launch notes"]').getByRole("heading", {
      name: "Hello from the artifact",
    }),
  ).toBeVisible();

  // Keep leaves it; Delete removes every version from disk.
  await details.getByRole("button", { name: "Delete…" }).click();
  const ask = page.getByRole("dialog", { name: "Delete Launch notes?" });
  await expect(ask).toContainText("Every version of the page is removed from every project.");
  await ask.getByRole("button", { name: "Keep" }).click();
  await expect(ask).toBeHidden();
  expect(existsSync(join(store, "launch-notes"))).toBe(true);
  await details.getByRole("button", { name: "Delete…" }).click();
  await ask.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(/^No artifacts yet\./)).toBeVisible();
  expect(existsSync(join(store, "launch-notes"))).toBe(false);
  expect(readdirSync(store).filter((name) => !name.startsWith("."))).toEqual([]);
  expect(JSON.parse(cli("list", "--json"))).toEqual([]);
  expect(native).toEqual([]);
});

test("project workflows list from disk and built-in ones stay read only", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  repository(root);
  withFeatureCheck(root);
  const { page } = await launch(scripted);
  const native = noNativeDialogs(page);
  await openProject(page);
  await nav(page).getByRole("link", { name: "Workflows" }).click();
  const sources = page.getByRole("group", { name: "Source" });
  await expect(sources.getByRole("button", { name: "Project 0" })).toBeVisible();

  // A built-in workflow opens read only; its copy is written to the project after the question.
  await page.getByRole("link", { name: "quick", exact: true }).click();
  await expect(page.getByText("Built-in workflows are read only.")).toBeVisible();
  await page.getByRole("button", { name: "Duplicate as custom" }).click();
  await expect(page.getByRole("heading", { name: "quick-custom", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "Save…" }).click();
  await page
    .getByRole("dialog", { name: "Write the workflow file?" })
    .getByRole("button", { name: "Write file" })
    .click();
  const file = join(root, "baked", "workflows", "quick-custom.json");
  await expect(page.getByText("baked/workflows/quick-custom.json", { exact: true })).toBeVisible();
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ id: "quick-custom" });

  await page.getByRole("link", { name: "← All workflows" }).click();
  await expect(sources.getByRole("button", { name: "Project 1" })).toBeVisible();
  await sources.getByRole("button", { name: "Project 1" }).click();
  await expect(page.getByRole("article", { name: "Workflow quick-custom" })).toContainText("project");
  await expect(page.getByRole("article", { name: "Workflow quick", exact: true })).toBeHidden();

  // A workflow file removed from disk leaves the list once it is read again.
  rmSync(file);
  await page.reload();
  await expect(sources.getByRole("button", { name: "Project 0" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Workflow quick-custom" })).toBeHidden();
  await expect(page.getByRole("article", { name: "Workflow quick", exact: true })).toBeVisible();
  expect(native).toEqual([]);
});

test("a Claude Code agent becomes a workflow, then its file is removed after the question", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  repository(root);
  const agentFile = join(root, ".claude", "agents", "reviewer.md");
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(
    agentFile,
    "---\nname: reviewer\ndescription: Reviews code changes\n---\nReview the diff for missing tests.\n",
  );
  const { page } = await launch(scripted);
  const native = noNativeDialogs(page);
  await openProject(page);

  // The Workflows screen points at the agents.
  await nav(page).getByRole("link", { name: "Workflows" }).click();
  await expect(page.getByText("1 agent from Claude Code can become a workflow.")).toBeVisible();
  await page.getByRole("link", { name: "Convert" }).click();
  await expect(page.getByRole("heading", { name: "Agents from other tools", level: 1 })).toBeVisible();
  const agents = page.getByRole("main").getByRole("list").filter({ hasText: ".claude/agents/reviewer.md" });
  await expect(page.getByRole("combobox", { name: "Station of reviewer" })).toHaveValue("review");

  // Convert, keeping the agent file.
  await page.getByRole("button", { name: "Turn into a workflow" }).click();
  const convert = page.getByRole("dialog", { name: "Turn the agents into a workflow" });
  await expect(convert).toContainText("Review ← reviewer");
  await convert.getByRole("textbox", { name: "Workflow ID" }).fill("from-agents");
  const removeFiles = convert.getByRole("switch", { name: "Remove the agent files afterwards" });
  await expect(removeFiles).toBeChecked();
  await removeFiles.click();
  await expect(removeFiles).not.toBeChecked();
  await convert.getByRole("button", { name: "Make workflow from-agents" }).click();
  await expect(convert).toBeHidden();
  await expect(page.getByRole("heading", { name: "Workflow from-agents", level: 2 })).toBeVisible();

  const workflowFile = join(root, "baked", "workflows", "from-agents.json");
  expect(existsSync(workflowFile)).toBe(true);
  expect(readFileSync(workflowFile, "utf8")).toContain("reviewer");
  expect(existsSync(agentFile)).toBe(true);

  // The agent is still in the project; Keep leaves it, Remove the file deletes it.
  await expect(page.getByText("Still in the project")).toBeVisible();
  await agents.getByRole("button", { name: "Remove reviewer" }).click();
  const ask = page.getByRole("dialog", { name: "Remove reviewer?" });
  await expect(ask).toContainText(".claude/agents/reviewer.md");
  await ask.getByRole("button", { name: "Keep" }).click();
  await expect(ask).toBeHidden();
  expect(existsSync(agentFile)).toBe(true);
  await agents.getByRole("button", { name: "Remove reviewer" }).click();
  await ask.getByRole("button", { name: "Remove the file" }).click();
  await expect(ask).toBeHidden();
  await expect(page.getByText("Still in the project")).toBeHidden();
  expect(existsSync(agentFile)).toBe(false);
  expect(existsSync(workflowFile)).toBe(true);

  // The workflow made from it is a project workflow in the editor.
  await page.getByRole("link", { name: "Open in the editor" }).click();
  await expect(page.getByRole("heading", { name: "from-agents", level: 2 })).toBeVisible();
  await page.getByRole("link", { name: "← All workflows" }).click();
  await expect(page.getByRole("article", { name: "Workflow from-agents" })).toContainText("project");
  await expect(page.getByText(/can become a workflow/)).toBeHidden();
  expect(native).toEqual([]);
});
