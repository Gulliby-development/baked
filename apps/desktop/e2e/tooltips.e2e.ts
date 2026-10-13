import { expect, test } from "./fixtures.ts";

test("a title shows as a BAKED tooltip, not the native one", async ({ app }) => {
  const page = await app("#/p/baked/chat", "no-voice");
  const mic = page.getByRole("button", { name: "Voice input" });
  await expect(mic).toBeDisabled();
  await expect(mic).toHaveAttribute("title", /^The speech engine is not installed\./);
  // A disabled button still gets the hover, as its native tooltip did.
  await mic.hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toHaveText(/^The speech engine is not installed\. Run "bun run stage:voice"/);
  // The native tooltip needs the attribute, so it is set aside while the pointer is there.
  await expect(mic).not.toHaveAttribute("title");
  const box = await tip.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport && box.x >= 0 && box.x + box.width <= viewport.width).toBe(true);

  await page.mouse.move(5, 5);
  await expect(tip).toHaveCount(0);
  await expect(mic).toHaveAttribute("title", /^The speech engine is not installed\./);
});

test("the tooltip closes on Escape", async ({ app }) => {
  const page = await app("#/p/baked/chat", "no-voice");
  const mic = page.getByRole("button", { name: "Voice input" });
  await mic.hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(mic).toHaveAttribute("title", /speech engine/);
});
