import { expect, test } from "./fixtures.ts";

test("an artifact is previewed and deployed after the confirmation", async ({ app }) => {
  const page = await app("#/p/baked/artifacts");
  const list = page.getByRole("list", { name: "Artifacts" });
  await expect(list.getByRole("button", { name: /Release notes 0\.3/ })).toHaveAttribute("aria-pressed", "true");
  await list.getByRole("button", { name: /Token use by round/ }).click();
  const details = page.getByRole("region", { name: "Artifact Token use by round" });
  await expect(details.getByTitle("Preview of Token use by round")).toBeVisible();
  await expect(details.getByText("Not deployed yet.")).toBeVisible();

  await details.getByRole("button", { name: "Open in browser" }).click();
  await expect(details.getByRole("status")).toHaveText("Opened in your browser.");

  await details.getByRole("button", { name: "Deploy preview…" }).click();
  const dialog = page.getByRole("dialog", { name: "Deploy a preview?" });
  await expect(dialog).toContainText("goes to the Vercel project baked-token-chart in your personal account");
  await dialog.getByRole("button", { name: "Deploy preview" }).click();
  await expect(dialog).toBeHidden();
  await expect(details.getByRole("status")).toHaveText("Deployed: https://baked-token-chart-new.vercel.app");
  await expect(details.getByRole("list", { name: "Deploys" })).toContainText("https://baked-token-chart-new.vercel.app");
});
