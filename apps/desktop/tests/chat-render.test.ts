import { describe, expect, test } from "bun:test";
import { parseInline, parseMarkdown } from "../src/renderer/screens/chat/markdown-parse.ts";
import { toolDiff, toolIcon, toolTitle } from "../src/renderer/screens/chat/tools.ts";
import {
  forkReportLines,
  rememberForkReport,
  rewindReportLines,
  takeForkReport,
} from "../src/renderer/screens/chat/fork.ts";
import { parseChatEvent } from "../src/renderer/screens/chat/transcript.ts";

describe("tool titles", () => {
  test("name the action and its subject", () => {
    expect(toolTitle("read", { files: [{ path: "a.ts" }] })).toEqual({
      verb: "Read",
      subject: "a.ts",
      code: true,
    });
    expect(toolTitle("read", { files: [{ path: "a.ts" }, { path: "b.ts" }] }).verb).toBe(
      "Read 2 files",
    );
    expect(toolTitle("shell", { command: "bun test\n  tests/router.test.ts" })).toEqual({
      verb: "Ran",
      subject: "bun test tests/router.test.ts",
      code: true,
    });
    expect(toolTitle("edit_file", { path: "x.md", oldString: "", newString: "y" }).verb).toBe(
      "Created",
    );
    expect(toolTitle("web_search", { query: "bun sqlite" }).verb).toBe("Searched the web for");
    expect(toolTitle("bake_impact", { path: "src/a.ts" })).toEqual({
      verb: "Impact",
      subject: "src/a.ts",
      code: true,
    });
  });

  test("shorten long subjects", () => {
    const subject = toolTitle("shell", { command: "x".repeat(200) }).subject ?? "";
    expect(subject.length).toBe(80);
    expect(subject.endsWith("…")).toBe(true);
  });
});

describe("tool icons", () => {
  test("tools show the icon of what they do, unknown ones the model chip", () => {
    expect(toolIcon("read")).toBe("read");
    expect(toolIcon("multi_edit")).toBe("edit");
    expect(toolIcon("shell")).toBe("shell");
    expect(toolIcon("bake_grep")).toBe("search");
    expect(toolIcon("git")).toBe("git");
    expect(toolIcon("bake_vision")).toBe("image");
    expect(toolIcon("mcp__acme__thing")).toBe("model");
  });
});

describe("tool diffs", () => {
  test("edit_file shows removed then added lines", () => {
    expect(
      toolDiff("edit_file", { path: "a.ts", oldString: "throw err;\n", newString: "a\nb" }),
    ).toEqual({
      path: "a.ts",
      created: false,
      added: 2,
      removed: 1,
      lines: [
        { kind: "del", text: "throw err;" },
        { kind: "add", text: "a" },
        { kind: "add", text: "b" },
      ],
    });
  });

  test("multi_edit separates its edits, and tools without edit content have none", () => {
    const diff = toolDiff("multi_edit", {
      path: "a.md",
      edits: [
        { oldString: "a", newString: "b" },
        { oldString: "c", newString: "d" },
      ],
    });
    expect(diff?.lines.map((l) => l.kind)).toEqual(["del", "add", "hunk", "del", "add"]);
    expect(toolDiff("ast_edit", { path: "a.ts", action: "rename", name: "x" })).toBeNull();
    expect(toolDiff("ast_edit", { path: "a.ts", action: "create_file", newCode: "x\n" })?.added).toBe(
      1,
    );
    expect(toolDiff("shell", { command: "ls" })).toBeNull();
  });
});

describe("markdown", () => {
  test("keeps raw HTML as text", () => {
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([
      { type: "text", text: "<img src=x onerror=alert(1)>" },
    ]);
  });

  test("parses inline code, emphasis and safe links only", () => {
    expect(parseInline("Use `routeRequest` **now** and *then*")).toEqual([
      { type: "text", text: "Use " },
      { type: "code", text: "routeRequest" },
      { type: "text", text: " " },
      { type: "strong", children: [{ type: "text", text: "now" }] },
      { type: "text", text: " and " },
      { type: "em", children: [{ type: "text", text: "then" }] },
    ]);
    expect(parseInline("[docs](https://x.dev) [bad](javascript:alert(1))")[0]).toEqual({
      type: "link",
      href: "https://x.dev",
      children: [{ type: "text", text: "docs" }],
    });
    expect(parseInline("[bad](javascript:alert)")).toEqual([{ type: "text", text: "bad" }]);
    expect(parseInline("snake_case_name")).toEqual([{ type: "text", text: "snake_case_name" }]);
  });

  test("parses blocks", () => {
    const blocks = parseMarkdown(
      "# Plan\n\nFirst line\nsecond line\n\n- one\n- two\n\n1. a\n2. b\n\n```ts\nconst x = 1;\n```\n> note",
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "code",
      "quote",
    ]);
    expect(blocks[1]).toEqual({
      type: "paragraph",
      children: [{ type: "text", text: "First line second line" }],
    });
    expect(blocks[4]).toEqual({ type: "code", lang: "ts", text: "const x = 1;" });
  });
});

describe("session events", () => {
  test("parse numbered frames and resets", () => {
    expect(
      parseChatEvent({
        id: "7",
        event: "text",
        data: JSON.stringify({ seq: 7, type: "text", at: 5, turnId: "t", delta: "hi" }),
      }),
    ).toEqual({ seq: 7, type: "text", at: 5, turnId: "t", delta: "hi" });
    expect(parseChatEvent({ id: null, event: "reset", data: "{}" })).toEqual({ type: "reset" });
    expect(parseChatEvent({ id: "1", event: "unknown", data: "{}" })).toBeNull();
    expect(parseChatEvent({ id: "1", event: "text", data: "not json" })).toBeNull();
  });
});

describe("fork reports", () => {
  test("name restored, removed and kept files and the backup tag", () => {
    expect(forkReportLines(undefined)).toEqual(["Forked the chat. Files were left as they are."]);
    expect(
      forkReportLines({
        checkpoint: 2,
        snapshot: "baked/cp-1",
        backupTag: "baked/fork-backup-1",
        restored: ["/w/src/a.ts"],
        removed: ["/w/b.ts"],
        skipped: [{ path: "/w/src/c.ts", reason: "has changes no checkpoint holds" }],
      }),
    ).toEqual([
      "Forked at checkpoint #2: restored 1 file(s), removed 1.",
      "Left src/c.ts as it is: has changes no checkpoint holds.",
      "The files from before the fork are in Git tag baked/fork-backup-1.",
    ]);
  });

  test("are read once by the new session", () => {
    rememberForkReport("s1", ["done"]);
    expect(takeForkReport("s1")).toEqual(["done"]);
    expect(takeForkReport("s1")).toBeNull();
  });
});

describe("undo and redo reports", () => {
  const report = {
    checkpoint: 1,
    snapshot: "baked/cp-1",
    backupTag: "baked/undo-backup-1",
    restored: ["/w/src/a.ts"],
    removed: [],
    skipped: [{ path: "/w/local.env", reason: "ignored by Git, so no snapshot holds it" }],
  };

  test("name the checkpoint or turn, the files and the backup tag", () => {
    expect(rewindReportLines("undo", report)).toEqual([
      "Undid the chat back to checkpoint #1: restored 1 file(s).",
      "Left w/local.env as it is: ignored by Git, so no snapshot holds it.",
      "The files from before the undo are in Git tag baked/undo-backup-1.",
    ]);
    expect(rewindReportLines("redo", { ...report, checkpoint: 2, skipped: [], backupTag: null })).toEqual([
      "Redid turn #2: restored 1 file(s).",
    ]);
  });

  test("the rewind event is parsed", () => {
    expect(
      parseChatEvent({
        id: "7",
        event: "rewind",
        data: JSON.stringify({ action: "undo", checkpoint: 1, messageCount: 2, seq: 7, at: 5 }),
      }),
    ).toMatchObject({ type: "rewind", action: "undo", seq: 7 });
  });
});
