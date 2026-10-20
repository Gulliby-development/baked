import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, sort } from "./src/semver.js";

test("precedence", () => {
  assert.equal(compare("1.0.0", "1.0.0"), 0);
  assert.equal(compare("1.10.0", "1.9.0"), 1);
  assert.equal(compare("1.0.0-alpha", "1.0.0"), -1);
  assert.equal(compare("1.0.0-alpha.10", "1.0.0-alpha.9"), 1);
  assert.deepEqual(sort(["1.0.0", "1.0.0-beta", "1.0.0-alpha.1", "1.0.0-alpha"]), [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-beta",
    "1.0.0",
  ]);
});

test("invalid", () => {
  assert.throws(() => compare("1.0", "1.0.0"), /1\.0/);
});
