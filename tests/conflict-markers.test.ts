import { expect, test } from "bun:test";
import { findConflictMarkers } from "../scripts/check-conflict-markers.js";

// Built at runtime so this file never holds a marker itself.
const open = `${"<".repeat(7)} HEAD`;
const split = "=".repeat(7);
const close = `${">".repeat(7)} feature`;

test("finds every line of a conflict block", () => {
  const text = ["a", open, "ours", split, "theirs", close, "b"].join("\n");
  expect(findConflictMarkers(text).map((m) => m.line)).toEqual([2, 4, 6]);
});

test("ignores a Markdown heading underline outside a conflict", () => {
  expect(findConflictMarkers(`Title\n${split}\n\ntext\n`)).toEqual([]);
});

test("finds a stray closing marker on its own", () => {
  expect(findConflictMarkers(`x\r\n${close}\r\n`)).toEqual([{ line: 2, text: close }]);
});

test("ignores longer runs and markers inside a line", () => {
  expect(findConflictMarkers(`${"<".repeat(8)}\nx ${open}\n`)).toEqual([]);
});
