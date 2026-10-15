/**
 * The opt-in layout measurement of sdd runs (#1262): the host serves the app the policy's
 * `layoutCheck` names, opens each page in a headless Chromium at the viewport and reads whether
 * the document is wider than the viewport. It settles the spec's layout criteria ("pages fit a
 * 1280 px wide viewport without horizontal scrolling") without a model or a person; zoneslot-update
 * 129e4cd7 AC-008 waited on a manual_evidence request for the same DOM read (#1247).
 */
import { buildSafeEnv } from "../spawn.js";
import { workspacePath } from "../specs/validate.js";
import type { LayoutCheck } from "./schemas.js";
import {
  type LayoutPage,
  type LayoutReading,
  launchLayoutPage,
  playwrightLauncher,
} from "./v2/browser-driver.js";
import { TerminalApp } from "./v2/terminal-driver.js";

export interface LayoutPageResult extends LayoutReading {
  path: string;
  httpStatus: number | null;
}

export type LayoutResult =
  | {
      status: "measured";
      width: number;
      height: number;
      pages: LayoutPageResult[];
      /** PNG screenshot of the first page at the viewport, base64. */
      screenshot?: string;
    }
  | { status: "unavailable"; reason: string };

/** Measures the pages of a layout check. Tests inject a fake one. */
export interface LayoutProbe {
  measure(workspace: string, check: LayoutCheck, signal: AbortSignal): Promise<LayoutResult>;
}

/** Whether the measurement shows every page fits its viewport, and why not when it does not. */
export function layoutVerdict(result: LayoutResult): { passed: boolean; reason: string } {
  if (result.status === "unavailable") return { passed: false, reason: result.reason };
  const failures = result.pages.flatMap((page) => {
    if (page.httpStatus !== null && page.httpStatus >= 400)
      return [`${page.path} answered HTTP ${page.httpStatus}`];
    if (page.scrollWidth > page.clientWidth)
      return [
        `${page.path} is ${page.scrollWidth} px wide in a ${page.clientWidth} px viewport${page.overflowing[0] ? ` (widest: ${page.overflowing[0].element} to ${page.overflowing[0].right} px)` : ""}`,
      ];
    return [];
  });
  return failures.length
    ? { passed: false, reason: failures.join("; ") }
    : {
        passed: true,
        reason: `${result.pages.length} page(s) fit a ${result.width} px wide viewport without horizontal scrolling`,
      };
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Polls the address until the app answers anything, the app exits or the time is up. */
async function served(url: string, app: TerminalApp, until: number, signal: AbortSignal) {
  while (Date.now() < until && !signal.aborted && !app.exited) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
}

/** The real probe: the declared command without a shell, then Playwright's Chromium. */
export const browserLayoutProbe: LayoutProbe = {
  async measure(workspace, check, signal) {
    const missing = await playwrightLauncher.missing(workspace);
    if (missing) return { status: "unavailable", reason: missing };
    const env = buildSafeEnv();
    for (const name of check.start.envNames)
      if (process.env[name] !== undefined) env[name] = process.env[name];
    const port = new URL(check.url).port;
    if (port) env.PORT = port;
    const cwd = check.start.cwd === "." ? workspace : workspacePath(workspace, check.start.cwd);
    const executable = check.start.executable === "bun" ? process.execPath : check.start.executable;
    const app = new TerminalApp(executable, check.start.args, { cwd, env, sandbox: null });
    let page: LayoutPage | null = null;
    try {
      try {
        await app.start();
      } catch (error) {
        return { status: "unavailable", reason: `the app did not start: ${message(error)}` };
      }
      app.closeInput();
      const until = Date.now() + check.timeoutMs;
      if (!(await served(check.url, app, until, signal)))
        return {
          status: "unavailable",
          reason: `the app did not answer at ${check.url}${app.exited ? ` (exited ${app.exited.exitCode ?? app.exited.signal})` : ""}: ${app.frame(5)}`,
        };
      page = await launchLayoutPage(workspace, { width: check.width, height: check.height });
      const base = check.url.replace(/\/$/, "");
      const pages: LayoutPageResult[] = [];
      let screenshot: string | undefined;
      for (const path of check.pages) {
        signal.throwIfAborted();
        const httpStatus = await page.goto(`${base}${path}`, Math.max(1000, until - Date.now()));
        pages.push({ path, httpStatus, ...(await page.read()) });
        screenshot ??= await page.screenshot();
      }
      return {
        status: "measured",
        width: check.width,
        height: check.height,
        pages,
        ...(screenshot ? { screenshot } : {}),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return { status: "unavailable", reason: `the measurement failed: ${message(error)}` };
    } finally {
      await page?.close().catch(() => undefined);
      await app.stop();
    }
  },
};
