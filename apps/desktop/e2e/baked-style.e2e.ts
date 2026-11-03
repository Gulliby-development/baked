import type { Page } from "@playwright/test";
import { PROJECT_SECTIONS, SETTINGS_SECTIONS } from "../src/renderer/router.ts";
import { expectBakedStyle, failOnNativeDialogs } from "./electron/baked-style.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The BAKED style rule on every screen: no control opens a system popup, no native dialog, and no
 * element swaps the app's drawn scrollbar for the system one. Chromium draws the standard
 * `scrollbar-width` / `scrollbar-color` properties natively and then ignores the
 * `::-webkit-scrollbar` styles of base.css, so only `none` (a hidden bar) is allowed.
 *
 * The routes come from the router's own section lists, so a new screen is swept without an edit
 * here. The chat settings pages come from the Settings menu, since the backend names them.
 */
const SETTINGS = SETTINGS_SECTIONS.filter((section) => section !== "chat");
const ROUTES = [
  "#/projects",
  "#/attention",
  ...PROJECT_SECTIONS.map((section) => `#/p/baked/${section}`),
  ...SETTINGS.map((section) => `#/settings/${section}`),
];

async function expectBakedScrollbars(page: Page): Promise<void> {
  const native = await page.evaluate(() => {
    const found: string[] = [];
    for (const el of document.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      const width = style.scrollbarWidth;
      const color = style.scrollbarColor;
      if ((width && width !== "auto" && width !== "none") || (color && color !== "auto"))
        found.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
    }
    return found;
  });
  expect(native, "elements with a system-drawn scrollbar").toEqual([]);
}

async function expectScreen(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
  await expectBakedStyle(page);
  await expectBakedScrollbars(page);
}

for (const theme of ["dark", "light"] as const) {
  test(`every screen draws its controls and scrollbars with BAKED (${theme})`, async ({ app }) => {
    const page = await app("#/settings/app");
    const dialogs = failOnNativeDialogs(page);
    await page.getByRole("button", { name: theme, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const route of ROUTES) {
      await test.step(route, async () => {
        await page.evaluate((hash) => {
          window.location.hash = hash;
        }, route);
        await expectScreen(page);
      });
    }
    expect(dialogs).toEqual([]);
  });
}

test("every chat settings page draws its controls with BAKED", async ({ app }) => {
  const page = await app("#/settings/chat");
  const menu = page.getByRole("navigation", { name: "Settings" });
  const links = await menu.locator('a[href^="#/settings/chat/"]').allTextContents();
  expect(links.length).toBeGreaterThan(5);
  for (const name of links) {
    await test.step(name, async () => {
      await menu.getByRole("link", { name, exact: true }).click();
      await expect(menu.getByRole("link", { name, exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expectScreen(page);
    });
  }
});

/** Dialogs opened from a screen, each checked while it is open and then closed with Escape. */
const DIALOGS: { route: string; open: string | string[]; dialog: string | RegExp }[] = [
  { route: "#/projects", open: "Create project", dialog: /project/i },
  { route: "#/projects", open: "Rename BAKED", dialog: /Rename/ },
  {
    route: "#/p/baked/initiatives",
    open: ["New initiative", "Start without the coordinator"],
    dialog: "New initiative",
  },
  { route: "#/p/baked/initiatives", open: "Export package…", dialog: /Export/ },
  { route: "#/p/baked/runs", open: "Import…", dialog: /Import/ },
  { route: "#/p/baked/runs", open: "Clean up old runs…", dialog: /Clean up/ },
  { route: "#/p/baked/gates", open: "Set up a gate…", dialog: /gate/i },
  { route: "#/p/baked/hooks", open: "New hook", dialog: /hook/i },
  { route: "#/p/baked/mcp", open: "Add server", dialog: /server/i },
  { route: "#/settings/commands", open: "New command", dialog: /command/i },
];

for (const { route, open, dialog } of DIALOGS) {
  const clicks = typeof open === "string" ? [open] : open;
  const title = (typeof dialog === "string" ? dialog : (clicks.at(-1) ?? "")).replace(/…$/, "");
  test(`the ${title} dialog is drawn by BAKED and closes on Escape`, async ({ app }) => {
    const page = await app(route);
    const dialogs = failOnNativeDialogs(page);
    for (const name of clicks)
      await page.getByRole("main").getByRole("button", { name, exact: true }).first().click();
    const box = page.getByRole("dialog", { name: dialog });
    await expect(box).toBeVisible();
    await expectBakedStyle(page);
    await expectBakedScrollbars(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });
}
