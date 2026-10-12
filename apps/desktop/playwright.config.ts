import { defineConfig } from "@playwright/test";

/**
 * UI tests of the renderer in Chromium against the mock bridge (`e2e/`, `bun run e2e`). The
 * renderer is built with `vite build` and served statically by `vite preview`. No browser is
 * downloaded: tests use the installed Google Chrome, or the Chromium at BAKED_E2E_CHROMIUM.
 */
const PORT = 4199;
const ci = Boolean(process.env.CI);
const chromium = process.env.BAKED_E2E_CHROMIUM;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: ci,
  workers: ci ? 2 : undefined,
  reporter: ci
    ? [["github"], ["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    viewport: { width: 1400, height: 900 },
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(chromium ? { launchOptions: { executablePath: chromium } } : { channel: "chrome" }),
  },
  webServer: {
    command: `bunx vite preview --config vite.config.ts --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !ci,
    timeout: 30_000,
  },
});
