import { expect, test } from "bun:test";
import { sumColumn } from "./src/csv.ts";

test("sums with quotes and blanks", () => {
  expect(sumColumn('a,b\n1,"x, y"\n2,z\n,w', "a")).toBe(3);
});

test("errors", () => {
  expect(() => sumColumn("a\n1\nx", "a")).toThrow(/3/);
  expect(() => sumColumn("a\n1", "nope")).toThrow(/nope/);
});
