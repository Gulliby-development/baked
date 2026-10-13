import { expect, test } from "./fixtures.ts";

test("a full run starts from the project home and opens its detail", async ({ app }) => {
  const page = await app("#/p/baked/overview");
  await page
    .getByRole("textbox", { name: "What should change?" })
    .fill("Add a --json flag to baked usage");
  await page.getByRole("button", { name: "Full run" }).click();

  const form = page.getByRole("form", { name: "New workflow run" });
  await expect(form.getByRole("textbox", { name: "What should change?" })).toHaveValue(
    "Add a --json flag to baked usage",
  );
  await expect(form.getByRole("button", { name: /^sdd / })).toHaveAttribute("aria-pressed", "true");
  await form.getByRole("button", { name: "Start run" }).click();

  await expect(page).toHaveURL(/#\/p\/baked\/runs\/run-add-a-json-flag/);
  await expect(page.getByRole("heading", { name: "add-a-json-flag-to", level: 2 })).toBeVisible();
  await expect(page.getByText("running · research")).toBeVisible();
  await expect(page.getByRole("region", { name: "Station Research" })).toBeVisible();

  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "All runs" })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Workflow runs" })
      .getByRole("table")
      .getByRole("link", { name: "add-a-json-flag-to" }),
  ).toBeVisible();
});

test("a plan approval is answered from Needs you", async ({ app }) => {
  const page = await app("#/attention");
  await page
    .getByRole("region", { name: "Waiting items" })
    .getByRole("link", { name: /^Approve usage-totals/ })
    .click();
  const item = page.getByRole("region", { name: "Selected item" });
  await expect(item.getByRole("heading", { name: "Approve usage-totals" })).toBeVisible();
  const approve = item.getByRole("button", { name: "Approve" });
  // The tasks write a file with uncommitted changes, so the choice comes first.
  await expect(approve).toBeDisabled();
  await item
    .getByRole("checkbox", { name: "Leave my uncommitted changes out of this run" })
    .check();
  await approve.click();
  await expect(
    page
      .getByRole("region", { name: "Waiting items" })
      .getByRole("link", { name: /^Approve usage-totals/ }),
  ).toBeHidden();
});

test("a run is exported and an artifact redacted from the run screen", async ({ app }) => {
  const page = await app("#/p/baked/runs/run-settings-dark-mode");
  await page.getByRole("button", { name: "Export" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Exported to" })).toContainText(
    ".baked\\exports\\run-settings-dark-mode-",
  );

  await page.getByRole("button", { name: "Redact…" }).click();
  const dialog = page.getByRole("dialog", { name: "Redact an artifact?" });
  await dialog.getByRole("button", { name: "Redact" }).click();
  await expect(dialog.getByText("Say why the content is removed.")).toBeVisible();
  await dialog.getByRole("textbox", { name: "Reason" }).fill("Remove a pasted key");
  await dialog.getByRole("button", { name: "Redact" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Redacted" })).toBeVisible();
});

test("the run list previews a cleanup and imports a spec folder", async ({ app }) => {
  const page = await app("#/p/baked/runs");
  await page.getByRole("button", { name: "Clean up old runs…" }).click();
  const cleanup = page.getByRole("dialog", { name: "Clean up old runs" });
  await cleanup.getByRole("button", { name: "Preview" }).click();
  await expect(cleanup.getByRole("status")).toContainText("Nothing to clean up");
  await cleanup.getByRole("button", { name: "Done" }).click();

  await page.getByRole("button", { name: "Import…" }).click();
  const importing = page.getByRole("dialog", { name: "Import a spec or agents" });
  await importing.getByRole("textbox", { name: "Folder" }).fill("specs/feature");
  await importing.getByRole("textbox", { name: "Feature ID" }).fill("imported");
  await importing.getByRole("button", { name: "Import" }).click();
  await expect(importing.getByRole("status")).toContainText("Imported as candidate");
  await expect(importing.getByRole("status")).toContainText("Markdown imported as a draft");
});

test("a blocked run says why it stopped", async ({ app }) => {
  const page = await app("#/p/baked/runs/run-locale-validation");
  const why = page.getByRole("region", { name: "Why the run stopped" });
  await expect(why).toContainText("The run is blocked: the token, call or time budget is used up.");
  await expect(why).toContainText("Run token budget of 600000 would be exceeded");
  await expect(page.getByText(/^The run is blocked\. Why it stopped is shown above/)).toBeVisible();
});

test("active runs ride their conveyor above the list", async ({ app }) => {
  const page = await app("#/p/baked/runs");
  const live = page.getByRole("region", { name: "On the line now" });
  await expect(live.getByRole("article").first()).toBeVisible();
  await expect(live.locator("[data-station]").first()).toBeVisible();
  await expect(page.getByRole("table").getByRole("img", { name: /^Stages: / }).first()).toBeVisible();
});
