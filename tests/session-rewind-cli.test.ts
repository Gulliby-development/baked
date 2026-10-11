import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBaseSnapshot } from "../src/core/checkpoints/fork.js";
import {
  listSavedCheckpoints,
  redoSavedSession,
  rewindSavedSession,
} from "../src/core/checkpoints/session-rewind.js";
import { snapshotWorkspace } from "../src/core/checkpoints/snapshot.js";
import type { CheckpointTag } from "../src/core/checkpoints/turns.js";
import { getCwd, setCwd } from "../src/core/cwd.js";
import { SessionManager } from "../src/core/sessions/manager.js";
import { runSessionCli } from "../src/headless/session.js";
import type { ChatMessage } from "../src/types/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const dirs: string[] = [];
const launchCwd = getCwd();
afterEach(async () => {
  setCwd(launchCwd, { changeProcess: false });
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

let seq = 0;
const user = (content: string): ChatMessage => ({ id: `u${++seq}`, role: "user", content, timestamp: seq });
const edit = (...paths: string[]): ChatMessage => ({
  id: `a${++seq}`,
  role: "assistant",
  content: "done",
  timestamp: seq,
  toolCalls: paths.map((path, i) => ({
    id: `c${seq}-${i}`,
    name: "edit_file",
    args: { path },
    result: { success: true, output: "ok" },
  })),
});

/** A saved session with two snapshotted turns: #1 writes a.txt v1, #2 writes v2 and creates b.txt. */
async function savedSession() {
  const dir = mkdtempSync(join(tmpdir(), "baked-rewind-cli-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "v0");
  writeFileSync(join(dir, ".gitignore"), ".baked/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const tags: CheckpointTag[] = [];
  const base = await ensureBaseSnapshot(dir, "tab-cli", [], tags);
  if (base) tags.push(base);
  const u1 = user("first");
  writeFileSync(join(dir, "a.txt"), "v1");
  const a1 = edit("a.txt");
  await snapshotWorkspace(dir, "baked/cp-tab-cli-1", "cp1");
  tags.push({ index: 1, anchorMessageId: u1.id, gitTag: "baked/cp-tab-cli-1" });
  const u2 = user("second");
  writeFileSync(join(dir, "a.txt"), "v2");
  writeFileSync(join(dir, "b.txt"), "new");
  const a2 = edit("a.txt", "b.txt");
  await snapshotWorkspace(dir, "baked/cp-tab-cli-2", "cp2");
  tags.push({ index: 2, anchorMessageId: u2.id, gitTag: "baked/cp-tab-cli-2" });
  const messages = [u1, a1, u2, a2];
  const store = new SessionManager(dir);
  const now = Date.now();
  await store.saveSession(
    {
      id: "rewind-session",
      title: "Source",
      cwd: dir,
      startedAt: now,
      updatedAt: now,
      activeTabId: "tab-cli",
      bakeMode: "default",
      tabs: [
        {
          id: "tab-cli",
          label: "TAB-1",
          activeModel: "openai/gpt-test",
          sessionId: "rewind-session",
          planMode: false,
          planRequest: null,
          coAuthorCommits: false,
          tokenUsage: { prompt: 0, completion: 0, total: 0 },
          messageRange: { startLine: 0, endLine: messages.length },
          checkpointTags: tags,
        },
      ],
    },
    new Map([["tab-cli", messages]]),
  );
  return { dir, store, messages };
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf-8");
const savedIds = (store: SessionManager) =>
  store.loadSession("rewind-session")?.tabMessages.get("tab-cli")?.map((m) => m.id);

describe("saved session rewind", () => {
  test("rewinds in place with file rollback, and redo survives between invocations", async () => {
    const { dir, store, messages } = await savedSession();
    expect(listSavedCheckpoints(store, "rewind").checkpoints.map((c) => c.prompt)).toEqual([
      "first",
      "second",
    ]);

    const rewound = await rewindSavedSession({ store, cwd: dir, session: "rewind", checkpoint: 1, rollbackFiles: true });
    expect(rewound.messageCount).toBe(2);
    expect(rewound.redo).toEqual([{ index: 2, prompt: "second", filesRolledBack: true }]);
    expect(rewound.rollback?.removed).toEqual([join(dir, "b.txt")]);
    expect(read(dir, "a.txt")).toBe("v1");
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
    expect(savedIds(store)).toEqual(messages.slice(0, 2).map((m) => m.id));

    // A fresh SessionManager, as the next command-line invocation has.
    const next = new SessionManager(dir);
    expect(listSavedCheckpoints(next, "rewind").redo).toHaveLength(1);
    const redone = await redoSavedSession({ store: next, cwd: dir, session: "rewind" });
    expect(redone.checkpoint).toBe(2);
    expect(redone.redo).toEqual([]);
    expect(read(dir, "a.txt")).toBe("v2");
    expect(read(dir, "b.txt")).toBe("new");
    expect(savedIds(next)).toEqual(messages.map((m) => m.id));
    expect(next.loadSession("rewind-session")?.meta.tabs[0]?.redo).toBeUndefined();
    await expect(redoSavedSession({ store: next, cwd: dir, session: "rewind" })).rejects.toThrow("Nothing to redo");
  });

  test("a chat-only rewind leaves files, and a conversation changed since drops the redo list", async () => {
    const { dir, store } = await savedSession();
    await rewindSavedSession({ store, cwd: dir, session: "rewind", checkpoint: 0 });
    expect(read(dir, "a.txt")).toBe("v2");
    expect(savedIds(store)).toEqual([]);

    // Another front end continues the session: the saved redo turns no longer apply.
    const data = store.loadSession("rewind-session");
    if (!data) throw new Error("session missing");
    await store.saveSession(data.meta, new Map([["tab-cli", [user("elsewhere")]]]));
    expect(listSavedCheckpoints(store, "rewind").redo).toEqual([]);
    await expect(redoSavedSession({ store, cwd: dir, session: "rewind" })).rejects.toThrow("Nothing to redo");
    await expect(rewindSavedSession({ store, cwd: dir, session: "rewind", checkpoint: 5 })).rejects.toThrow(
      "Checkpoint #5 not found",
    );
  });
});

describe("baked session rewind and redo", () => {
  async function cli(dir: string, ...argv: string[]) {
    setCwd(dir, { changeProcess: false });
    let out = "";
    let err = "";
    const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    });
    const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      err += String(chunk);
      return true;
    });
    try {
      return { code: await runSessionCli(argv), out, err };
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }

  test("prints JSON results and rejects bad arguments", async () => {
    const { dir } = await savedSession();
    const listed = await cli(dir, "checkpoints", "rewind", "--json");
    expect(listed.code).toBe(0);
    expect((JSON.parse(listed.out) as { checkpoints: unknown[] }).checkpoints).toHaveLength(2);

    const rewound = await cli(dir, "rewind", "rewind", "--checkpoint", "1", "--rollback-files", "--json");
    expect(rewound.code).toBe(0);
    expect(JSON.parse(rewound.out)).toMatchObject({ checkpoint: 1, messageCount: 2, redo: [{ index: 2 }] });
    expect(read(dir, "a.txt")).toBe("v1");

    const redone = await cli(dir, "redo", "rewind");
    expect(redone.code).toBe(0);
    expect(redone.out).toContain("Brought back checkpoint #2");
    expect(read(dir, "a.txt")).toBe("v2");

    expect((await cli(dir, "rewind", "rewind")).err).toContain("rewind needs --checkpoint N");
    expect((await cli(dir, "rewind", "rewind", "--at", "u1")).code).toBe(1);
    expect((await cli(dir, "redo", "rewind")).err).toContain("Nothing to redo");
    expect((await cli(dir, "rewind", "missing", "--checkpoint", "0")).err).toContain("not found");
  });
});
