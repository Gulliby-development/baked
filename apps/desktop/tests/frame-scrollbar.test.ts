import { describe, expect, test } from "bun:test";
import { type ScrollbarTokens, withAppScrollbar } from "../src/renderer/lib/frame-scrollbar.ts";

const tokens: ScrollbarTokens = {
  "--line-strong": "#aa825d",
  "--ink": "#302015",
  "--bg": "#fffaf2",
  "--fill-accent": "#ff9d52",
  "--border-w": "2px",
  "--radius": "6px",
};

describe("framed page scrollbar", () => {
  test("goes first in the head, so the page's own styles still win", () => {
    const html = '<!doctype html><html><head lang="en"><style>body{}</style></head><body></body></html>';
    const out = withAppScrollbar(html, tokens);
    expect(out.indexOf("data-baked-scrollbar")).toBeGreaterThan(out.indexOf('<head lang="en">'));
    expect(out.indexOf("data-baked-scrollbar")).toBeLessThan(out.indexOf("<style>body"));
    expect(out).toContain("border:2px solid #302015");
    expect(out).toContain("background:#ff9d52");
  });

  test("a page without a head gets it after the doctype, or at the start", () => {
    expect(withAppScrollbar("<!DOCTYPE html><p>hi</p>", tokens)).toMatch(
      /^<!DOCTYPE html><style data-baked-scrollbar>[\s\S]*<\/style><p>hi<\/p>$/,
    );
    expect(withAppScrollbar("<p>hi</p>", tokens)).toMatch(/^<style data-baked-scrollbar>/);
  });

  test("a token value cannot close the style tag", () => {
    const out = withAppScrollbar("<p></p>", { ...tokens, "--ink": "red</style><script>" });
    expect(out.match(/<\/style>/g)).toHaveLength(1);
    expect(out).not.toContain("<script>");
  });
});
