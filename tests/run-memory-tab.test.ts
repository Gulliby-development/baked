import { describe, expect, test } from "bun:test";
import { runMemoryRows } from "../src/components/modals/RunMemoryTab.js";
import type { ProjectMemoryView } from "../src/core/workflows/project-memory.js";

const view: ProjectMemoryView = {
  enabled: true,
  rendered: "text",
  entries: [
    { id: "n-0123456789", kind: "note", text: "Keep it short", hidden: false, sent: true },
    { id: "a-0123456789", kind: "answer", question: "Format?", text: "JSON", recorded: "Text", runId: "abcdef1234", hidden: false, sent: true },
    { id: "c-0123456789", kind: "check", text: "bun test", runs: 2, runId: "fedcba4321", hidden: false, sent: false },
  ],
  hidden: [{ id: "s-0123456789", kind: "assumption", text: "Empty means none", runId: "abcdef1234", hidden: true }],
};

describe("/memory Runs tab rows", () => {
  test("list entries, then forgotten ones, with their state", () => {
    const rows = runMemoryRows(view, "");
    expect(rows.map((r) => [r.kind, r.text, r.run, r.state])).toEqual([
      ["note", "Keep it short", "you", ""],
      ["answer", "Format? → JSON", "abcdef12", "edited"],
      ["check", "bun test", "fedcba43", "policy"],
      ["assume", "Empty means none", "abcdef12", "forgot"],
    ]);
  });
  test("filter by kind and text", () => {
    expect(runMemoryRows(view, "json").map((r) => r.id)).toEqual(["a-0123456789"]);
    expect(runMemoryRows(view, "assume").map((r) => r.id)).toEqual(["s-0123456789"]);
    expect(runMemoryRows(null, "")).toEqual([]);
  });
});
