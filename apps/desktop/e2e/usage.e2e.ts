import { expect, test } from "./fixtures.ts";

test("Usage shows the figures at a glance and a colour-headed section per breakdown", async ({
  app,
}) => {
  const page = await app("#/p/baked/usage");
  await expect(page.getByRole("button", { name: /Total tokens/ })).toContainText("2.14M");
  await expect(page.getByRole("button", { name: /Served from cache/ })).toContainText("61%");
  await expect(page.getByRole("img", { name: /^Token mix: Cache reads 61%/ })).toBeVisible();

  const stages = page.getByRole("region", { name: "Tokens by stage" });
  await expect(stages.getByRole("list", { name: "Stages" })).toContainText("Implement");
  await expect(page.getByRole("region", { name: "By model" })).toContainText("claude-sonnet-5-5");
  await expect(page.getByRole("region", { name: "By stage and model" })).toBeVisible();

  await page.getByRole("button", { name: /^Cost/ }).click();
  await expect(page.getByRole("region", { name: "By model" })).toBeInViewport();

  await page.getByRole("combobox", { name: "Model" }).selectOption("gpt-5.1");
  await expect(page.getByRole("region", { name: "By model" })).not.toContainText(
    "claude-sonnet-5-5",
  );
});
