import { describe, expect, test } from "bun:test";
import { evaluate } from "./src/query.ts";

const nest = (depth: number, inner: unknown): unknown => (depth === 0 ? inner : [nest(depth - 1, inner)]);
const idx = (n: number) => `$${"[0]".repeat(n)}`;

describe("evaluate", () => {
  test("selects properties and elements", () => {
    expect(evaluate("$", 5)).toBe(5);
    expect(evaluate("$.items[2].name", { items: [{}, {}, { name: "x" }] })).toBe("x");
    expect(evaluate("$.a_1", { a_1: true })).toBe(true);
    expect(evaluate("$[10]", Array.from({ length: 11 }, (_, i) => i))).toBe(10);
  });
  test("selecting nothing gives undefined", () => {
    expect(evaluate("$.missing", {})).toBeUndefined();
    expect(evaluate("$[3]", [1])).toBeUndefined();
    expect(evaluate("$.a", 4)).toBeUndefined();
    expect(evaluate("$[0]", { 0: 1 })).toBeUndefined();
    expect(evaluate("$.a.b", { a: null })).toBeUndefined();
  });
  test("ten segments are allowed, the eleventh is past the limit", () => {
    expect(evaluate(idx(10), nest(10, 7))).toBe(7);
    expect(() => evaluate(idx(11), nest(11, 7))).toThrow("depth limit exceeded at segment 11");
    expect(() => evaluate("$.a.b.c.d.e.f.g.h.i.j.k", {})).toThrow("depth limit exceeded at segment 11");
    expect(() => evaluate(idx(12), [])).toThrow("depth limit exceeded at segment 11");
  });
  test("invalid syntax names the offset", () => {
    expect(() => evaluate("$.items[02]", {})).toThrow("invalid query at offset 9");
    expect(() => evaluate("$..a", {})).toThrow("invalid query at offset 2");
    expect(() => evaluate("a", {})).toThrow("invalid query at offset 0");
    expect(() => evaluate("$.1a", {})).toThrow("invalid query at offset 2");
    expect(() => evaluate("$[1", [])).toThrow("invalid query at offset 3");
    expect(() => evaluate("$[]", [])).toThrow("invalid query at offset 2");
  });
});
