import { describe, expect, it } from "bun:test";
import { groupToolCalls } from "../src/components/chat/tool-grouping.js";

function tc(name: string, success = true, path?: string) {
  return {
    id: `${name}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    args: path ? { path } : {},
    result: { success, output: "ok", error: success ? undefined : "fail" },
  };
}

function pending(name: string, path?: string) {
  return {
    id: `${name}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    args: path ? { path } : {},
  };
}

describe("groupToolCalls", () => {
  it("single tool call stays normal", () => {
    const groups = groupToolCalls([tc("read", true, "a.ts")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe("normal");
  });

  it("groups consecutive reads", () => {
    const groups = groupToolCalls([
      tc("read", true, "a.ts"),
      tc("read", true, "b.ts"),
      tc("read", true, "c.ts"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe("batch");
    if (groups[0]!.type === "batch") {
      expect(groups[0]!.kind).toBe("reads");
      expect(groups[0]!.calls).toHaveLength(3);
    }
  });

  it("groups consecutive edits", () => {
    const groups = groupToolCalls([
      tc("edit_file", true, "a.ts"),
      tc("multi_edit", true, "b.ts"),
      tc("edit_file", true, "a.ts"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe("batch");
    if (groups[0]!.type === "batch") {
      expect(groups[0]!.kind).toBe("edits");
      expect(groups[0]!.calls).toHaveLength(3);
    }
  });

  it("groups consecutive searches", () => {
    const groups = groupToolCalls([
      tc("grep"),
      tc("bake_grep"),
      tc("glob"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe("batch");
    if (groups[0]!.type === "batch") {
      expect(groups[0]!.kind).toBe("search");
    }
  });

  it("does NOT merge different kinds across boundaries", () => {
    const groups = groupToolCalls([
      tc("read", true, "a.ts"),
      tc("edit_file", true, "a.ts"),
      tc("read", true, "a.ts"),
    ]);
    // read → edit → read = 3 separate groups (each is single, so "normal")
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.type === "normal")).toBe(true);
  });

  it("non-groupable tool breaks batch", () => {
    const groups = groupToolCalls([
      tc("read", true, "a.ts"),
      tc("read", true, "b.ts"),
      tc("shell"),
      tc("read", true, "c.ts"),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0]!.type).toBe("batch"); // first 2 reads
    expect(groups[1]!.type).toBe("normal"); // shell
    expect(groups[2]!.type).toBe("normal"); // single read
  });

  it("meta tools collapse separately", () => {
    const groups = groupToolCalls([
      tc("plan"),
      tc("update_plan_step"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe("meta");
  });

  it("meta between batches flushes correctly", () => {
    const groups = groupToolCalls([
      tc("read", true, "a.ts"),
      tc("read", true, "b.ts"),
      tc("update_plan_step"),
      tc("read", true, "c.ts"),
      tc("read", true, "d.ts"),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0]!.type).toBe("batch"); // reads a, b
    expect(groups[1]!.type).toBe("meta"); // update_plan_step
    expect(groups[2]!.type).toBe("batch"); // reads c, d
  });

  it("groups failed edits alongside successful ones", () => {
    const groups = groupToolCalls([
      tc("edit_file", false, "a.ts"),
      tc("edit_file", true, "a.ts"),
      tc("edit_file", true, "b.ts"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe("batch");
    if (groups[0]!.type === "batch") {
      expect(groups[0]!.calls).toHaveLength(3);
    }
  });

  it("pending tool calls are grouped", () => {
    const groups = groupToolCalls([
      pending("read", "a.ts"),
      pending("read", "b.ts"),
    ] as Parameters<typeof groupToolCalls>[0]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe("batch");
  });

  it("empty input returns empty", () => {
    expect(groupToolCalls([])).toHaveLength(0);
  });

  it("unknown tools stay normal", () => {
    const groups = groupToolCalls([
      tc("shell"),
      tc("dispatch"),
      tc("project"),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.type === "normal")).toBe(true);
  });

  it("mixed sequence: reads → shell → edits → grep", () => {
    const groups = groupToolCalls([
      tc("read", true, "a.ts"),
      tc("read", true, "b.ts"),
      tc("shell"),
      tc("edit_file", true, "a.ts"),
      tc("edit_file", true, "b.ts"),
      tc("edit_file", true, "c.ts"),
      tc("bake_grep"),
      tc("grep"),
    ]);
    expect(groups).toHaveLength(4);
    expect(groups[0]!.type).toBe("batch"); // 2 reads
    expect(groups[1]!.type).toBe("normal"); // shell
    expect(groups[2]!.type).toBe("batch"); // 3 edits
    expect(groups[3]!.type).toBe("batch"); // 2 searches
  });

  it("navigate groups with grep as search", () => {
    const groups = groupToolCalls([
      tc("navigate"),
      tc("bake_impact"),
      tc("bake_analyze"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe("batch");
    if (groups[0]!.type === "batch") {
      expect(groups[0]!.kind).toBe("search");
    }
  });
});
