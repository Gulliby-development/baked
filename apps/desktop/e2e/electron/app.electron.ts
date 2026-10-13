import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";

test("opening a project starts its backend and shows the project home", async ({
  workspace,
  launch,
}) => {
  workspace.project("alpha");
  const { page } = await launch();
  const card = page.getByRole("article", { name: "alpha" });
  await expect(card).toContainText("closed");
  await card.getByRole("button", { name: "Open" }).click();
  // The home loaded through preload IPC, the main process and the backend's bearer token.
  // A project opens on its coordinator; Overview is the next item.
  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { name: "alpha", level: 1 })).toBeVisible();
  await expect(page.getByText("running · 9.9.9")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "All projects" })
    .click();
  await card.getByRole("button", { name: "Close" }).click();
  await expect(card).toContainText("closed");
  await expect(card.getByRole("button", { name: "Open" })).toBeVisible();
});

test("a backend that crashes at start shows its error, and Restart recovers", async ({
  workspace,
  launch,
}) => {
  const folder = workspace.project("beta");
  const crash = join(folder, ".fake-serve-crash");
  writeFileSync(crash, "");
  const { page } = await launch();
  const card = page.getByRole("article", { name: "beta" });
  await card.getByRole("button", { name: "Open" }).click();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "All projects" })
    .click();
  // Every restart crashes too, so the app gives up and shows the backend's stderr.
  await expect(card.getByText("fake serve: database is locked")).toBeVisible();
  await expect(card).toContainText("backend stopped");

  rmSync(crash);
  await card.getByRole("button", { name: "Restart" }).click();
  await expect(card.getByText("fake serve: database is locked")).toBeHidden();
  // The restarted backend answers: its attention stream reaches the card.
  await expect(card).toContainText("Approve beta-first");
});

test("Needs you merges two open projects and resumes a dropped stream", async ({
  workspace,
  launch,
}) => {
  workspace.project("alpha");
  workspace.project("beta");
  const { page } = await launch();
  for (const name of ["alpha", "beta"]) {
    const card = page.getByRole("article", { name });
    await card.getByRole("button", { name: "Open" }).click();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "All projects" })
      .click();
  }

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /^Needs you/ })
    .click();
  const list = page.getByRole("region", { name: "Waiting items" });
  // Each backend ends its attention stream after the first item; the second item comes only to
  // a reconnect that sends Last-Event-ID.
  for (const name of ["alpha", "beta"]) {
    await expect(
      list.getByRole("link", { name: new RegExp(`^Approve ${name}-first`) }),
    ).toBeVisible();
    await expect(
      list.getByRole("link", { name: new RegExp(`^Approve ${name}-second`) }),
    ).toBeVisible();
  }
  await expect(list.getByRole("group", { name: "Filter by project" })).toContainText("All · 4");

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "All projects" })
    .click();
  await page.getByRole("article", { name: "beta" }).getByRole("button", { name: "Close" }).click();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /^Needs you/ })
    .click();
  await expect(list.getByRole("link", { name: /^Approve beta-/ })).toHaveCount(0);
  await expect(list.getByRole("link", { name: /^Approve alpha-/ })).toHaveCount(2);
});
