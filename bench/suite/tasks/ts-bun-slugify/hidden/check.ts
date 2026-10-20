import { expect, test } from "bun:test";
import { slugify } from "./src/slug.ts";

test("basic", () => {
  expect(slugify("Hello, World!")).toBe("hello-world");
  expect(slugify("  --a__b--  ")).toBe("a-b");
  expect(slugify("Cr\u00e8me Br\u00fbl\u00e9e")).toBe("creme-brulee");
  expect(slugify("!!!")).toBe("");
});

test("max length", () => {
  expect(slugify("aaaa bbbb", 5)).toBe("aaaa");
  expect(slugify("x".repeat(80)).length).toBe(60);
});
