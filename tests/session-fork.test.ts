import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { type ChatAgentHost, ChatService, type TurnAgentRequest } from "../src/core/chat/sessions.js";
import {
  checkpointEndMessageId,
  copyCheckpointTags,
  ensureBaseSnapshot,
  forkPoint,
  RollbackError,
  rollbackToCheckpoint,
} from "../src/core/checkpoints/fork.js";
import { forkSavedSession } from "../src/core/checkpoints/session-fork.js";
import { readFileAt, snapshotWorkspace, tagExists } from "../src/core/checkpoints/snapshot.js";
import type { CheckpointTag } from "../src/core/checkpoints/turns.js";
import { SessionManager } from "../src/core/sessions/manager.js";
import type { ChatMessage } from "../src/types/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-fork-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "v0");
  writeFileSync(join(dir, ".gitignore"), "secret.txt\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
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

/** Two turns: #1 edits a.txt to v1, #2 edits a.txt to v2 and creates b.txt; every turn snapshotted. */
async function conversation(dir: string) {
  const tags: CheckpointTag[] = [];
  const base = await ensureBaseSnapshot(dir, "tab-test", [], tags);
  if (base) tags.push(base);
  const u1 = user("first");
  writeFileSync(join(dir, "a.txt"), "v1");
  const a1 = edit(join(dir, "a.txt"));
  await snapshotWorkspace(dir, "baked/cp-tab-test-1", "cp1");
  tags.push({ index: 1, anchorMessageId: u1.id, gitTag: "baked/cp-tab-test-1" });
  const u2 = user("second");
  writeFileSync(join(dir, "a.txt"), "v2");
  writeFileSync(join(dir, "b.txt"), "new");
  const a2 = edit("a.txt", "b.txt");
  await snapshotWorkspace(dir, "baked/cp-tab-test-2", "cp2");
  tags.push({ index: 2, anchorMessageId: u2.id, gitTag: "baked/cp-tab-test-2" });
  return { messages: [u1, a1, u2, a2], tags, u1, a1, u2, a2 };
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf-8");

describe("fork points", () => {
  test("a prompt forks before its turn, any other message after the turn", () => {
    const [u1, a1, u2, a2] = [user("x"), edit("f"), user("y"), edit("g")];
    const messages = [u1, a1, u2, a2];
    expect(forkPoint(messages, u1.id)?.checkpoint).toBe(0);
    expect(forkPoint(messages, a1.id)?.checkpoint).toBe(1);
    expect(forkPoint(messages, u2.id)).toEqual({ messages: [u1, a1, u2], checkpoint: 1 });
    expect(forkPoint(messages)?.checkpoint).toBe(2);
    expect(forkPoint(messages, "missing")).toBeNull();
    expect(checkpointEndMessageId(messages, 1)).toBe(a1.id);
    expect(checkpointEndMessageId(messages, 3)).toBeNull();
  });
});

describe("snapshots", () => {
  test("leave the index and HEAD alone and keep uncommitted and untracked files", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "staged");
    git(dir, "add", "a.txt");
    writeFileSync(join(dir, "a.txt"), "dirty");
    writeFileSync(join(dir, "new.txt"), "untracked");
    const head = git(dir, "rev-parse", "HEAD");
    const status = git(dir, "status", "--porcelain");
    expect(await snapshotWorkspace(dir, "baked/test-snap", "snap")).toBe(true);
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "status", "--porcelain")).toBe(status);
    expect((await readFileAt(dir, "baked/test-snap", "a.txt"))?.toString()).toBe("dirty");
    expect((await readFileAt(dir, "baked/test-snap", "new.txt"))?.toString()).toBe("untracked");
    expect(await readFileAt(dir, "baked/test-snap", "missing.txt")).toBeNull();
  });

  test("a folder outside Git is not snapshotted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-nogit-"));
    dirs.push(dir);
    expect(await snapshotWorkspace(dir, "baked/x", "x")).toBe(false);
    expect(await ensureBaseSnapshot(dir, "tab", [], [])).toBeNull();
  });
});

describe("rollback", () => {
  test("restores edited files to the checkpoint, removes created ones and keeps a backup", async () => {
    const dir = repo();
    const c = await conversation(dir);
    const report = await rollbackToCheckpoint({
      cwd: dir,
      messages: c.messages,
      checkpoint: 1,
      tags: c.tags,
      backupTag: "baked/fork-backup-test",
    });
    expect(read(dir, "a.txt")).toBe("v1");
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
    expect(report.restored).toEqual([join(dir, "a.txt")]);
    expect(report.removed).toEqual([join(dir, "b.txt")]);
    expect(report.skipped).toEqual([]);
    expect(report.snapshot).toBe("baked/cp-tab-test-1");
    expect((await readFileAt(dir, "baked/fork-backup-test", "b.txt"))?.toString()).toBe("new");
  });

  test("checkpoint 0 restores the state before the first turn, uncommitted changes included", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "uncommitted");
    const c = await conversation(dir);
    await rollbackToCheckpoint({ cwd: dir, messages: c.messages, checkpoint: 0, tags: c.tags, backupTag: "baked/b0" });
    expect(read(dir, "a.txt")).toBe("uncommitted");
  });

  test("never overwrites a file changed after the last checkpoint unless forced", async () => {
    const dir = repo();
    const c = await conversation(dir);
    writeFileSync(join(dir, "a.txt"), "user edit");
    const input = { cwd: dir, messages: c.messages, checkpoint: 1, tags: c.tags, backupTag: "baked/b1" };
    const kept = await rollbackToCheckpoint(input);
    expect(read(dir, "a.txt")).toBe("user edit");
    expect(kept.skipped).toEqual([{ path: join(dir, "a.txt"), reason: expect.stringContaining("no checkpoint holds") }]);
    expect(kept.removed).toEqual([join(dir, "b.txt")]);

    const forced = await rollbackToCheckpoint({ ...input, backupTag: "baked/b2", force: true });
    expect(read(dir, "a.txt")).toBe("v1");
    expect(forced.restored).toEqual([join(dir, "a.txt")]);
    expect((await readFileAt(dir, "baked/b2", "a.txt"))?.toString()).toBe("user edit");
  });

  test("leaves ignored files, files outside the workspace and claimed files in place", async () => {
    const dir = repo();
    const c = await conversation(dir);
    writeFileSync(join(dir, "secret.txt"), "s");
    const messages = [...c.messages, user("third"), edit("secret.txt", "/elsewhere/x.txt")];
    const report = await rollbackToCheckpoint({
      cwd: dir,
      messages,
      checkpoint: 1,
      tags: c.tags,
      backupTag: "baked/b3",
      claimedBy: (p) => (p.endsWith("a.txt") ? "TAB-2" : null),
    });
    const reasons = Object.fromEntries(report.skipped.map((s) => [s.path.split(/[\\/]/).at(-1), s.reason]));
    expect(reasons["secret.txt"]).toContain("ignored");
    expect(reasons["x.txt"]).toBe("outside the workspace");
    expect(reasons["a.txt"]).toBe("being edited in TAB-2");
    expect(read(dir, "secret.txt")).toBe("s");
  });

  test("a turn edited after the newest snapshot keeps its files unless forced", async () => {
    const dir = repo();
    const c = await conversation(dir);
    writeFileSync(join(dir, "a.txt"), "v3");
    const messages = [...c.messages, user("third"), edit("a.txt")];
    const report = await rollbackToCheckpoint({ cwd: dir, messages, checkpoint: 1, tags: c.tags, backupTag: "baked/b4" });
    expect(read(dir, "a.txt")).toBe("v3");
    expect(report.skipped[0]?.reason).toContain("no checkpoint holds");
  });

  test("needs Git only when there are files to restore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-nogit-"));
    dirs.push(dir);
    const messages = [user("x"), edit("f.txt")];
    const none = await rollbackToCheckpoint({ cwd: dir, messages, checkpoint: 1, tags: [], backupTag: "b" });
    expect(none.restored).toEqual([]);
    await expect(rollbackToCheckpoint({ cwd: dir, messages, checkpoint: 0, tags: [], backupTag: "b" })).rejects.toBeInstanceOf(
      RollbackError,
    );
  });

  test("copied tags survive deleting the source tags", async () => {
    const dir = repo();
    const c = await conversation(dir);
    const copied = await copyCheckpointTags(dir, c.tags, 1, "forktab1");
    expect(copied.map((t) => t.index)).toEqual([0, 1]);
    git(dir, "tag", "-d", "baked/cp-tab-test-1");
    expect(await tagExists(dir, copied[1]?.gitTag ?? "")).toBe(true);
    expect((await readFileAt(dir, copied[1]?.gitTag ?? "", "a.txt"))?.toString()).toBe("v1");
  });
});

describe("saved session fork", () => {
  test("saves a new session at the checkpoint and rolls files back", async () => {
    const dir = repo();
    const c = await conversation(dir);
    const store = new SessionManager(dir);
    const now = Date.now();
    await store.saveSession(
      {
        id: "source-session",
        title: "Source",
        cwd: dir,
        startedAt: now,
        updatedAt: now,
        activeTabId: "tab-test",
        bakeMode: "default",
        tabs: [
          {
            id: "tab-test",
            label: "TAB-1",
            activeModel: "openai/gpt-test",
            sessionId: "source-session",
            planMode: false,
            planRequest: null,
            coAuthorCommits: false,
            tokenUsage: { prompt: 5, completion: 5, total: 10 },
            messageRange: { startLine: 0, endLine: c.messages.length },
            checkpointTags: c.tags,
          },
        ],
      },
      new Map([["tab-test", c.messages]]),
    );
    const result = await forkSavedSession({ store, cwd: dir, session: "source", checkpoint: 1, rollbackFiles: true });
    expect(result.messageCount).toBe(2);
    expect(result.rollback?.restored).toEqual([join(dir, "a.txt")]);
    expect(read(dir, "a.txt")).toBe("v1");
    const saved = store.loadSession(result.sessionId);
    const tab = saved?.meta.tabs[0];
    expect(saved?.meta.customTitle).toBe("Source (fork)");
    expect(saved?.tabMessages.get(tab?.id ?? "")?.map((m) => m.id)).toEqual([c.u1.id, c.a1.id]);
    expect(tab?.checkpointTags?.map((t) => t.index)).toEqual([0, 1]);
    // The source session is untouched.
    expect(store.loadSession("source-session")?.tabMessages.get("tab-test")).toHaveLength(4);
  });
});

/** Each turn writes the file it is given and reports an edit_file call for it. */
class EditingHost implements ChatAgentHost {
  edits: { path: string; text: string }[] = [];
  async agent(_request: TurnAgentRequest) {
    const next = this.edits.shift();
    return {
      contextWindow: 1000,
      agent: {
        stream: async (_args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => ({
          stream: (async function* () {
            if (next) {
              yield { type: "tool-call", toolCallId: "c", toolName: "edit_file", input: { path: next.path } };
              writeFileSync(next.path, next.text);
              yield { type: "tool-result", toolCallId: "c", toolName: "edit_file", output: { success: true, output: "ok" } };
            }
            yield { type: "text-delta", text: "done" };
            yield { type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 } };
          })(),
          responseMessages: Promise.resolve([]),
        }),
      },
    };
  }
  release() {}
  async dispose() {}
}

describe("API sessions", () => {
  test("snapshot each editing turn and fork with file rollback", async () => {
    const dir = repo();
    const host = new EditingHost();
    const chat = new ChatService({ workspace: dir, config: { ...DEFAULT_CONFIG, defaultModel: "openai/gpt-test" }, host });
    const file = join(dir, "a.txt");
    host.edits.push({ path: file, text: "v1" }, { path: file, text: "v2" });
    const session = await chat.create({});
    session.send("first");
    await session.settled();
    session.send("second");
    await session.settled();
    expect(read(dir, "a.txt")).toBe("v2");
    expect(session.checkpointTags.map((t) => t.index)).toEqual([0, 1, 2]);

    const firstAnswer = session.messages[1]?.id;
    const plain = await chat.fork(session.id, firstAnswer);
    expect(plain.rollback).toBeNull();
    expect(read(dir, "a.txt")).toBe("v2");

    const { session: fork, rollback } = await chat.fork(session.id, firstAnswer, { rollbackFiles: true });
    expect(read(dir, "a.txt")).toBe("v1");
    expect(rollback?.restored).toEqual([file]);
    expect(fork.messages).toHaveLength(2);
    expect(fork.checkpointTags.map((t) => t.index)).toEqual([0, 1]);

    const { rollback: toStart } = await chat.fork(session.id, session.messages[0]?.id, { rollbackFiles: true });
    expect(read(dir, "a.txt")).toBe("v0");
    expect(toStart?.checkpoint).toBe(0);
    await chat.shutdown();
  });
});
