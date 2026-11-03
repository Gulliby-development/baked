import { expect, test } from "./fixtures.ts";

test("Needs you filters by project and shows the selected item's detail", async ({ app }) => {
  const page = await app("#/attention");
  const list = page.getByRole("region", { name: "Waiting items" });
  const filter = list.getByRole("group", { name: "Filter by project" });
  await expect(filter.getByRole("button", { name: "All · 7" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(list.getByRole("link")).toHaveCount(7);

  await filter.getByRole("button", { name: "site · 1" }).click();
  await expect(list.getByRole("link")).toHaveCount(1);
  await expect(list.getByRole("link").first()).toContainText("Pricing page copy");

  await filter.getByRole("button", { name: "All · 7" }).click();
  await expect(list.getByRole("link")).toHaveCount(7);

  // A click opens an item's detail.
  const detail = page.getByRole("region", { name: "Selected item" });
  await expect(detail.getByRole("heading", { level: 2 })).toHaveText("Billing v2: plan approval");
  await list.getByRole("link", { name: /^Approve usage-totals/ }).click();
  await expect(detail.getByRole("heading", { level: 2 })).toContainText("usage-totals");
});
