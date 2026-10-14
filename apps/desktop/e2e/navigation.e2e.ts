import { expect, test } from "./fixtures.ts";

test("the sidebar moves between All projects, a project, Needs you and Settings", async ({
  app,
}) => {
  const page = await app("#/projects");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(page.getByRole("heading", { name: "All projects", level: 1 })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(4);

  await nav.getByRole("link", { name: /^B BAKED/ }).click();
  await expect(page).toHaveURL(/#\/p\/baked\/coordinator$/);
  await expect(page.getByRole("complementary", { name: "Coordinator brief" })).toBeVisible();
  const items = nav.getByRole("link", { name: /^(Coordinator|Overview|Initiatives)$/ });
  await expect(items).toHaveText(["Coordinator", "Overview", "Initiatives"]);

  await nav.getByRole("link", { name: "Overview" }).click();
  await expect(page).toHaveURL(/#\/p\/baked\/overview$/);
  await expect(page.getByRole("heading", { name: "BAKED", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Runs in this project" })).toBeVisible();

  await nav.getByRole("link", { name: /^Needs you/ }).click();
  await expect(page.getByRole("heading", { name: "Needs you", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Waiting items" }).getByRole("link", {
      name: /^Approve usage-totals/,
    }),
  ).toBeVisible();

  await nav.getByRole("link", { name: "Settings" }).click();
  await expect(
    page.getByRole("heading", { name: "Appearance and behavior", level: 1 }),
  ).toBeVisible();

  await nav.getByRole("link", { name: "All projects" }).click();
  await expect(page.getByRole("heading", { name: "All projects", level: 1 })).toBeVisible();
});

test("opening a closed project from its card starts it and shows its coordinator", async ({ app }) => {
  const page = await app("#/projects");
  const card = page.getByRole("article", { name: "client-api" });
  await expect(card).toContainText("closed");
  await card.getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(/#\/p\/client\/coordinator$/);
  // The coordinator only draws its conversation and brief once the backend runs.
  await expect(page.getByRole("complementary", { name: "Coordinator brief" })).toBeVisible();
});

test("the first start shows an empty project list", async ({ app }) => {
  const page = await app("#/projects", "empty");
  const empty = page.getByText("No projects yet.");
  await expect(empty).toBeVisible();
  await expect(empty.getByRole("button", { name: "Create project" })).toBeVisible();
  await expect(empty.getByRole("button", { name: "Open existing folder…" })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
});

test("a backend that fails to start shows its error, and Restart recovers", async ({ app }) => {
  const page = await app("#/p/baked/overview", "start-failure");
  await page.getByRole("button", { name: "Open project" }).click();
  await expect(page.getByText(/The backend of BAKED stopped: baked serve exited/)).toBeVisible();
  await page.getByRole("button", { name: "Restart" }).click();
  await expect(page.getByRole("region", { name: "Runs in this project" })).toBeVisible();
});

test("an older BAKED gets a 'needs a newer BAKED' notice instead of an error", async ({ app }) => {
  const page = await app("#/p/baked/git", "older");
  await expect(page.getByRole("heading", { name: "Git", level: 1 })).toBeVisible();
  await expect(
    page.getByText(/Needs a newer BAKED: this project's backend cannot show Git/),
  ).toBeVisible();
  await expect(page.getByText("running · 0.0.9")).toBeVisible();
});

test("the plus on the Chat row opens a new chat and explains itself in a tooltip", async ({
  app,
}) => {
  const page = await app("#/p/baked/overview");
  const sidebar = page.getByRole("navigation", { name: "Main" });
  // New chat is a button on the Chat row, not a row of its own among the chats.
  await expect(sidebar.getByText("New chat", { exact: true })).toHaveCount(0);
  const plus = sidebar.getByRole("link", { name: "New chat" });
  await plus.hover();
  await expect(page.getByText("New chat", { exact: true })).toBeVisible();
  await plus.click();
  await expect(page).toHaveURL(/#\/p\/baked\/chat\/new$/);
  await expect(page.getByRole("heading", { name: "New chat" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /^Chat/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
});
