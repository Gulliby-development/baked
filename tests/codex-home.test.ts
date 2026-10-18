import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRunEnv, isolatedCodexHome } from "../src/core/llm/providers/codex/home.js";
import {
  buildCodexNativeRequest,
  CodexAppServerSessions,
} from "../src/core/llm/providers/codex/native.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const MARKER = "Apply the personal skill at C:/Users/owner/.codex/skills/unslop/SKILL.md";

/** A user's Codex home with personal instructions and skills, like the bench machine's (#1462). */
function userHome(root: string): string {
  const home = join(root, "user-codex");
  mkdirSync(join(home, "skills", "unslop"), { recursive: true });
  writeFileSync(join(home, "auth.json"), '{"auth_mode":"chatgpt","tokens":{"refresh_token":"r1"}}');
  writeFileSync(join(home, "config.toml"), 'model = "gpt-6-luna"\n');
  writeFileSync(join(home, "AGENTS.md"), MARKER);
  writeFileSync(join(home, "AGENTS.override.md"), MARKER);
  writeFileSync(join(home, "skills", "unslop", "SKILL.md"), MARKER);
  return home;
}

// A stand-in app-server: `bun app-server --listen stdio://` runs ./app-server.ts from the cwd.
// It records the home it started in and every thread/start, then answers each request empty.
const FAKE = `
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const home = process.env.CODEX_HOME ?? "";
const record = (entry) => appendFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify(entry) + "\\n");
record({ home, files: existsSync(home) ? readdirSync(home) : [], agents: existsSync(join(home, "AGENTS.md")) ? 1 : 0 });
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "thread/start") record({ threadStart: message.params });
  process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
});
`;

describe("Codex home isolation (#1462)", () => {
  let root = "";
  let saved: Record<string, string | undefined> = {};
  let cwd = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "baked-codex-home-"));
    cwd = process.cwd();
    saved = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      CODEX_HOME: process.env.CODEX_HOME,
      BAKED_CODEX_PATH: process.env.BAKED_CODEX_PATH,
      FAKE_CODEX_RECORD: process.env.FAKE_CODEX_RECORD,
    };
    process.env.HOME = join(root, "profile");
    process.env.USERPROFILE = join(root, "profile");
    process.env.LOCALAPPDATA = join(root, "profile", "AppData", "Local");
  });

  afterEach(async () => {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // The fake Codex a turn started may still hold the home open on Windows.
    await removeTempDir(root);
  });

  test("the isolated home shares the sign-in and settings and none of the user's instructions", () => {
    const source = userHome(root);
    const target = join(root, "baked-codex");
    expect(isolatedCodexHome(source, target)).toBe(target);
    expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(target, "AGENTS.override.md"))).toBe(false);
    expect(existsSync(join(target, "skills"))).toBe(false);
    expect(readFileSync(join(target, "config.toml"), "utf8")).toContain("gpt-6-luna");

    // Codex rewrites auth.json in place when it rotates a refresh token; both homes see it.
    writeFileSync(join(target, "auth.json"), '{"tokens":{"refresh_token":"r2"}}');
    expect(readFileSync(join(source, "auth.json"), "utf8")).toContain("r2");

    // A tool that replaces the user's file gets relinked on the next turn.
    writeFileSync(join(source, "auth.next"), '{"tokens":{"refresh_token":"r3"}}');
    renameSync(join(source, "auth.next"), join(source, "auth.json"));
    isolatedCodexHome(source, target);
    expect(readFileSync(join(target, "auth.json"), "utf8")).toContain("r3");

    // Settings the user removed leave the isolated home too.
    rmSync(join(source, "config.toml"));
    isolatedCodexHome(source, target);
    expect(existsSync(join(target, "config.toml"))).toBe(false);
  });

  test("without an auth.json to link, turns stay in the user's home", () => {
    const source = userHome(root);
    rmSync(join(source, "auth.json"));
    expect(isolatedCodexHome(source, join(root, "baked-codex"))).toBeNull();
    process.env.CODEX_HOME = source;
    expect(codexRunEnv().CODEX_HOME).toBe(source);
  });

  test("model turns start Codex in a home without the user's AGENTS.md", async () => {
    const source = userHome(root);
    process.env.CODEX_HOME = source;
    const fake = join(root, "fake");
    mkdirSync(fake);
    writeFileSync(join(fake, "app-server.ts"), FAKE);
    const recordPath = join(root, "record.jsonl");
    process.env.FAKE_CODEX_RECORD = recordPath;
    process.env.BAKED_CODEX_PATH = process.execPath;
    process.chdir(fake);

    expect(codexRunEnv().CODEX_HOME).not.toBe(source);
    const sessions = new CodexAppServerSessions();
    const request = buildCodexNativeRequest("gpt-6-luna", {
      prompt: [
        { role: "system", content: "You are baked." },
        { role: "user", content: [{ type: "text", text: "Read a.txt" }] },
      ],
    });
    // The fake returns no thread id, so the step fails after thread/start is recorded.
    await sessions.openStep(request).catch(() => null);
    sessions.close();

    const records = readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const started = records[0] as { home: string; files: string[]; agents: number };
    expect(started.home).not.toBe(source);
    expect(started.agents).toBe(0);
    expect(started.files).not.toContain("skills");
    expect(started.files).toContain("auth.json");
    const threadStart = records.find((entry) => entry.threadStart)?.threadStart as {
      config: Record<string, unknown>;
    };
    expect(threadStart.config.developer_instructions).toBe("");
    expect(JSON.stringify(records)).not.toContain(MARKER);
  });
});
