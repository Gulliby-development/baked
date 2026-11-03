import { expect, test } from "./fixtures.ts";

test("a memory is pinned, hidden and restored, and the search narrows the list", async ({
  app,
}) => {
  const page = await app("#/p/baked/memory");
  const memories = page.getByRole("region", { name: "Memories" });
  const hidden = page.getByRole("region", { name: "Hidden" });
  const item = (text: string) => memories.getByRole("listitem").filter({ hasText: text });
  const commits = "Keep commit subjects under 60 characters.";

  await item(commits).getByRole("button", { name: "Pin" }).click();
  await expect(item(commits).getByRole("img", { name: "Pinned" })).toBeVisible();
  await item(commits).getByRole("button", { name: "Unpin" }).click();
  await expect(item(commits).getByRole("img", { name: "Pinned" })).toHaveCount(0);

  await memories.getByRole("button", { name: `Hide ${commits}` }).click();
  await expect(item(commits)).toHaveCount(0);
  await expect(hidden).toContainText(commits);
  await hidden
    .getByRole("listitem")
    .filter({ hasText: commits })
    .getByRole("button", { name: "Restore" })
    .click();
  await expect(item(commits)).toHaveCount(1);
  await expect(hidden).not.toContainText(commits);

  const search = memories.getByRole("textbox", { name: "Search memories" });
  await search.fill("bun");
  await expect(memories.getByRole("list").getByRole("listitem")).toHaveCount(1);
  await expect(item("Use bun for scripts")).toBeVisible();
  await search.fill("");
  await expect(memories.getByRole("list").getByRole("listitem")).toHaveCount(4);
});
