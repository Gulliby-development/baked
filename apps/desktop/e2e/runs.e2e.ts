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
