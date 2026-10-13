import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCwd, setCwd } from "../src/core/cwd.js";
import { type CliLoginBackend, setCliLoginBackend } from "../src/core/llm/cli-login.js";
import { SessionManager } from "../src/core/sessions/manager.js";
import type { SessionMeta } from "../src/core/sessions/types.js";
import { runLoginCli } from "../src/headless/login.js";
import { runAttentionCli, runUsageCli } from "../src/headless/overview.js";
import { runSessionCli } from "../src/headless/session.js";
import type { ChatMessage } from "../src/types/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Runs a CLI entry point in `dir` and returns its exit code and output. */
async function cli(dir: string, run: () => Promise<number>) {
  const previous = getCwd();
  setCwd(dir, { changeProcess: false });
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => out.push(String(chunk)) > 0) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => err.push(String(chunk)) > 0) as typeof process.stderr.write;
  try {
    const code = await run();
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    setCwd(previous, { changeProcess: false });
  }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-cli-"));
  cleanups.push(() => removeTempDir(dir));
  return dir;
}

function meta(id: string, title: string, cwd: string): SessionMeta {
  return {
    id,
    title,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    activeTabId: "tab-1",
    cwd,
    bakeMode: "default",
    tabs: [
      {
        id: "tab-1",
        label: "Tab",
        activeModel: "test-model",
        sessionId: id,
        planMode: false,
        planRequest: null,
        coAuthorCommits: false,
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        messageRange: { startLine: 0, endLine: 0 },
      },
    ],
  };
}

describe("baked usage and baked attention", () => {
  test("a project without workflow runs has no usage and nothing waiting, and gets no database", async () => {
    const dir = tempDir();
    const usage = await cli(dir, () => runUsageCli(["--json", "--days", "3"]));
    expect(usage.code).toBe(0);
    expect(JSON.parse(usage.stdout)).toMatchObject({ days: 3, runs: 0, tokens: 0, groups: [] });
    const attention = await cli(dir, () => runAttentionCli([]));
    expect(attention).toMatchObject({ code: 0, stdout: "Nothing waits for a person.\n" });
    expect(existsSync(join(dir, ".baked"))).toBe(false);
  });

  test("list the usage and the pending approval of a run, as the local API does", async () => {
    const fixture = workflowFixture();
    cleanups.push(() => fixture.dispose());
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    const request = fixture.service.store
      .requests(run.runId)
      .find((r) => r.kind === "approval" && r.status === "pending");
    if (!request) throw new Error("No pending approval");

    const attention = await cli(fixture.root, () => runAttentionCli(["--json"]));
    expect(attention.code).toBe(0);
    expect(JSON.parse(attention.stdout)).toEqual({
      items: [
        expect.objectContaining({
          source: "run",
          runId: run.runId,
          featureId: "fixture",
          requestId: request.id,
          kind: "approval",
          blocking: true,
        }),
      ],
    });
    const text = await cli(fixture.root, () => runAttentionCli([]));
    expect(text.stdout).toContain(`run ${run.runId} (fixture)  approval`);

    const usage = await cli(fixture.root, () => runUsageCli(["--json", "--group-by", "stage,model"]));
    expect(usage.code).toBe(0);
    const summary = JSON.parse(usage.stdout) as { runs: number; tokens: number; groupBy: string[]; groups: { key: string }[] };
    expect(summary.runs).toBe(1);
    expect(summary.tokens).toBeGreaterThan(0);
    expect(summary.groupBy).toEqual(["stage", "model"]);
    expect(summary.groups.length).toBeGreaterThan(0);
    const table = await cli(fixture.root, () => runUsageCli(["--group-by=stage"]));
    expect(table.stdout).toMatch(/^Last 7 days: [\d,]+ tokens/);
  });

  test("usage refuses unknown dimensions, out-of-range days and unknown flags", async () => {
    const dir = tempDir();
    expect((await cli(dir, () => runUsageCli(["--group-by", "model,model"]))).code).toBe(1);
    expect((await cli(dir, () => runUsageCli(["--group-by", "team"]))).code).toBe(1);
    expect((await cli(dir, () => runUsageCli(["--days", "0"]))).code).toBe(1);
    expect((await cli(dir, () => runUsageCli(["--top", "3"]))).stderr).toContain("Unknown argument: --top");
  });
});

describe("baked session list and delete", () => {
  test("list the saved sessions and delete one by a unique prefix", async () => {
    const dir = tempDir();
    const store = new SessionManager(dir);
    const messages = new Map<string, ChatMessage[]>([["tab-1", []]]);
    await store.saveSession(meta("abc-111", "First", dir), messages);
    await store.saveSession(meta("abc-222", "Second", dir), messages);

    const list = await cli(dir, () => runSessionCli(["list", "--json"]));
    expect(list.code).toBe(0);
    const { sessions } = JSON.parse(list.stdout) as { sessions: { id: string; title: string }[] };
    expect(sessions.map((s) => s.id).sort()).toEqual(["abc-111", "abc-222"]);
    expect((await cli(dir, () => runSessionCli(["list", "--limit", "1"]))).stdout.split("\n")).toHaveLength(2);

    const ambiguous = await cli(dir, () => runSessionCli(["delete", "abc"]));
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain("matches 2 sessions");
    expect((await cli(dir, () => runSessionCli(["delete", "nope"]))).code).toBe(1);

    const deleted = await cli(dir, () => runSessionCli(["delete", "abc-2", "--json"]));
    expect(deleted.code).toBe(0);
    expect(JSON.parse(deleted.stdout)).toEqual({ deleted: "abc-222", title: "Second" });
    expect(store.listSessions().map((s) => s.id)).toEqual(["abc-111"]);
  });
});

describe("baked session checkpoints", () => {
  test("lists the turns of the active tab with their prompts, files and snapshots", async () => {
    const dir = tempDir();
    const store = new SessionManager(dir);
    const messages = [
      { id: "u1", role: "user", content: "Fix the router\nand its test", timestamp: 1 },
      {
        id: "a1",
        role: "assistant",
        content: "done",
        timestamp: 2,
        toolCalls: [{ id: "t1", name: "edit_file", args: { path: "src/router.ts" }, result: { success: true, output: "" } }],
      },
      { id: "s1", role: "user", content: "also the docs", timestamp: 3, isSteering: true },
      { id: "u2", role: "user", content: "Explain it", timestamp: 4 },
      { id: "a2", role: "assistant", content: "sure", timestamp: 5 },
    ] as unknown as ChatMessage[];
    const base = meta("cp-1", "Checkpoints", dir);
    const tab = { ...base.tabs[0], checkpointTags: [{ index: 1, anchorMessageId: "u1", gitTag: "baked/cp-1" }] };
    await store.saveSession({ ...base, tabs: [tab] } as SessionMeta, new Map([["tab-1", messages]]));

    const json = await cli(dir, () => runSessionCli(["checkpoints", "cp", "--json"]));
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      sessionId: "cp-1",
      checkpoints: [
        { index: 1, anchorMessageId: "u1", endMessageId: "s1", prompt: "Fix the router", startedAt: 1, filesEdited: ["src/router.ts"], snapshot: true },
        { index: 2, anchorMessageId: "u2", endMessageId: "a2", prompt: "Explain it", startedAt: 4, filesEdited: [], snapshot: false },
      ],
      redo: [],
    });
    const text = await cli(dir, () => runSessionCli(["checkpoints", "cp-1"]));
    expect(text.stdout.split("\n")[0]).toBe("#1   snapshot  1 file(s)  Fix the router");
    expect((await cli(dir, () => runSessionCli(["checkpoints", "nope"]))).code).toBe(1);
    expect((await cli(dir, () => runSessionCli(["checkpoints", "cp-1", "--all"]))).code).toBe(1);
  });
});

describe("baked session undo", () => {
  test("says that the files were left as they are when the undone turn recorded no edits", async () => {
    const dir = tempDir();
    const store = new SessionManager(dir);
    const messages = [
      { id: "u1", role: "user", content: "first", timestamp: 1 },
      { id: "a1", role: "assistant", content: "done", timestamp: 2 },
    ] as unknown as ChatMessage[];
    await store.saveSession(meta("noedit-1", "No edits", dir), new Map([["tab-1", messages]]));

    const undo = await cli(dir, () => runSessionCli(["undo", "noedit"]));
    expect(undo.code).toBe(0);
    expect(undo.stdout).toBe(
      "Undone to checkpoint #0 (0 messages, 1 turn(s) to redo)\nNo file edits were recorded for these turns; files were left as they are\n",
    );
  });
});

describe("baked session export", () => {
  test("writes the active tab as Markdown or JSON", async () => {
    const dir = tempDir();
    const store = new SessionManager(dir);
    const messages = [
      { id: "m1", role: "user", content: "hello export", timestamp: 1 },
      { id: "m2", role: "assistant", content: "hi back", timestamp: 2 },
    ] as unknown as ChatMessage[];
    await store.saveSession(meta("exp-1", "Export me", dir), new Map([["tab-1", messages]]));

    const md = await cli(dir, () => runSessionCli(["export", "exp", "--output", "out/chat.md", "--json"]));
    expect(md.code).toBe(0);
    expect(JSON.parse(md.stdout)).toMatchObject({ sessionId: "exp-1", format: "markdown", messageCount: 2, path: join(dir, "out", "chat.md") });
    const text = readFileSync(join(dir, "out", "chat.md"), "utf8");
    expect(text).toContain("hello export");
    expect(text).toContain("hi back");

    const json = await cli(dir, () => runSessionCli(["export", "exp-1", "--format", "json"]));
    expect(json.code).toBe(0);
    expect(json.stdout).toMatch(/^Exported 2 messages of exp-1 to \.baked[\\/]exports[\\/]export-me-/);
    expect((await cli(dir, () => runSessionCli(["export", "exp-1", "--format", "html"]))).code).toBe(1);
    expect((await cli(dir, () => runSessionCli(["export", "nope"]))).code).toBe(1);
  });
});

describe("baked login and logout", () => {
  function fake(state: { loggedIn: boolean; fail?: string }) {
    let loggedOut = false;
    const backend: CliLoginBackend = {
      status: () => ({ installed: true, loggedIn: state.loggedIn, message: state.loggedIn ? "Signed in" : "Not signed in", command: "fake login" }),
      run: (onLine, onUrl) => {
        onLine("Opening browser to sign in...");
        onUrl("https://example.test/oauth");
        return {
          promise: new Promise<void>((resolve, reject) =>
            setTimeout(() => (state.fail ? reject(new Error(state.fail)) : resolve()), 30),
          ),
          abort: () => {},
        };
      },
      logout: () => {
        loggedOut = true;
        return { ok: true, message: "Logged out." };
      },
    };
    cleanups.push(setCliLoginBackend("claude-code", backend));
    return { loggedOut: () => loggedOut };
  }

  test("login prints the progress and the sign-in page and waits for the CLI", async () => {
    fake({ loggedIn: false });
    const result = await cli(tempDir(), () => runLoginCli("login", ["claude-code"]));
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Opening browser to sign in...");
    expect(result.stderr).toContain("Open https://example.test/oauth to sign in");
    expect(result.stdout).toBe("Signed in to claude-code\n");
  });

  test("a failed login exits 1 and an unknown provider is refused", async () => {
    fake({ loggedIn: false, fail: "denied" });
    const failed = await cli(tempDir(), () => runLoginCli("login", ["claude-code", "--json"]));
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ provider: "claude-code", state: "failed", error: "denied" });
    const unknown = await cli(tempDir(), () => runLoginCli("login", ["openai"]));
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("does not sign in through a CLI");
  });

  test("logout runs the CLI's own logout", async () => {
    const backend = fake({ loggedIn: true });
    const result = await cli(tempDir(), () => runLoginCli("logout", ["claude-code"]));
    expect(result).toMatchObject({ code: 0, stdout: "Logged out.\n" });
    expect(backend.loggedOut()).toBe(true);
    expect((await cli(tempDir(), () => runLoginCli("logout", []))).code).toBe(1);
  });
});
