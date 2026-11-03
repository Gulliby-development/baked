import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  escapeHtml,
  startupErrorAction,
  startupErrorDetails,
  startupErrorPage,
  startupErrorUrl,
} from "../src/main/startup-error.ts";

describe("startup error page (#2686)", () => {
  test("escapes the error text so it cannot inject markup", () => {
    const html = startupErrorPage(`<script>alert("x")</script> & <img src=x onerror='y'>`);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain(
      "<pre>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;img src=x onerror=&#39;y&#39;&gt;</pre>",
    );
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  test("is self-contained: no scripts or remote resources, a locked-down CSP", () => {
    const html = startupErrorPage("boom");
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
    expect(html).not.toMatch(/<script|<link|src=|url\(/i);
    expect(html).toContain("prefers-color-scheme: light");
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toContain('href="baked-startup:copy">Copy details<');
    expect(html).toContain('href="baked-startup:quit">Quit<');
  });

  test("the data URL round-trips to the page", () => {
    const url = startupErrorUrl("a # b % c");
    expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(startupErrorPage("a # b % c"));
  });

  test("details carry the stack, or the stringified value", () => {
    const error = new Error("no backend");
    expect(startupErrorDetails(error)).toContain("Error: no backend");
    expect(startupErrorDetails(error)).toContain("startup-error.test.ts");
    expect(startupErrorDetails("plain")).toBe("plain");
  });

  test("only the page's two links are actions", () => {
    expect(startupErrorAction("baked-startup:copy")).toBe("copy");
    expect(startupErrorAction("baked-startup:quit")).toBe("quit");
    expect(startupErrorAction("baked-startup:quit?x")).toBeNull();
    expect(startupErrorAction("https://example.com/")).toBeNull();
  });

  test("the main process keeps the native box only as the fallback", () => {
    const main = readFileSync(join(import.meta.dir, "..", "src", "main", "index.ts"), "utf8");
    expect(main.match(/dialog\.showErrorBox/g)?.length).toBe(1);
    const fallback = main.slice(main.indexOf("async function showStartupError"));
    expect(fallback.indexOf("startupErrorUrl(")).toBeLessThan(fallback.indexOf("showErrorBox"));
    expect(main).toContain("app.whenReady().then(boot).catch(showStartupError)");
  });
});
