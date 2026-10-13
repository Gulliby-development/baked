import { expect, test } from "bun:test";
import { canonical, hashJson } from "../src/core/specs/hash.js";

test("canonical JSON leaves out undefined object values like JSON.stringify (#929)", () => {
  expect(canonical({ b: 1, a: undefined, c: [null, { d: undefined }] })).toBe('{"b":1,"c":[null,{}]}');
  expect(hashJson({ a: 1, b: undefined })).toBe(hashJson({ a: 1 }));
});

test("a value JSON cannot hold is refused with its key path", () => {
  expect(() => canonical({ task: { tokens: [1, Number.NaN] } })).toThrow(
    "Cannot hash a non-JSON value at $.task.tokens[1]: NaN",
  );
  expect(() => canonical([undefined])).toThrow("at $[0]: undefined");
  expect(() => canonical({ at: new Date(0) })).toThrow("at $.at: Date");
});
