import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { editedFiles, sessionDiffStats } from "../src/core/chat/diff-stats.js";
import {
  assembleCompacted,
  compactionBlocker,
  splitForCompaction,
} from "../src/core/compaction/manual.js";
import type { ChatMessage } from "../src/types/index.js";
import { withTempDir } from "./helpers/temp-dir.js";

const user = (content: string): ModelMessage => ({ role: "user", content });
const assistant = (content: string): ModelMessage => ({ role: "assistant", content });
const toolCall = (id: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: {} }],
});
const toolResult = (id: string): ModelMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value: "x" } }],
});

describe("manual compaction", () => {
  test("the cut never splits a tool call from its result and keeps a user message first", () => {
    const core = [user("a"), assistant("b"), user("c"), toolCall("1"), toolResult("1"), assistant("d")];
    const { older, recent } = splitForCompaction(core, 2);
    expect(recent[0]?.role).toBe("user");
    expect(older).toHaveLength(2);
    expect(recent).toHaveLength(4);
  });

  test("the compacted conversation starts with the summary and drops orphaned tool results", () => {
    const messages = assembleCompacted("SUMMARY", [toolResult("1"), assistant("x"), user("y"), toolResult("2")]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0]?.content).toBe("SUMMARY");
    expect(messages[1]?.content).toBe("Continuing.");
  });

  test("short conversations are not compacted", () => {
    expect(compactionBlocker([user("a"), assistant("b")], 4)).toContain("at least 4");
    expect(compactionBlocker([user("a"), assistant("b"), user("c"), assistant("d")], 4)).toContain(
      "older messages",
    );
    expect(
      compactionBlocker([user("a"), assistant("b"), user("c"), assistant("d"), user("e"), assistant("f")], 4),
    ).toBeNull();
  });
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

const edit = (tool: string, args: Record<string, unknown>, success = true): ChatMessage => ({
  id: crypto.randomUUID(),
  role: "assistant",
  content: "",
  timestamp: 0,
  toolCalls: [{ id: crypto.randomUUID(), name: tool, args, result: { success, output: "" } }],
});

describe("session diff stats", () => {
  test("edited files come from successful edit tools, renames and reported edits", () => {
    const files = editedFiles([
      edit("edit_file", { path: "a.ts" }),
      edit("edit_file", { path: "failed.ts" }, false),
      edit("structural_edit", { file: "b.go" }),
      edit("rename_file", { from: "old.ts", to: "new.ts" }),
      {
        ...edit("dispatch", {}),
        toolCalls: [{ id: "d", name: "dispatch", args: {}, result: { success: true, output: "", filesEdited: ["c.ts"] } }],
      },
      edit("read", { path: "read.ts" }),
    ]);
    expect(files).toEqual(["a.ts", "b.go", "c.ts", "new.ts", "old.ts"]);
  });

  test("git counts added and removed lines per file against HEAD", async () => {
    await withTempDir("baked-diff-", async (root) => {
      git(root, "init", "-q");
      git(root, "config", "user.email", "test@example.com");
      git(root, "config", "user.name", "Test");
      git(root, "config", "commit.gpgsign", "false");
      writeFileSync(join(root, "kept.ts"), "one\ntwo\nthree\n");
      writeFileSync(join(root, "gone.ts"), "a\nb\n");
      writeFileSync(join(root, "same.ts"), "same\n");
      git(root, "add", ".");
      git(root, "commit", "-q", "--no-verify", "-m", "init");
      writeFileSync(join(root, "kept.ts"), "one\nTWO\nthree\nfour\n");
      writeFileSync(join(root, "fresh name.ts"), "x\ny\nz\n");
      git(root, "rm", "-q", "gone.ts");

      const stats = await sessionDiffStats(root, [
        "kept.ts",
        join(root, "fresh name.ts"),
        "gone.ts",
        "same.ts",
        "../elsewhere.ts",
      ]);
      expect(stats.base).toBe("HEAD");
      const byPath = Object.fromEntries(stats.files.map((f) => [f.path, f]));
      expect(byPath["kept.ts"]).toMatchObject({ status: "modified", added: 2, removed: 1 });
      expect(byPath["fresh name.ts"]).toMatchObject({ status: "added", added: 3, removed: 0 });
      expect(byPath["gone.ts"]).toMatchObject({ status: "deleted", added: 0, removed: 2 });
      expect(byPath["same.ts"]).toMatchObject({ status: "unchanged", added: 0, removed: 0 });
      expect(stats.files.find((f) => f.status === "outside")?.path).toEndWith("/elsewhere.ts");
      expect(stats.totals).toEqual({ files: 3, added: 5, removed: 3 });
    });
  });

  test("outside a repository only the names are known", async () => {
    await withTempDir("baked-nogit-", async (root) => {
      const stats = await sessionDiffStats(root, ["a.ts"]);
      expect(stats.base).toBeNull();
      expect(stats.files).toEqual([{ path: "a.ts", status: "unknown", added: 0, removed: 0 }]);
    });
  });
});
