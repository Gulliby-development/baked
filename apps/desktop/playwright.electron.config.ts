import { defineConfig } from "@playwright/test";

/**
 * UI tests of the built Electron app (`out/`, from `bun run build`) against a fake `baked`
 * (`tests/fixtures/fake-serve.ts`): `bun run e2e:electron`, under a display (`xvfb-run -a` on
 * Linux). Each test gets a throwaway home, so the suite never reads the developer's own.
 */
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: "e2e/electron",
  testMatch: "**/*.electron.ts",
  outputDir: "test-results/electron",
  // One Electron app at a time: each starts its own backends.
  workers: 1,
  forbidOnly: ci,
  timeout: 60_000,
  reporter: ci
    ? [
        ["github"],
        ["list"],
        ["html", { open: "never", outputFolder: "playwright-report/electron" }],
      ]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report/electron" }]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
