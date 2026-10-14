import { expect, test } from "./fixtures.ts";

test("a folder without baked/project.json explains how to set it up", async ({ app }) => {
  const page = await app("#/p/client/overview", "uninitialized");
  await expect(page.getByRole("heading", { name: "client-api", level: 1 })).toBeVisible();
  const setup = page.getByRole("complementary", { name: "Project setup" });
  await expect(setup).toContainText("This folder has no baked/project.json");
  await expect(setup).toContainText("Run baked project init in the folder");
  await expect(page.getByText("No workflow runs yet.")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Agent context" })
    .click();
  await expect(page.getByRole("heading", { name: "Agent context", level: 1 })).toBeVisible();
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByText(/This folder has no baked\/project\.json yet/)).toBeVisible();
});

test("Check code intelligence lists every backend with its probes", async ({ app }) => {
  const page = await app("#/p/baked/lsp");
  await page.getByRole("button", { name: "Check code intelligence" }).click();
  const check = page.getByRole("region", { name: "Code intelligence check" });
  await expect(check).toContainText("Code intelligence check · typescript");
  await expect(check).toContainText("tree-sitter");
  await expect(check).toContainText("Working");
  await expect(check).toContainText("getDiagnostics —");
  await expect(page.getByRole("button", { name: "Restart all" })).toBeVisible();
});

test("the old Instructions and Working set links open the Agent context tabs", async ({ app }) => {
  const page = await app("#/p/baked/working-set");
  await expect(page.getByRole("heading", { name: "Agent context", level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Prompt budget" })).toBeVisible();

  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.getByRole("region", { name: "Rules" })).toContainText("Prefer small");

  await page.goto(page.url().replace(/#.*/, "#/p/baked/instructions"));
  await expect(page.getByRole("tab", { name: "Rules" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Sources agents read" })).toBeVisible();
});

// #1106: skills a package installed show on the Skills screen with their package, read-only.
test("skills from packages are listed with their package and no Remove", async ({ app }) => {
  const page = await app("#/p/baked/skills");
  const group = page.getByRole("region", { name: "From packages" });
  await expect(group.getByText("review-notes")).toBeVisible();
  await expect(group.getByText("From the package acme-review")).toBeVisible();
  await expect(group.getByRole("button", { name: "Remove review-notes" })).toHaveCount(0);
  await group.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("dialog").getByText("# review-notes")).toBeVisible();
});
