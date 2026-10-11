import { describe, expect, test } from "bun:test";
import { matchCommands, slashAtCaret } from "../src/renderer/screens/chat/commands.ts";

describe("composer custom commands", () => {
  test("offer commands only while the message is one word starting with /", () => {
    expect(slashAtCaret("/", 1)).toEqual({ query: "" });
    expect(slashAtCaret("/Fix", 4)).toEqual({ query: "fix" });
    expect(slashAtCaret("/fix-ci lint", 12)).toBeNull();
    expect(slashAtCaret("see /fix", 8)).toBeNull();
    expect(slashAtCaret("/fix\nmore", 9)).toBeNull();
    expect(slashAtCaret("/fix-ci lint", 4)).toEqual({ query: "fix" });
  });

  test("list prefix matches first, then names that contain the text", () => {
    const commands = [{ name: "/ci:fix" }, { name: "/fix-ci" }, { name: "/standup" }];
    expect(matchCommands(commands, "").map((c) => c.name)).toEqual(["/ci:fix", "/fix-ci", "/standup"]);
    expect(matchCommands(commands, "fix").map((c) => c.name)).toEqual(["/fix-ci", "/ci:fix"]);
    expect(matchCommands(commands, "zzz")).toEqual([]);
  });
});
