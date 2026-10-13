import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { setup } = await import("../src/renderer/client/setup.ts");
const { parseRoute, projectHref } = await import("../src/renderer/router.ts");
delete scope.window;

describe("run memory client", () => {
  test("lists, adds, edits, forgets and restores entries", async () => {
    const view = await setup.runMemory("baked");
    expect(view.enabled).toBe(true);
    expect(view.entries.map((e) => e.kind)).toContain("check");
    const added = await setup.editRunMemory("baked", { action: "add", text: "Docs use American spelling" });
    expect(added.entries[0]).toMatchObject({ id: added.id, kind: "note" });
    const answer = added.entries.find((e) => e.kind === "answer");
    if (!answer) throw new Error("No answer in the mock");
    const edited = await setup.editRunMemory("baked", { action: "edit", id: answer.id, text: "No" });
    expect(edited.entries.find((e) => e.id === answer.id)).toMatchObject({ text: "No", recorded: answer.text });
    const forgotten = await setup.editRunMemory("baked", { action: "forget", id: answer.id });
    expect(forgotten.hidden.map((e) => e.id)).toContain(answer.id);
    const restored = await setup.editRunMemory("baked", { action: "restore", id: answer.id });
    expect(restored.entries.some((e) => e.id === answer.id)).toBe(true);
    await expect(setup.editRunMemory("baked", { action: "forget", id: "a-0000000000" })).rejects.toBeInstanceOf(ApiError);
  });

  test("is the Runs part of the Memory section", () => {
    expect(parseRoute(projectHref("baked", "memory", "runs"))).toEqual({ name: "project", key: "baked", section: "memory", id: "runs" });
    // The old section's links still open it.
    expect(parseRoute("#/p/baked/run-memory")).toEqual({ name: "project", key: "baked", section: "memory", id: "runs" });
  });
});
