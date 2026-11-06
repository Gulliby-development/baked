import { expect, test } from "./fixtures.ts";

test("approval rules are switched on, added and removed in the coordinator", async ({ app }) => {
  const page = await app("#/p/baked/coordinator");
  const rules = page.getByRole("region", { name: "Approval rules" });
  const ruleList = rules.getByRole("list").first().getByRole("listitem");
  const on = rules.getByRole("switch", { name: "Answer approvals by these rules" });
  await expect(on).not.toBeChecked();
  await expect(rules).toContainText("Off: every approval waits for you.");
  await on.click();
  await expect(on).toBeChecked();
  await expect(rules).not.toContainText("Off: every approval waits for you.");

  // A new rule: Web searches is the default kind, and Cancel adds nothing.
  await rules.getByRole("button", { name: "Add a rule" }).click();
  const form = rules.getByRole("form", { name: "Add an approval rule" });
  const kinds = form.getByRole("group", { name: "What the rule approves" });
  await expect(kinds.getByRole("button", { name: "Web searches" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toHaveCount(0);
  await expect(ruleList).toHaveCount(1);

  await rules.getByRole("button", { name: "Add a rule" }).click();
  await form.getByRole("button", { name: "Add rule" }).click();
  await expect(form).toHaveCount(0);
  await expect(ruleList).toHaveCount(2);
  await expect(rules).toContainText("web searches");

  await rules
    .getByRole("button", {
      name: "Remove the rule: Approve fetching pages from docs.github.com, bun.sh",
    })
    .click();
  await expect(ruleList).toHaveCount(1);
  await expect(rules).not.toContainText("docs.github.com");
  // Rules that answered approvals before stay in the log.
  await expect(rules.getByRole("region", { name: "Answered by rules" })).toContainText(
    "Approved fetching https://bun.sh/docs/api/sqlite",
  );
});

test("the context meter opens a BAKED popover with Compact now and closes on Escape", async ({
  app,
}) => {
  const page = await app("#/p/baked/coordinator");
  const meter = page.getByRole("button", { name: /% context$/ });
  await meter.click();
  await expect(meter).toHaveAttribute("aria-expanded", "true");
  const popover = page.getByRole("dialog", { name: "Context" });
  await expect(popover.getByRole("button", { name: "Compact now" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(meter).toHaveAttribute("aria-expanded", "false");
});
