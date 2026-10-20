import assert from "node:assert/strict";
import { test } from "node:test";
import { topWords } from "./src/wordfreq.js";

test("counts", () => {
  assert.deepEqual(topWords("The cat; the DOG. the cat's toy", 2), [
    { word: "the", count: 3 },
    { word: "cat", count: 1 },
  ]);
});

test("validates", () => {
  assert.throws(() => topWords(1, 2), TypeError);
  assert.throws(() => topWords("a", 0), TypeError);
});
