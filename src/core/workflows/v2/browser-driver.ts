/**
 * The browser driver of the AI acceptance gate: a headless Chromium driven through Playwright,
 * with every request routed through the filtering proxy. BAKED does not depend on Playwright and
 * never downloads it or a browser; a project that wants browser walk-throughs installs it.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Text of a snapshot kept per call; the model reads it, the step stores it. */
export const SNAPSHOT_LIMIT = 12000;

/** One page of the walk-through browser, as the gate drives it. */
export interface BrowserPage {
  goto(url: string, timeoutMs: number): Promise<{ status: number | null }>;
  url(): string;
  title(): Promise<string>;
  /** The accessibility tree of the page as text, or its visible text where that is unavailable. */
  snapshot(): Promise<string>;
  click(selector: string, timeoutMs: number): Promise<void>;
  fill(selector: string, text: string, timeoutMs: number): Promise<void>;
  press(key: string, selector: string | undefined, timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserLaunchOptions {
  /** The filtering proxy every request of the browser goes through. */
  proxyServer: string;
}

/** Starts the walk-through browser. The gate checks `missing` before it calls a model. */
export interface BrowserLauncher {
  /** The missing dependency in words, or null when a browser can be launched. */
  missing(workspace: string): Promise<string | null>;
  launch(workspace: string, options: BrowserLaunchOptions): Promise<BrowserPage>;
}

export const MISSING_PLAYWRIGHT =
  "missing dependency: install playwright in the project (for example `bun add -d playwright`); BAKED does not download it";
export const MISSING_BROWSER =
  "missing dependency: no Chromium executable for Playwright; run `bunx playwright install chromium` or set BAKED_BROWSER_EXECUTABLE";

// The few Playwright members the driver uses, typed structurally so no Playwright types are needed.
interface PwLocator {
  first(): PwLocator;
  click(options: { timeout: number }): Promise<void>;
  fill(text: string, options: { timeout: number }): Promise<void>;
  press(key: string, options: { timeout: number }): Promise<void>;
  ariaSnapshot?(options?: { timeout: number }): Promise<string>;
  innerText(options?: { timeout: number }): Promise<string>;
}
interface PwPage {
  goto(
    url: string,
    options: { timeout: number; waitUntil: string },
  ): Promise<{ status(): number } | null>;
  url(): string;
  title(): Promise<string>;
  locator(selector: string): PwLocator;
  keyboard: { press(key: string): Promise<void> };
}
interface PwBrowser {
  newContext(options: Record<string, unknown>): Promise<{ newPage(): Promise<PwPage> }>;
  close(): Promise<void>;
}
interface PwBrowserType {
  executablePath(): string;
  launch(options: Record<string, unknown>): Promise<PwBrowser>;
}

/**
 * Where Playwright is resolved from: the workspace first (the project's own dependency), then
 * BAKED's installation. Only `playwright` and `playwright-core` are tried.
 */
export function resolvePlaywright(workspace: string, includeOwn = true): string | null {
  const bases = [join(workspace, "package.json"), ...(includeOwn ? [import.meta.url] : [])];
  for (const base of bases)
    for (const name of ["playwright", "playwright-core"]) {
      try {
        return createRequire(base).resolve(name);
      } catch {
        // Not installed there.
      }
    }
  return null;
}

async function loadChromium(workspace: string): Promise<PwBrowserType | null> {
  const resolved = resolvePlaywright(workspace);
  if (!resolved) return null;
  try {
    const module = (await import(pathToFileURL(resolved).href)) as {
      chromium?: PwBrowserType;
      default?: { chromium?: PwBrowserType };
    };
    return module.chromium ?? module.default?.chromium ?? null;
  } catch {
    return null;
  }
}

/** The explicit browser executable, when one is configured. */
export const browserExecutable = (): string | undefined =>
  process.env.BAKED_BROWSER_EXECUTABLE || undefined;

/** The Playwright launcher: lazy import, headless Chromium, the proxy forced for loopback too. */
export const playwrightLauncher: BrowserLauncher = {
  async missing(workspace) {
    const chromium = await loadChromium(workspace);
    if (!chromium) return MISSING_PLAYWRIGHT;
    const explicit = browserExecutable();
    if (explicit) return existsSync(explicit) ? null : `${MISSING_BROWSER} (${explicit} not found)`;
    let path: string;
    try {
      // Honours PLAYWRIGHT_BROWSERS_PATH; it only reports a path, it never downloads.
      path = chromium.executablePath();
    } catch {
      return MISSING_BROWSER;
    }
    return path && existsSync(path) ? null : MISSING_BROWSER;
  },
  async launch(workspace, options) {
    const chromium = await loadChromium(workspace);
    if (!chromium) throw new Error(MISSING_PLAYWRIGHT);
    const browser = await chromium.launch({
      headless: true,
      executablePath: browserExecutable(),
      // `<-loopback>` removes Chromium's implicit loopback bypass, so local ports are filtered too.
      proxy: { server: options.proxyServer, bypass: "<-loopback>" },
      args: [
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-quic",
        "--no-pings",
      ],
    });
    try {
      const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      return playwrightPage(await context.newPage(), browser);
    } catch (error) {
      await browser.close();
      throw error;
    }
  },
};

function playwrightPage(page: PwPage, browser: PwBrowser): BrowserPage {
  return {
    async goto(url, timeoutMs) {
      const response = await page.goto(url, { timeout: timeoutMs, waitUntil: "load" });
      return { status: response?.status() ?? null };
    },
    url: () => page.url(),
    title: () => page.title(),
    async snapshot() {
      const body = page.locator("body");
      if (body.ariaSnapshot) {
        try {
          return await body.ariaSnapshot({ timeout: 5000 });
        } catch {
          // Older Playwright or a page without a body: fall back to the text.
        }
      }
      return body.innerText({ timeout: 5000 });
    },
    click: (selector, timeoutMs) => page.locator(selector).first().click({ timeout: timeoutMs }),
    fill: (selector, text, timeoutMs) =>
      page.locator(selector).first().fill(text, { timeout: timeoutMs }),
    press: (key, selector, timeoutMs) =>
      selector
        ? page.locator(selector).first().press(key, { timeout: timeoutMs })
        : page.keyboard.press(key),
    close: () => browser.close(),
  };
}
