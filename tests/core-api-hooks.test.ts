import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import { invalidateHooksCache } from "../src/core/hooks/loader.js";
import { type HooksOverview, hooksOverview, setHookEventEnabled } from "../src/core/hooks/overview.js";
import { isHookEventDisabled } from "../src/core/hooks/runner.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// Hooks merge the user's own ~/.claude and ~/.baked files; point home at a temporary profile.
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const home = mkdtempSync(join(tmpdir(), "baked-hooks-api-home-"));
const savedSecret = process.env.HOOKS_TEST_TOKEN;
beforeAll(() => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.HOOKS_TEST_TOKEN = "s3cret-value-123";
  invalidateHooksCache();
});
afterAll(async () => {
  for (const [key, value] of Object.entries(savedHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (savedSecret === undefined) delete process.env.HOOKS_TEST_TOKEN;
  else process.env.HOOKS_TEST_TOKEN = savedSecret;
  invalidateHooksCache();
  await removeTempDir(home);
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe("hooks overview", () => {
  test("lists each hook with its source file and scope, in lifecycle order", () => {
    const project = mkdtempSync(join(tmpdir(), "baked-hooks-project-"));
    cleanups.push(() => removeTempDir(project));
    writeJson(join(home, ".claude", "settings.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-send done", async: true }] }] },
    });
    cleanups.push(() => removeTempDir(join(home, ".claude")));
    writeJson(join(project, ".baked", "config.json"), {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "./check.sh $HOOKS", timeout: 5, if: "Bash(rm *)" },
              { type: "command", command: "curl -H 'X: s3cret-value-123' x", once: true },
            ],
          },
        ],
      },
    });

    const view = hooksOverview(project);
    expect(view.disabledBy).toBeNull();
    expect(view.events.map((e) => e.event)).toEqual(["PreToolUse", "Stop"]);
    const [pre, stop] = view.events;
    expect(pre).toMatchObject({ known: true, disabled: false, blocking: true });
    expect(pre?.hooks[0]).toEqual({
      source: join(project, ".baked", "config.json"),
      scope: "project",
      matcher: "Bash",
      command: "./check.sh $HOOKS",
      async: false,
      once: false,
      timeout: 5,
      if: "Bash(rm *)",
    });
    expect(pre?.hooks[1]?.command).toBe("curl -H 'X: [redacted]' x");
    expect(stop).toMatchObject({ blocking: false, hooks: [{ scope: "user", async: true }] });
    expect(view.sources.find((s) => s.path === join(home, ".claude", "settings.json"))).toMatchObject({ exists: true, hooks: 1 });
  });

  test("disableAllHooks names the file that turns hooks off", () => {
    const project = mkdtempSync(join(tmpdir(), "baked-hooks-project-"));
    cleanups.push(() => removeTempDir(project));
    writeJson(join(project, ".claude", "settings.local.json"), { disableAllHooks: true });
    expect(hooksOverview(project).disabledBy).toBe(join(project, ".claude", "settings.local.json"));
  });
});

describe("hooks over the local API", () => {
  test("lists hooks and switches an event off and on for the process only", async () => {
    const fixture = workflowFixture();
    const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
    const server = await startApiServer({ service: fixture.service, pollMs: 20, configDir, homeDir: home, log: () => {} });
    cleanups.push(async () => {
      setHookEventEnabled("PostToolUse", true);
      await server.stop();
      await fixture.dispose();
      await removeTempDir(configDir);
    });
    const configFile = join(fixture.service.workspace, ".claude", "settings.json");
    const settings = { hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "bun run lint" }] }] } };
    writeJson(configFile, settings);
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      });
    const toggle = (body: unknown) => call("/v1/hooks/session", { method: "POST", body: JSON.stringify(body) });

    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("hooks");
    const listed = (await (await call("/v1/hooks")).json()) as HooksOverview;
    expect(listed.events).toHaveLength(1);
    expect(listed.events[0]).toMatchObject({ event: "PostToolUse", disabled: false, hooks: [{ command: "bun run lint", scope: "project" }] });

    const off = (await (await toggle({ event: "PostToolUse", enabled: false })).json()) as HooksOverview;
    expect(off.events[0]?.disabled).toBe(true);
    expect(isHookEventDisabled("PostToolUse")).toBe(true);
    const on = (await (await toggle({ event: "PostToolUse", enabled: true })).json()) as HooksOverview;
    expect(on.events[0]?.disabled).toBe(false);
    // The config file is never written.
    expect(await Bun.file(configFile).json()).toEqual(settings);

    expect((await toggle({ event: "Nope", enabled: false })).status).toBe(400);
    expect((await toggle({ event: "Stop", enabled: false, command: "rm -rf /" })).status).toBe(400);
    expect((await call("/v1/hooks", { method: "POST", body: "{}" })).status).toBe(405);
    expect((await call("/v1/hooks/session")).status).toBe(405);
  });
});
