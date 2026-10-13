import { expect, test } from "./fixtures.ts";

test("a project without agents from other tools shows nothing about agents", async ({ app }) => {
  const page = await app("#/p/client/workflows");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Workflows" })).toBeVisible();
  await expect(nav.getByRole("link", { name: /^Agents/ })).toHaveCount(0);
  await expect(page.getByText(/can become a workflow/)).toHaveCount(0);
});

test("agents from other tools become a workflow and their files go", async ({ app }) => {
  const page = await app("#/p/baked/workflows");
  await expect(page.getByText("4 agents from Claude Code and GitHub Copilot can become a workflow.")).toBeVisible();
  await page.getByRole("link", { name: "Convert" }).click();

  await expect(page.getByRole("heading", { name: "Agents from other tools", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Make them a workflow" })).toBeVisible();
  await expect(page.getByText("Not used: conductor")).toBeVisible();

  // Two agents on one station is refused; moving one back clears it.
  await page.getByLabel("Station of frontend-dev").selectOption("plan");
  await page.getByRole("button", { name: "Turn into a workflow" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Plan takes one agent; architect and frontend-dev are both on it.");
  await expect(dialog.getByRole("button", { name: "Make workflow agents" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Not now" }).click();
  await page.getByLabel("Station of frontend-dev").selectOption("implement");

  await page.getByRole("button", { name: "Turn into a workflow" }).click();
  await expect(dialog).toContainText("Plan ← architect · Implement ← frontend-dev · Review ← security-auditor");
  await expect(dialog).toContainText(".claude/agents/architect.md");
  await dialog.getByRole("button", { name: "Make workflow agents" }).click();

  await expect(page.getByRole("heading", { name: "Workflow agents" })).toBeVisible();
  await expect(page.getByText("Workflow agents now runs 3 agents as its steps and removed 3 agent files.")).toBeVisible();
  await expect(page.getByText("frontend-dev asked for model sonnet")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open in the editor" })).toHaveAttribute("href", "#/p/baked/workflows/agents");
  // The orchestrator stays until it is removed; then the section leaves the sidebar.
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: /^Agents/ })).toBeVisible();
  await page.getByRole("button", { name: "Remove conductor" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove the file" }).click();
  await expect(nav.getByRole("link", { name: /^Agents/ })).toHaveCount(0);
});

test("an agent's file is edited in place", async ({ app }) => {
  const page = await app("#/p/baked/agents");
  await page.getByRole("listitem").filter({ hasText: "architect" }).getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Edit architect" })).toBeVisible();
  const save = dialog.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  await dialog.getByRole("textbox").fill("---\nname: architect\n---\nPlan in small steps.\n");
  await save.click();
  await expect(dialog).toHaveCount(0);
});
