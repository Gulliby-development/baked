import { defineConfig } from "@playwright/test";

/**
 * Live scenarios of the built Electron app (`out/`) against the repository's own `baked serve`
 * and a real model: `BAKED_LIVE_MODEL=<provider/model> bun run e2e:live`, under a display
 * (`xvfb-run -a` on Linux). Not run in CI; see docs/desktop/app.md and bench/scenarios/AGENTS.md.
 */
export default defineConfig({
  testDir: "e2e/live",
  testMatch: "**/*.live.ts",
  outputDir: "test-results/live",
  // One app at a time, and a model turn takes minutes.
  workers: 1,
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/live/report.json" }],
    ["html", { open: "never", outputFolder: "playwright-report/live" }],
  ],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
