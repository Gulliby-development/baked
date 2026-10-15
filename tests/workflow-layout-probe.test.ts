import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserLayoutProbe, layoutVerdict } from "../src/core/workflows/layout-check.js";
import type { LayoutCheck } from "../src/core/workflows/schemas.js";
import { playwrightLauncher } from "../src/core/workflows/v2/browser-driver.js";

// The real probe of the layout check (#1262) against a served page, with the Playwright of the
// desktop app's end-to-end tests. Without it or its Chromium there is nothing to drive.
const DESKTOP_MODULES = resolve(import.meta.dir, "../apps/desktop/node_modules");
const hasPlaywright = existsSync(join(DESKTOP_MODULES, "playwright"));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const freePort = () =>
  new Promise<number>((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });

const SERVE = `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch(request) {
  const wide = new URL(request.url).pathname === "/wide";
  return new Response(\`<!doctype html><html><body style="margin:0"><main>slots</main>\${wide ? '<div class="grid" style="width:2000px">wide</div>' : '<div style="overflow-x:auto"><div style="width:3000px">scrolls inside</div></div>'}</body></html>\`, { headers: { "content-type": "text/html" } });
} });
console.log("ready");
`;

describe.skipIf(!hasPlaywright)("the browser layout probe", () => {
  test("measures served pages at the viewport and names what is too wide", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-layout-probe-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    symlinkSync(DESKTOP_MODULES, join(root, "node_modules"), "junction");
    if (await playwrightLauncher.missing(root)) return;
    writeFileSync(join(root, "serve.ts"), SERVE);
    const check: LayoutCheck = { start: { executable: "bun", args: ["serve.ts"], cwd: ".", envNames: [] }, url: `http://127.0.0.1:${await freePort()}`, pages: ["/", "/wide"], width: 1280, height: 800, timeoutMs: 30000 };
    const result = await browserLayoutProbe.measure(root, check, new AbortController().signal);
    if (result.status !== "measured") throw new Error(result.reason);
    const [fits, wide] = result.pages;
    // A scrolling region keeps its content inside: the page itself fits.
    expect(fits).toMatchObject({ path: "/", httpStatus: 200, overflowing: [] });
    expect(fits?.scrollWidth).toBe(fits?.clientWidth ?? 0);
    expect(wide?.scrollWidth).toBe(2000);
    expect(wide?.overflowing[0]).toEqual({ element: "div.grid", right: 2000 });
    expect(result.screenshot?.length).toBeGreaterThan(100);
    expect(layoutVerdict(result)).toEqual({ passed: false, reason: `/wide is 2000 px wide in a ${fits?.clientWidth} px viewport (widest: div.grid to 2000 px)` });
  }, 60000);
});
