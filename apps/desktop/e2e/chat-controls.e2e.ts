import { expect, test } from "./fixtures.ts";

test("the model, effort and mode chips open BAKED popovers and keep the choice", async ({
  app,
}) => {
  const page = await app("#/p/baked/chat");
  const model = page.getByRole("button", { name: /^Model:/ });
  await expect(model).toHaveAccessibleName("Model: claude-sonnet-5-5");
  await model.click();
  const models = page.getByRole("dialog", { name: "Model" });
  const anthropic = models.getByRole("group", { name: "Anthropic" });
  await expect(anthropic.getByRole("button", { name: /^Claude Sonnet 5\.5/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await anthropic.getByRole("button", { name: /^Claude Opus 5\.5/ }).click();
  await expect(models).toHaveCount(0);
  await expect(model).not.toHaveAccessibleName("Model: claude-sonnet-5-5");
  await expect(model).toHaveAccessibleName(/opus/i);

  const effort = page.getByRole("button", { name: /^Reasoning effort:/ });
  await effort.click();
  const efforts = page.getByRole("dialog", { name: "Reasoning effort" });
  await expect(efforts).toContainText("Applies from the next turn.");
  await efforts.getByRole("button", { name: "High", exact: true }).click();
  await expect(effort).toHaveAccessibleName("Reasoning effort: High");

  const mode = page.getByRole("button", { name: /^Mode:/ });
  await mode.click();
  const modes = page.getByRole("dialog", { name: "Mode" });
  await modes.getByRole("button", { name: /^Plan first/ }).click();
  await expect(mode).toHaveAccessibleName(/^Mode: Plan first/);

  // Escape closes a popover without changing the choice.
  await mode.click();
  await expect(modes).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modes).toHaveCount(0);
  await expect(mode).toHaveAccessibleName(/^Mode: Plan first/);
});

test("Fork from here asks about the files, Cancel keeps the chat, and Chat only forks it", async ({
  page,
  app,
}) => {
  await app("#/p/baked/chat");
  const conversation = page.getByRole("region", { name: "Conversation" });
  await conversation.getByRole("button", { name: "Fork from here" }).first().click();
  const ask = conversation.getByRole("group", { name: "Fork from here" });
  await expect(ask).toContainText("Roll the files back too?");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);

  const before = page.url();
  await conversation.getByRole("button", { name: "Fork from here" }).first().click();
  await ask.getByRole("button", { name: "Chat only" }).click();
  await expect(page).not.toHaveURL(before);
  await expect(page.getByText("Forked the chat. Files were left as they are.")).toBeVisible();
});
