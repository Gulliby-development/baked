import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { type ChatAgentHost, ChatService, type TurnAgentRequest } from "../src/core/chat/sessions.js";
import { rewindSavedSession } from "../src/core/checkpoints/session-rewind.js";
import { tagExists } from "../src/core/checkpoints/snapshot.js";
import { redoTurn, TurnUndoError, undoTurns } from "../src/core/checkpoints/undo.js";
import { SessionManager } from "../src/core/sessions/manager.js";
import type { ChatMessage } from "../src/types/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const dirs: string[] = [];
const services: ChatService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function repo(withGit = true): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-undo-"));
  dirs.push(dir);
  writeFileSync(join(dir, "a.txt"), "v0");
  if (withGit) {
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf-8");

/** Each turn writes the files it is given and reports an edit_file call for each. */
class EditingHost implements ChatAgentHost {
  edits: { path: string; text: string }[][] = [];
  async agent(_request: TurnAgentRequest) {
    const next = this.edits.shift() ?? [];
    return {
      contextWindow: 1000,
      agent: {
        stream: async (_args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => ({
          stream: (async function* () {
            for (const [i, edit] of next.entries()) {
              const id = `c${String(i)}`;
              yield { type: "tool-call", toolCallId: id, toolName: "edit_file", input: { path: edit.path } };
              writeFileSync(edit.path, edit.text);
              yield {
                type: "tool-result",
                toolCallId: id,
                toolName: "edit_file",
                output: { success: true, output: "ok" },
              };
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

/** A session that ran two turns: #1 writes a.txt = v1, #2 writes a.txt = v2 and creates b.txt. */
async function twoTurns(dir: string) {
  const host = new EditingHost();
  const chat = new ChatService({
    workspace: dir,
    config: { ...DEFAULT_CONFIG, defaultModel: "openai/gpt-test" },
    host,
  });
  services.push(chat);
  host.edits.push(
    [{ path: join(dir, "a.txt"), text: "v1" }],
    [
      { path: join(dir, "a.txt"), text: "v2" },
      { path: join(dir, "b.txt"), text: "new" },
    ],
  );
  const session = await chat.create({});
  session.send("first");
  await session.settled();
  session.send("second");
  await session.settled();
  return { chat, host, session };
}

describe("API session undo and redo", () => {
  test("undo drops the last turn and its files, redo puts both back, and both survive a reload", async () => {
    const dir = repo();
    const { session } = await twoTurns(dir);

    const undone = await session.undo();
    expect(undone.checkpoint).toBe(1);
    expect(session.messages.map((m) => m.content)).toEqual(["first", "done"]);
    expect(read(dir, "a.txt")).toBe("v1");
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
    expect(undone.rollback.restored).toEqual([join(dir, "a.txt")]);
    expect(undone.rollback.removed).toEqual([join(dir, "b.txt")]);
    expect(session.detail().redo).toEqual([{ index: 2, prompt: "second" }]);

    // A fresh service reads the undone turn from the saved session.
    const reloaded = new ChatService({ workspace: dir, config: DEFAULT_CONFIG, host: new EditingHost() });
    services.push(reloaded);
    const again = reloaded.get(session.id);
    expect(again.detail().redo).toHaveLength(1);

    const redone = await again.redo();
    expect(redone.checkpoint).toBe(2);
    expect(again.messages.map((m) => m.content)).toEqual(["first", "done", "second", "done"]);
    expect(read(dir, "a.txt")).toBe("v2");
    expect(read(dir, "b.txt")).toBe("new");
    expect(again.detail().redo).toEqual([]);
    await expect(again.redo()).rejects.toMatchObject({ code: "NOTHING_TO_REDO" });
  });

  test("undo to checkpoint 0 restores the workspace before the first turn; a new turn forgets the redo stack", async () => {
    const dir = repo();
    const { host, session } = await twoTurns(dir);
    await session.undo({ toCheckpoint: 0 });
    expect(session.messages).toEqual([]);
    expect(read(dir, "a.txt")).toBe("v0");
    expect(session.detail().redo.map((t) => t.index)).toEqual([1, 2]);
    const undoneTag = session.checkpointTags.find((t) => t.index === 2)?.gitTag ?? "";
    expect(await tagExists(dir, undoneTag)).toBe(true);

    host.edits.push([{ path: join(dir, "a.txt"), text: "other" }]);
    session.send("another");
    await session.settled();
    expect(session.detail().redo).toEqual([]);
    expect(await tagExists(dir, undoneTag)).toBe(false);
    expect(session.checkpointTags.map((t) => t.index)).toEqual([0, 1]);
    await expect(session.undo({ toCheckpoint: 1 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  test("a file changed after the turn stays unless forced", async () => {
    const dir = repo();
    const { session } = await twoTurns(dir);
    writeFileSync(join(dir, "a.txt"), "user edit");
    const kept = await session.undo();
    expect(read(dir, "a.txt")).toBe("user edit");
    expect(kept.rollback.skipped).toEqual([
      { path: join(dir, "a.txt"), reason: expect.stringContaining("no checkpoint holds") },
    ]);
    await session.redo();
    const forced = await session.undo({ force: true });
    expect(read(dir, "a.txt")).toBe("v1");
    expect(forced.rollback.backupTag).toMatch(/^baked\/undo-backup-/);
  });
});

describe("turn undo core", () => {
  const user = (id: string): ChatMessage => ({ id, role: "user", content: id, timestamp: 0 });
  const answer = (id: string, path?: string): ChatMessage => ({
    id,
    role: "assistant",
    content: id,
    timestamp: 0,
    ...(path
      ? {
          toolCalls: [
            { id: `${id}-c`, name: "edit_file", args: { path }, result: { success: true, output: "ok" } },
          ],
        }
      : {}),
  });

  test("outside Git the conversation rewinds and the edited files are reported as left in place", async () => {
    const dir = repo(false);
    const messages = [user("u1"), answer("a1", join(dir, "a.txt"))];
    const undone = await undoTurns({ cwd: dir, messages, tags: [], backupTag: "baked/x" });
    expect(undone.messages).toEqual([]);
    expect(undone.rollback.skipped).toEqual([
      { path: join(dir, "a.txt"), reason: "the workspace is not a Git repository" },
    ]);
    const redone = await redoTurn({ cwd: dir, messages: [], redo: undone.redo, tags: [], backupTag: "baked/y" });
    expect(redone.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  test("nothing to undo, and no redo once the conversation moved on", async () => {
    const dir = repo(false);
    await expect(undoTurns({ cwd: dir, messages: [], tags: [], backupTag: "b" })).rejects.toBeInstanceOf(
      TurnUndoError,
    );
    const undone = await undoTurns({
      cwd: dir,
      messages: [user("u1"), answer("a1"), user("u2"), answer("a2")],
      tags: [],
      backupTag: "b",
    });
    await expect(
      redoTurn({ cwd: dir, messages: [...undone.messages, user("u3")], redo: undone.redo, tags: [], backupTag: "b" }),
    ).rejects.toMatchObject({ code: "NOTHING_TO_REDO" });
  });
});

describe("saved session undo and redo", () => {
  test("rewinds the saved conversation and keeps the undone turn for a redo", async () => {
    const dir = repo();
    const { chat, session } = await twoTurns(dir);
    await chat.shutdown();
    services.splice(services.indexOf(chat), 1);
    const store = new SessionManager(dir);

    const undone = await rewindSavedSession({ store, cwd: dir, session: session.id.slice(0, 8), action: "undo" });
    expect(undone).toMatchObject({ checkpoint: 1, messageCount: 2, redoCount: 1 });
    expect(read(dir, "a.txt")).toBe("v1");
    const saved = store.loadSession(session.id);
    expect(saved?.meta.tabs[0]?.redoTurns?.map((t) => t.index)).toEqual([2]);

    const redone = await rewindSavedSession({ store, cwd: dir, session: session.id, action: "redo" });
    expect(redone).toMatchObject({ checkpoint: 2, messageCount: 4, redoCount: 0 });
    expect(read(dir, "b.txt")).toBe("new");
  });
});
