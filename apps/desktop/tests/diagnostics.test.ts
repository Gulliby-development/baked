import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError, call } = await import("../src/renderer/client/api.ts");
const { cleanupActions, diagnostics, formatBytes } = await import("../src/renderer/client/diagnostics.ts");
const { parseRoute, projectHref } = await import("../src/renderer/router.ts");
delete scope.window;

describe("diagnostics client", () => {
  test("lists storage and clears a target with an explicit confirmation", async () => {
    const view = await diagnostics.storage("baked");
    expect(view.project.sessionCount).toBeGreaterThan(0);
    const actions = cleanupActions(view);
    expect(actions.map((a) => a.target)).toEqual(["repo-map", "sessions", "plans", "history", "vacuum"]);
    expect(actions.find((a) => a.target === "vacuum")?.warning).toBeNull();
    expect(actions.find((a) => a.target === "sessions")?.warning).toContain("cannot be undone");

    const cleared = await diagnostics.cleanup("baked", "plans");
    expect(cleared.freedBytes).toBe(view.project.plansBytes);
    expect(cleared.storage.project.plansBytes).toBe(0);
    expect(cleanupActions(cleared.storage).some((a) => a.target === "plans")).toBe(false);
    // The API refuses a deleting cleanup that does not confirm it.
    await expect(call("baked", "POST", "/v1/diagnostics/storage/cleanup", { target: "history" })).rejects.toBeInstanceOf(ApiError);
    expect((await diagnostics.cleanup("baked", "vacuum")).target).toBe("vacuum");
  });

  test("turns model events on and off and clears them", async () => {
    const view = await diagnostics.modelEvents("site");
    expect(view.events.length).toBeGreaterThan(0);
    expect(view.models[0]?.calls).toBeGreaterThan(0);
    expect((await diagnostics.changeModelEvents("site", "clear")).events).toEqual([]);
    const off = await diagnostics.changeModelEvents("site", "disable");
    expect(off.enabled).toBe(false);
    expect((await diagnostics.changeModelEvents("site", "enable")).enabled).toBe(true);
  });

  test("reads the error log", async () => {
    const { errors } = await diagnostics.errors("baked");
    expect(errors[0]).toMatchObject({ source: "lsp" });
  });

  test("formats sizes and has its own project section", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(parseRoute(projectHref("baked", "diagnostics"))).toEqual({ name: "project", key: "baked", section: "diagnostics", id: null });
  });
});
