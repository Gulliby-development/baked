import { expect, test } from "./fixtures.ts";

// Chromium's fake microphone plays a beep; the mock bridge "transcribes" by its length.
const chromium = process.env.BAKED_E2E_CHROMIUM;
test.use({
  permissions: ["microphone"],
  launchOptions: {
    ...(chromium ? { executablePath: chromium } : {}),
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});

test("voice input records, transcribes and inserts the text at the caret", async ({ app }) => {
  const page = await app("#/p/baked/chat");
  const prompt = page.getByRole("textbox", { name: "Message BAKED" });
  await prompt.fill("Please ");
  await page.getByRole("button", { name: "Voice input" }).click();
  const stop = page.getByRole("button", { name: "Stop recording and transcribe" });
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status", { name: /^Recording 0:01 of 0:30$/ })).toBeVisible();
  await stop.click();
  await expect(prompt).toHaveValue(/^Please mock transcript of \d+\.\d s$/);
  await expect(page.getByRole("button", { name: "Voice input" })).toBeEnabled();
  await expect(prompt).toBeFocused();
});

test("the shortcut starts and stops a recording", async ({ app }) => {
  const page = await app("#/p/baked/chat");
  const prompt = page.getByRole("textbox", { name: "Message BAKED" });
  await prompt.click();
  await page.keyboard.press("Control+Shift+Space");
  await expect(page.getByRole("status", { name: /^Recording 0:01/ })).toBeVisible();
  await page.keyboard.press("Control+Shift+Space");
  await expect(prompt).toHaveValue(/^mock transcript of/);
});

test("Settings turns the microphone button off and picks the language", async ({ app }) => {
  const page = await app("#/settings/app");
  const voice = page.getByRole("region", { name: "Voice input" });
  await expect(voice).toContainText("English, German, French, Spanish, Italian, Dutch, Polish");
  await expect(voice.getByRole("status")).toHaveText("Speech engine ready.");
  await voice.getByLabel("Language").selectOption("de");
  await voice.getByLabel("Microphone button in the chat composer").uncheck();
  await expect(voice.getByLabel("Language")).toBeDisabled();
  // The mock keeps settings in memory, so move by hash instead of reloading.
  await page.evaluate(() => {
    window.location.hash = "#/p/baked/chat";
  });
  await expect(page.getByRole("textbox", { name: "Message BAKED" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Voice input" })).toHaveCount(0);
});

test("a refused microphone explains itself and offers the system settings", async ({ app }) => {
  const page = await app("#/p/baked/chat", "mic-denied");
  await page.getByRole("button", { name: "Voice input" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Microphone access is blocked");
  await expect(alert.getByRole("button", { name: "Open microphone settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Voice input" })).toBeEnabled();
});
