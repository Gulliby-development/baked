import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { setup } = await import("../src/renderer/client/setup.ts");
const { parseRoute, projectHref } = await import("../src/renderer/router.ts");
const { BLANK_FORM, draftOf, formFromTemplate, formProblem, jsonPreview, timeline } = await import(
  "../src/renderer/screens/setup/hooks-logic.ts"
);
const { HOOK_TEMPLATES } = await import("../../../src/core/hooks/catalog.ts");
delete scope.window;

describe("hooks client", () => {
  test("lists hooks with their files and switches an event off and on", async () => {
    const view = await setup.hooks("baked");
    expect(view.events.map((e) => e.event)).toEqual([
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SessionStart",
      "RunAttention",
    ]);
    expect(view.events.find((e) => e.event === "PreToolUse")?.hooks[0]).toMatchObject({
      scope: "project",
      matcher: "Bash",
      origin: "claude",
      id: null,
    });
    const off = await setup.setHookEvent("baked", "PreToolUse", false);
    expect(off.events.find((e) => e.event === "PreToolUse")?.disabled).toBe(true);
    const on = await setup.setHookEvent("baked", "PreToolUse", true);
    expect(on.events.find((e) => e.event === "PreToolUse")?.disabled).toBe(false);
    const refused = await setup.setHookEvent("baked", "Nope", false).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(parseRoute(projectHref("baked", "hooks"))).toEqual({ name: "project", key: "baked", section: "hooks", id: null });
  });
});

describe("hooks editing", () => {
  test("adds, edits and deletes BAKED hooks, and refuses a stale revision", async () => {
    expect(await setup.canEditHooks("baked")).toBe(true);
    const draft = { event: "Stop", matcher: null, command: "say done", timeout: null, async: true, once: false, if: null, scope: "project" as const };
    const added = await setup.addHook("baked", draft);
    const stop = added.events.find((e) => e.event === "Stop");
    const mine = stop?.hooks.find((h) => h.command === "say done");
    expect(mine).toMatchObject({ origin: "baked", scope: "project", async: true });
    const edited = await setup.updateHook("baked", mine?.id ?? "", mine?.rev ?? "", { ...draft, command: "say finished" });
    const changed = edited.events.find((e) => e.event === "Stop")?.hooks.find((h) => h.command === "say finished");
    expect(changed).toBeDefined();
    const stale = await setup.updateHook("baked", mine?.id ?? "", mine?.rev ?? "", draft).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ApiError);
    const removed = await setup.removeHook("baked", changed?.id ?? "", changed?.rev ?? "");
    expect(removed.events.find((e) => e.event === "Stop")?.hooks.some((h) => h.command === "say finished")).toBe(false);
    const empty = await setup.addHook("baked", { ...draft, command: "  " }).catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(ApiError);
  });
});

describe("hooks timeline and form", () => {
  test("groups events by phase and shows unfired events only with hooks", async () => {
    const view = await setup.hooks("baked");
    const { phases } = timeline(view);
    const names = phases.flatMap((p) => p.events.map((e) => e.info.event));
    expect(names[0]).toBe("SessionStart");
    expect(names).toContain("PreToolUse");
    expect(names).not.toContain("SessionEnd");
    expect(names).not.toContain("Notification");
  });

  test("turns a form into a request body and the JSON it saves", () => {
    const form = { ...BLANK_FORM, event: "PreToolUse", matcher: " Bash ", command: " ./guard.sh ", timeout: "5", if: "Bash(rm *)" };
    expect(formProblem(form)).toBeNull();
    expect(draftOf(form)).toEqual({ event: "PreToolUse", matcher: "Bash", command: "./guard.sh", timeout: 5, async: false, once: false, if: "Bash(rm *)", scope: "project" });
    // Events without a matcher drop it, and a kept command is left out.
    expect(draftOf({ ...form, event: "Stop" }, true)).toEqual({ event: "Stop", matcher: null, timeout: 5, async: false, once: false, if: null, scope: "project" });
    expect(JSON.parse(jsonPreview(form))).toEqual({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh", timeout: 5, if: "Bash(rm *)" }] }] },
    });
    expect(formProblem({ ...form, command: " " })).toBe("Add the command to run.");
    expect(formProblem({ ...form, timeout: "1.5" })).not.toBeNull();
    expect(formProblem({ ...form, matcher: "(" })).not.toBeNull();
    const template = HOOK_TEMPLATES.find((t) => t.id === "notify-when-done");
    expect(template && formFromTemplate(template, "darwin").command).toContain("osascript");
    expect(template && formFromTemplate(template, "win32").async).toBe(true);
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
