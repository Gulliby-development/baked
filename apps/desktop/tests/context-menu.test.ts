import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ContextMenu, MENU_POPUP } from "../src/renderer/components/ui/context-menu.tsx";
import {
  type ContextField,
  type ContextTarget,
  contextMenuItems,
} from "../src/renderer/lib/context-menu.ts";

const field = (over: Partial<ContextField> = {}): ContextField => ({
  readOnly: false,
  secret: false,
  hasSelection: false,
  hasText: false,
  ...over,
});
const target = (over: Partial<ContextTarget> = {}): ContextTarget => ({
  field: null,
  selection: "",
  link: null,
  ...over,
});
const shown = (t: ContextTarget) =>
  contextMenuItems(t).map((group) =>
    group.map((item) => `${item.label}${item.disabled ? " (off)" : ""}`),
  );

describe("right-click menu items", () => {
  test("offers nothing on plain content, so the menu stays closed", () => {
    expect(contextMenuItems(target())).toEqual([]);
    expect(contextMenuItems(target({ selection: "  \n" }))).toEqual([]);
  });

  test("an empty field can only be pasted into", () => {
    expect(shown(target({ field: field() }))).toEqual([
      ["Cut (off)", "Copy (off)", "Paste"],
      ["Select all (off)"],
    ]);
  });

  test("a field with selected text offers every edit action", () => {
    expect(shown(target({ field: field({ hasSelection: true, hasText: true }) }))).toEqual([
      ["Cut", "Copy", "Paste"],
      ["Select all"],
    ]);
  });

  test("a read-only field can be copied from but not changed", () => {
    expect(
      shown(target({ field: field({ readOnly: true, hasSelection: true, hasText: true }) })),
    ).toEqual([["Cut (off)", "Copy", "Paste (off)"], ["Select all"]]);
  });

  test("a password field never gives its text away", () => {
    expect(
      shown(target({ field: field({ secret: true, hasSelection: true, hasText: true }) })),
    ).toEqual([["Cut (off)", "Copy (off)", "Paste"], ["Select all"]]);
  });

  test("selected page text offers Copy, a link offers Copy link", () => {
    expect(shown(target({ selection: "hello" }))).toEqual([["Copy"]]);
    expect(shown(target({ link: "https://example.com/" }))).toEqual([["Copy link"]]);
    expect(shown(target({ selection: "hello", link: "https://example.com/" }))).toEqual([
      ["Copy"],
      ["Copy link"],
    ]);
  });

  test("edit actions carry their shortcut key, Copy link has none", () => {
    const [edit, all] = contextMenuItems(target({ field: field() }));
    expect(edit?.map((item) => item.key)).toEqual(["X", "C", "V"]);
    expect(all?.[0]?.key).toBe("A");
    expect(contextMenuItems(target({ link: "https://x.dev/" }))[0]?.[0]?.key).toBeUndefined();
  });
});

describe("right-click menu component", () => {
  test("renders nothing until a right-click opens it", () => {
    expect(renderToStaticMarkup(createElement(ContextMenu))).toBe("");
  });

  test("pops in with the kit's motion and stops it under reduced motion", () => {
    expect(MENU_POPUP).toContain("border-2 border-border");
    expect(MENU_POPUP).toContain("shadow-shadow");
    expect(MENU_POPUP).toContain("data-starting-style:scale-95");
    expect(MENU_POPUP).toContain("motion-reduce:transition-none");
  });
});
