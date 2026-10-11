import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { setup } = await import("../src/renderer/client/setup.ts");
const { parseRoute, projectHref } = await import("../src/renderer/router.ts");
delete scope.window;

describe("hooks client", () => {
  test("lists hooks with their files and switches an event off and on", async () => {
    const view = await setup.hooks("baked");
    expect(view.events.map((e) => e.event)).toEqual(["PreToolUse", "PostToolUse", "Stop"]);
    expect(view.events[0]?.hooks[0]).toMatchObject({ scope: "project", matcher: "Bash" });
    const off = await setup.setHookEvent("baked", "PreToolUse", false);
    expect(off.events.find((e) => e.event === "PreToolUse")?.disabled).toBe(true);
    const on = await setup.setHookEvent("baked", "PreToolUse", true);
    expect(on.events.find((e) => e.event === "PreToolUse")?.disabled).toBe(false);
    const refused = await setup.setHookEvent("baked", "Nope", false).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(parseRoute(projectHref("baked", "hooks"))).toEqual({ name: "project", key: "baked", section: "hooks", id: null });
  });
});

describe("account switch client", () => {
  test("signs the CLI out and starts a new sign-in", async () => {
    expect(await setup.canSwitchAccount("baked")).toBe(true);
    const result = await setup.switchAccount("baked", "codex");
    expect(result.ok).toBe(true);
    expect(result.login?.state).toBe("running");
    const { providers } = await setup.providers("baked");
    expect(providers.find((p) => p.id === "codex")?.signIn?.loggedIn).toBe(false);
    await setup.cancelLogin("baked", "codex");
    const refused = await setup.switchAccount("baked", "openai").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
  });
});
