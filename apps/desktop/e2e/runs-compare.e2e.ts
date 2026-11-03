import { expect, test } from "./fixtures.ts";

test("two runs picked in the list are compared side by side and the view closes", async ({
  app,
}) => {
  const page = await app("#/p/baked/runs");
  const runs = page.getByRole("region", { name: "Workflow runs" });
  const compare = runs.getByRole("button", { name: /^Compare \d\/2/ });
  await expect(compare).toHaveText(/0\/2/);
  await expect(compare).toBeDisabled();

  await runs.getByRole("checkbox", { name: /^Compare usage-totals/ }).check();
  await expect(compare).toHaveText(/1\/2/);
  await expect(compare).toBeDisabled();
  await runs.getByRole("checkbox", { name: /^Compare settings-dark-mode/ }).check();
  await expect(compare).toHaveText(/2\/2/);
  await compare.click();

  const view = runs.getByRole("region", { name: "Run comparison" });
  await expect(view.getByRole("heading", { level: 2 })).toHaveText(
    "Compare run-usage-totals (A) and run-settings-dark-mode (B)",
  );
  await expect(view).toContainText("A and B are different features");
  await expect(view.getByRole("table", { name: "Routes that differ" })).toContainText(
    "provider/model-b",
  );
  const result = view.getByRole("table", { name: "Result" });
  await expect(result.getByRole("row", { name: /^Tokens/ })).toContainText("+252k");
  await expect(result.getByRole("row", { name: /^Estimated cost/ })).toContainText("+$0.76");
  await expect(
    view.getByRole("table", { name: "Tokens by stage" }).getByRole("row", { name: /^implement/ }),
  ).toContainText("–");

  await view.getByRole("button", { name: "Close" }).click();
  await expect(view).toHaveCount(0);
});

test("the status filter narrows the run table and All brings every run back", async ({ app }) => {
  const page = await app("#/p/baked/runs");
  const runs = page.getByRole("region", { name: "Workflow runs" });
  const filter = runs.getByRole("group", { name: "Filter by status" });
  const rows = runs.getByRole("table").last().getByRole("rowgroup").last().getByRole("row");
  const all = await rows.count();
  expect(all).toBeGreaterThan(3);

  await filter.getByRole("button", { name: "Completed" }).click();
  await expect(filter.getByRole("button", { name: "Completed" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(rows.first()).toContainText("completed");
  expect(await rows.count()).toBeLessThan(all);
  for (let i = 0; i < (await rows.count()); i++)
    await expect(rows.nth(i).getByRole("cell").nth(3)).toHaveText("completed");

  await filter.getByRole("button", { name: "All" }).click();
  await expect(rows).toHaveCount(all);
});
