import { test as base, expect, type Page } from "@playwright/test";

/** The fixed start of the clock: relative times in the fixtures ("12 min ago") stay the same. */
export const NOW = new Date("2026-10-12T09:00:00Z");

/** A mock bridge scenario from `src/renderer/client/mock.ts`. */
export type Scenario =
  | "default"
  | "empty"
  | "start-failure"
  | "older"
  | "uninitialized"
  | "mic-denied";

export const test = base.extend<{ app: (hash: string, scenario?: Scenario) => Promise<Page> }>({
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // The clock starts at NOW and then runs, so streaming fixtures still make progress.
    await page.clock.install({ time: NOW });
    await use(page);
    expect(errors, "uncaught errors in the renderer").toEqual([]);
  },
  /** Opens the renderer at a route (`#/...`) with the given scenario of the mock bridge. */
  app: async ({ page }, use) => {
    await use(async (hash, scenario = "default") => {
      await page.goto(`./?mock=${scenario}${hash}`);
      await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
      return page;
    });
  },
});

export { expect };
