import { describe, expect, test } from "bun:test";
import { reached } from "../src/renderer/screens/runs/RunLine.tsx";

describe("run line", () => {
  test("the rail fills up to the last station that started", () => {
    expect(reached([{ state: "done" }, { state: "current" }, { state: "pending" }])).toBe(1);
    expect(reached([{ state: "pending" }, { state: "pending" }])).toBe(-1);
    expect(reached([{ state: "done" }, { state: "skipped" }, { state: "failed" }])).toBe(2);
  });
});
