import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { setup } = await import("../src/renderer/client/setup.ts");
const { parseRoute, projectHref } = await import("../src/renderer/router.ts");
delete scope.window;

describe("chat memory client", () => {
  test("lists, pins, edits, hides and restores memories", async () => {
    const view = await setup.chatMemory("baked");
    expect(view.settings).toEqual({ writeScope: "project", readScope: "all", shareWithRuns: false, settingsScope: "project" });
    const first = view.entries.find((e) => !e.pinned);
    if (!first) throw new Error("No unpinned memory in the mock");
    const target = { scope: first.scope, id: first.id };
    const pinned = await setup.editChatMemory("baked", { action: "pin", ...target });
    expect(pinned.entries.find((e) => e.id === first.id)?.pinned).toBe(true);
    const edited = await setup.editChatMemory("baked", { action: "edit", ...target, summary: "Reworded", category: "decision" });
    expect(edited.entries.find((e) => e.id === first.id)).toMatchObject({ summary: "Reworded", category: "decision" });
    const hidden = await setup.editChatMemory("baked", { action: "hide", ...target });
    expect(hidden.hidden.map((e) => e.id)).toContain(first.id);
    const restored = await setup.editChatMemory("baked", { action: "restore", ...target });
    expect(restored.entries.some((e) => e.id === first.id)).toBe(true);
    await expect(setup.editChatMemory("baked", { action: "pin", scope: "global", id: "missing" })).rejects.toBeInstanceOf(ApiError);
  });

  test("changes settings, cleans up and purges", async () => {
    const off = await setup.chatMemorySettings("baked", { writeScope: "none", readScope: "none" });
    expect(off.settings).toMatchObject({ writeScope: "none", readScope: "none" });
    const shared = await setup.chatMemorySettings("baked", { shareWithRuns: true });
    expect(shared.settings.shareWithRuns).toBe(true);
    const { candidates } = await setup.chatMemoryCleanup("baked");
    const candidate = candidates[0];
    if (!candidate) throw new Error("No cleanup candidate in the mock");
    const cleaned = await setup.applyChatMemoryCleanup("baked", [{ scope: candidate.scope, id: candidate.id, action: "hide" }]);
    expect(cleaned.applied).toEqual({ hidden: 1, pinned: 0 });
    expect(cleaned.hidden.map((e) => e.id)).toContain(candidate.id);
    const purged = await setup.editChatMemory("baked", { action: "purge", scope: "all" });
    expect(purged.entries).toEqual([]);
    expect(purged.cleared).toBeGreaterThan(0);
  });

  test("is the Chat part of the Memory section", () => {
    expect(parseRoute(projectHref("baked", "memory"))).toEqual({ name: "project", key: "baked", section: "memory", id: null });
    expect(parseRoute("#/p/baked/chat-memory")).toEqual({ name: "project", key: "baked", section: "memory", id: "chat" });
  });
});
