import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCheckpoints } from "../src/core/checkpoints/list.js";
import { rewindSavedSession } from "../src/core/checkpoints/session-rewind.js";
import { tagExists } from "../src/core/checkpoints/snapshot.js";
import { SessionManager } from "../src/core/sessions/manager.js";
import { assistantMessage, streamTurn } from "../src/headless/run.js";
import {
  beginHeadlessTurn,
  endHeadlessTurn,
  type HeadlessSession,
  newHeadlessSession,
  openHeadlessSession,
  saveHeadlessSession,
} from "../src/headless/saved-session.js";
import type { ChatMessage } from "../src/types/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const dirs: string[] = [];
afterEach(async () => {
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

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-headless-session-"));
  dirs.push(dir);
  writeFileSync(join(dir, "a.txt"), "v0");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf-8");

type Agent = Parameters<typeof streamTurn>[0];

/** An agent whose turn writes each file through an `edit_file` call, as the real tool would. */
function editingAgent(edits: { path: string; text: string }[], failing: string[] = []): Agent {
  return {
    stream: async () => ({
      stream: (async function* () {
        for (const [i, edit] of edits.entries()) {
          const id = `c${String(i)}`;
          yield { type: "tool-call", toolCallId: id, toolName: "edit_file", input: { path: edit.path } };
          writeFileSync(edit.path, edit.text);
          yield { type: "tool-result", toolCallId: id, toolName: "edit_file", output: { success: true, output: "ok" } };
        }
        for (const path of failing) {
          yield { type: "tool-call", toolCallId: "bad", toolName: "edit_file", input: { path } };
          yield { type: "tool-error", toolCallId: "bad", toolName: "edit_file", error: new Error("denied") };
        }
        yield { type: "text-delta", text: "done" };
        yield { type: "finish-step", usage: { inputTokens: 2, outputTokens: 1 } };
      })(),
    }),
  } as unknown as Agent;
}

/**
 * One run of `baked --headless --save-session [--session ID]`: snapshot, stream, record, save.
 * Without a session the run starts a new one.
 */
async function headlessRun(
  dir: string,
  store: SessionManager,
  sessionId: string | null,
  prompt: string,
  edits: { path: string; text: string }[],
): Promise<HeadlessSession> {
  const opened = sessionId ? openHeadlessSession(store, sessionId) : newHeadlessSession();
  if (!opened) throw new Error(`no session ${String(sessionId)}`);
  const session: HeadlessSession = opened;
  const history = session.messages;
  await beginHeadlessTurn(session, dir, history);
  const turn = await streamTurn(editingAgent(edits), [], prompt, new AbortController().signal, {
    json: true,
    quiet: true,
    showProgress: false,
  });
  const messages: ChatMessage[] = [
    ...history,
    { id: crypto.randomUUID(), role: "user", content: prompt, timestamp: Date.now() },
    assistantMessage(turn),
  ];
  await endHeadlessTurn(session, dir, messages, prompt);
  await saveHeadlessSession(store, session, {
    messages,
    tokens: turn.tokens,
    cwd: dir,
    modelId: "openai/gpt-test",
    mode: "default",
    effort: "default",
  });
  return session;
}

describe("headless saved sessions", () => {
  test("a turn records its tool calls, failed ones as failures", async () => {
    const dir = repo();
    const turn = await streamTurn(
      editingAgent([{ path: join(dir, "a.txt"), text: "v1" }], [join(dir, "b.txt")]),
      [],
      "go",
      new AbortController().signal,
      { json: true, quiet: true, showProgress: false },
    );
    const message = assistantMessage(turn);
    expect(message.toolCalls?.map((c) => [c.name, c.args.path, c.result?.success])).toEqual([
      ["edit_file", join(dir, "a.txt"), true],
      ["edit_file", join(dir, "b.txt"), false],
    ]);
    expect(message.toolCalls?.[1]?.result?.error).toBe("denied");
  });

  test("turns are snapshotted, so session undo and redo restore their files", async () => {
    const dir = repo();
    const store = new SessionManager(dir);
    const session = await headlessRun(dir, store, null, "first", [
      { path: join(dir, "a.txt"), text: "v1" },
    ]);
    await headlessRun(dir, store, session.id, "second", [
      { path: join(dir, "a.txt"), text: "v2" },
      { path: join(dir, "b.txt"), text: "new" },
    ]);

    const saved = store.loadSession(session.id);
    const messages = saved?.tabMessages.get("headless") ?? [];
    const tab = saved?.meta.tabs[0];
    expect(tab?.checkpointTags?.map((t) => t.index)).toEqual([0, 1, 2]);
    for (const t of tab?.checkpointTags ?? []) expect(await tagExists(dir, t.gitTag)).toBe(true);
    const list = listCheckpoints(messages, tab?.checkpointTags ?? [], []);
    expect(list.checkpoints.map((c) => [c.index, c.snapshot, c.filesEdited.length])).toEqual([
      [1, true, 1],
      [2, true, 2],
    ]);

    const undone = await rewindSavedSession({ store, cwd: dir, session: session.id, action: "undo" });
    expect(undone).toMatchObject({ checkpoint: 1, messageCount: 2, redoCount: 1 });
    expect(read(dir, "a.txt")).toBe("v1");
    expect(existsSync(join(dir, "b.txt"))).toBe(false);

    const redone = await rewindSavedSession({ store, cwd: dir, session: session.id, action: "redo" });
    expect(redone).toMatchObject({ checkpoint: 2, messageCount: 4, redoCount: 0 });
    expect(read(dir, "a.txt")).toBe("v2");
    expect(read(dir, "b.txt")).toBe("new");
  });

  test("--session ID continues and saves the same session, and forgets an undone turn", async () => {
    const dir = repo();
    const store = new SessionManager(dir);
    const first = await headlessRun(dir, store, null, "first", [
      { path: join(dir, "a.txt"), text: "v1" },
    ]);
    const second = await headlessRun(dir, store, first.id, "second", [
      { path: join(dir, "a.txt"), text: "v2" },
    ]);
    await rewindSavedSession({ store, cwd: dir, session: first.id, action: "undo" });

    const resumed = openHeadlessSession(store, first.id.slice(0, 8));
    expect(resumed?.id).toBe(first.id);
    expect(resumed?.messages).toHaveLength(2);
    expect(resumed?.redoTurns).toHaveLength(1);
    const undoneTag = second.checkpointTags.find((t) => t.index === 2)?.gitTag ?? "";
    expect(await tagExists(dir, undoneTag)).toBe(true);
    await headlessRun(dir, store, first.id.slice(0, 8), "third", [
      { path: join(dir, "c.txt"), text: "c" },
    ]);

    expect(store.listSessions().map((s) => s.id)).toEqual([first.id]);
    const saved = store.loadSession(first.id);
    expect(saved?.tabMessages.get("headless")?.map((m) => m.content)).toEqual([
      "first",
      "done",
      "third",
      "done",
    ]);
    const tab = saved?.meta.tabs[0];
    expect(tab?.redoTurns).toBeUndefined();
    expect(tab?.tokenUsage).toMatchObject({ prompt: 6, completion: 3, total: 9 });
    expect(saved?.tabCoreMessages?.get("headless")).toHaveLength(6);
    // The undone turn's snapshot went with it; the new turn has its own.
    expect(await tagExists(dir, undoneTag)).toBe(false);
    expect(tab?.checkpointTags?.map((t) => t.index)).toEqual([0, 1, 2]);
  });
});
