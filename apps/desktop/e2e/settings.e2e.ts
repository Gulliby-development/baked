import { expect, test } from "./fixtures.ts";

test("the theme setting applies at once and survives navigation", async ({ app }) => {
  const page = await app("#/settings/app");
  const theme = page.getByRole("group", { name: "Theme" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await theme.getByRole("button", { name: "light" }).click();
  await expect(theme.getByRole("button", { name: "light" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "All projects" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("a behavior checkbox keeps its new value", async ({ app }) => {
  const page = await app("#/settings/app");
  const advisory = page.getByRole("checkbox", { name: "Also notify for advisory items" });
  await expect(advisory).not.toBeChecked();
  await advisory.check();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "All projects" })
    .click();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Also notify for advisory items" }),
  ).toBeChecked();
});
