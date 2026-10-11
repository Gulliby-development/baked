import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { register } from "../src/core/commands/projects.js";
import type { CommandContext, CommandHandler } from "../src/core/commands/types.js";
import { findKnownProject, recordProjectOpen } from "../src/core/projects/known.js";

const saved = { HOME: process.env.HOME, LOCALAPPDATA: process.env.LOCALAPPDATA };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A private profile (HOME and LOCALAPPDATA) and a project folder that was opened once. */
function layout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "baked-rename-cmd-")));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const profile = join(base, "profile");
  const app = join(base, "app");
  mkdirSync(profile, { recursive: true });
  mkdirSync(app, { recursive: true });
  process.env.HOME = profile;
  process.env.LOCALAPPDATA = profile;
  recordProjectOpen(app);
  const messages: string[] = [];
  const ctx = {
    cwd: app,
    chat: {
      setMessages: (update: (prev: { content: string }[]) => { content: string }[]) => {
        messages.splice(0, messages.length, ...update([]).map((m) => m.content));
      },
    },
  } as unknown as CommandContext;
  const commands = new Map<string, CommandHandler>();
  register(commands);
  const run = async (input: string) => commands.get("/project rename")?.(input, ctx);
  return { app, messages, run };
}

test("/project rename names the current project and an empty name restores it", async () => {
  const { app, messages, run } = layout();
  await run("/project rename  Shop front ");
  expect(findKnownProject(app)?.name).toBe("Shop front");
  expect(messages.at(-1)).toBe("Renamed this project to Shop front.");
  await run("/project rename");
  expect(findKnownProject(app)?.name).toBe(basename(app));
  expect(messages.at(-1)).toBe(`Restored the name ${basename(app)}.`);
  await run(`/project rename ${"x".repeat(121)}`);
  expect(messages.at(-1)).toContain("at most 120 characters");
  expect(findKnownProject(app)?.name).toBe(basename(app));
});
