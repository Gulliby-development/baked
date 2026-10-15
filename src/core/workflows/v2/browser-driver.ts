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

/** What a layout measurement reads on one page (layout-check.ts). */
export interface LayoutReading {
  scrollWidth: number;
  clientWidth: number;
  /** The widest elements past the viewport's right edge outside a scrolling container. */
  overflowing: { element: string; right: number }[];
}

/** A page at a fixed viewport, for the host's layout measurement. */
export interface LayoutPage {
  goto(url: string, timeoutMs: number): Promise<number | null>;
  read(): Promise<LayoutReading>;
  /** A PNG screenshot of the viewport, base64. */
  screenshot(): Promise<string>;
  close(): Promise<void>;
}

// Runs in the page: document width against the viewport, and the elements that stick out of it
// without a scrolling ancestor that contains them.
const READ_LAYOUT = `(() => {
  const doc = document.documentElement;
  const width = doc.clientWidth;
  const scrolls = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const x = getComputedStyle(p).overflowX; if (x === "auto" || x === "scroll" || x === "hidden" || x === "clip") return true; } return false; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
  const overflowing = [];
  for (const el of document.body ? document.body.querySelectorAll("*") : []) {
    const right = el.getBoundingClientRect().right + window.scrollX;
    if (right > width + 0.5 && !scrolls(el)) overflowing.push({ element: name(el), right: Math.round(right) });
  }
  overflowing.sort((a, b) => b.right - a.right);
  return { scrollWidth: doc.scrollWidth, clientWidth: width, overflowing: overflowing.slice(0, 10) };
})()`;

const LOOPBACK_URL = /^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;

/**
 * Opens a headless Chromium page at the viewport for the layout measurement. Requests to anything
 * but loopback are aborted, so the measured app cannot reach the network through the browser.
 */
export async function launchLayoutPage(
  workspace: string,
  viewport: { width: number; height: number },
): Promise<LayoutPage> {
  const chromium = await loadChromium(workspace);
  if (!chromium) throw new Error(MISSING_PLAYWRIGHT);
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable() });
  try {
    const context = (await browser.newContext({
      viewport,
      serviceWorkers: "block",
      acceptDownloads: false,
    })) as unknown as {
      route(
        pattern: string,
        handler: (route: {
          request(): { url(): string };
          continue(): Promise<void>;
          abort(): Promise<void>;
        }) => Promise<void>,
      ): Promise<void>;
      newPage(): Promise<
        PwPage & {
          evaluate<T>(expression: string): Promise<T>;
          screenshot(options: { type: "png" }): Promise<Uint8Array>;
        }
      >;
    };
    await context.route("**/*", (route) =>
      LOOPBACK_URL.test(route.request().url()) || route.request().url().startsWith("data:")
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    return {
      async goto(url, timeoutMs) {
        const response = await page.goto(url, { timeout: timeoutMs, waitUntil: "load" });
        return response?.status() ?? null;
      },
      read: () => page.evaluate<LayoutReading>(READ_LAYOUT),
      async screenshot() {
        return Buffer.from(await page.screenshot({ type: "png" })).toString("base64");
      },
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
