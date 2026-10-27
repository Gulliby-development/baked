import { describe, expect, test } from "bun:test";
import type { ChatMessage, ToolCall } from "../src/renderer/client/chat.js";
import {
  freshTarget,
  normalizePath,
  previewOf,
  previewTargets,
  targetForCall,
} from "../src/renderer/screens/chat/preview-model.js";

const call = (
  id: string,
  name: string,
  args: Record<string, unknown>,
  output = "ok",
  success = true,
): ToolCall => ({ id, name, args, result: { success, output } });

const turn = (id: string, calls: ToolCall[]): ChatMessage => ({
  id,
  role: "assistant",
  content: "",
  timestamp: 0,
  toolCalls: calls,
});

describe("chat preview documents (#2298)", () => {
  test("every writing tool that names a Markdown or HTML file produces a document", () => {
    const writes: [string, Record<string, unknown>][] = [
      ["write_file", { path: "a.md" }],
      ["create_file", { path: "b.markdown" }],
      ["edit_file", { path: "c.html", oldString: "x", newString: "y" }],
      ["multi_edit", { path: "d.htm", edits: [] }],
      ["ast_edit", { path: "e.md", action: "create_file" }],
      ["structural_edit", { path: "f.md" }],
      ["rename_file", { from: "old.txt", to: "g.md" }],
    ];
    for (const [name, args] of writes)
      expect(previewOf(call("c", name, args))?.source.type).toBe("file");
  });

  test("ignores other files, reads, failed and unfinished calls", () => {
    expect(previewOf(call("c", "write_file", { path: "src/app.ts" }))).toBeNull();
    expect(previewOf(call("c", "read", { path: "README.md" }))).toBeNull();
    expect(previewOf(call("c", "write_file", { path: "a.md" }, "boom", false))).toBeNull();
    expect(previewOf({ id: "c", name: "write_file", args: { path: "a.md" } })).toBeNull();
    expect(previewOf(call("c", "artifact", { action: "list" }, "2 artifacts:"))).toBeNull();
  });

  test("names a file by its name and folder and knows when the chat created it", () => {
    expect(previewOf(call("c", "write_file", { path: ".\\docs\\plan.md" }))).toMatchObject({
      source: { type: "file", path: "docs/plan.md" },
      kind: "markdown",
      title: "plan.md",
      where: "docs",
      created: true,
    });
    expect(previewOf(call("c", "edit_file", { path: "index.html", oldString: "a", newString: "b" })))
      .toMatchObject({ kind: "html", where: "Project root", created: false });
    expect(normalizePath("./a/b.md")).toBe("a/b.md");
  });

  test("saved and deployed artifacts are one HTML document with the deploy URL", () => {
    const targets = previewTargets([
      turn("m1", [
        call(
          "s1",
          "artifact",
          { action: "save" },
          'Saved artifact token-chart v1 "Token use". Every project and chat can open or deploy it.',
        ),
      ]),
      turn("m2", [
        call(
          "d1",
          "artifact",
          { action: "deploy", id: "token-chart" },
          "Deployed token-chart v1 as a preview deployment: https://baked-token-chart.vercel.app",
        ),
      ]),
    ]);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      key: "artifact:token-chart",
      kind: "html",
      title: "Token use",
      where: "Artifact v1",
      changes: 2,
      deployUrl: "https://baked-token-chart.vercel.app",
    });
  });

  test("one document per file, in order of first appearance, counting changes", () => {
    const messages = [
      turn("m1", [
        call("a", "write_file", { path: "notes.md" }),
        call("b", "write_file", { path: "page.html" }),
      ]),
      turn("m2", [call("c", "edit_file", { path: "notes.md", oldString: "x", newString: "y" })]),
    ];
    const targets = previewTargets(messages);
    expect(targets.map((t) => [t.key, t.changes, t.lastCallId])).toEqual([
      ["file:notes.md", 2, "c"],
      ["file:page.html", 1, "b"],
    ]);
    expect(targetForCall(targets, call("x", "write_file", { path: "page.html" }))).toBe(
      "file:page.html",
    );
    expect(targetForCall(targets, call("x", "write_file", { path: "app.ts" }))).toBeNull();
  });

  test("the fresh document is the one changed last since the previous transcript", () => {
    const first = previewTargets([
      turn("m1", [
        call("a", "write_file", { path: "notes.md" }),
        call("b", "write_file", { path: "page.html" }),
      ]),
    ]);
    expect(freshTarget(first, first)).toBeNull();
    expect(freshTarget([], first)?.key).toBe("file:page.html");
    const later = previewTargets([
      turn("m1", [
        call("a", "write_file", { path: "notes.md" }),
        call("b", "write_file", { path: "page.html" }),
      ]),
      turn("m2", [call("c", "edit_file", { path: "notes.md", oldString: "x", newString: "y" })]),
    ]);
    expect(freshTarget(first, later)?.key).toBe("file:notes.md");
  });
});
