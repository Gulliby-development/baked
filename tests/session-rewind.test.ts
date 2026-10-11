import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import {
  type ChatAgentHost,
  type ChatEvent,
  ChatService,
  type TurnAgentRequest,
} from "../src/core/chat/sessions.js";
import { listCheckpoints } from "../src/core/checkpoints/rewind.js";
import { SessionManager } from "../src/core/sessions/manager.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const dirs: string[] = [];
const services: ChatService[] = [];
afterEach(async () => {
  for (const chat of services.splice(0)) await chat.shutdown();
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
  const dir = mkdtempSync(join(tmpdir(), "baked-rewind-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "v0");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

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
              const id = `c${i}`;
              yield { type: "tool-call", toolCallId: id, toolName: "edit_file", input: { path: edit.path } };
              writeFileSync(edit.path, edit.text);
              yield { type: "tool-result", toolCallId: id, toolName: "edit_file", output: { success: true, output: "ok" } };
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

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf-8");

/** A session with three turns: a.txt becomes v1, v2, v3; turn 2 also creates b.txt. */
async function threeTurns(dir: string) {
  const host = new EditingHost();
  const chat = new ChatService({
    workspace: dir,
    config: { ...DEFAULT_CONFIG, defaultModel: "openai/gpt-test" },
    host,
  });
  services.push(chat);
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  host.edits.push(
    [{ path: a, text: "v1" }],
    [
      { path: a, text: "v2" },
      { path: b, text: "new" },
    ],
    [{ path: a, text: "v3" }],
  );
  const session = await chat.create({});
  for (const text of ["first", "second\nmore", "third"]) {
    session.send(text);
    await session.settled();
  }
  return { chat, host, session, a, b };
}

describe("checkpoint list", () => {
  test("lists every turn with its prompt, edits and snapshot", async () => {
    const dir = repo();
    const { session, a, b } = await threeTurns(dir);
    const { checkpoints, redo } = session.checkpoints();
    expect(redo).toEqual([]);
    expect(checkpoints.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(checkpoints[1]?.prompt).toBe("second");
    expect(checkpoints[1]?.filesEdited).toEqual([a, b]);
    expect(checkpoints.every((c) => c.snapshot)).toBe(true);
    expect(checkpoints[0]?.endMessageId).toBe(session.messages[1]?.id ?? "");
    expect(listCheckpoints(session.messages, [])[0]?.snapshot).toBe(false);
  });
});

describe("rewind and redo", () => {
  test("rewinds in place with the files, then redoes one turn at a time", async () => {
    const dir = repo();
    const { session, b } = await threeTurns(dir);
    const events: ChatEvent[] = [];
    session.subscribe(session.detail().lastSeq, (e) => events.push(e));

    const back = await session.rewind({ checkpoint: 1, rollbackFiles: true });
    expect(back.checkpoint).toBe(1);
    expect(session.messages).toHaveLength(2);
    expect(read(dir, "a.txt")).toBe("v1");
    expect(existsSync(b)).toBe(false);
    expect(back.rollback?.removed).toEqual([b]);
    expect(back.rollback?.backupTag).toMatch(/^baked\/rewind-backup-/);
    expect(back.redo.map((r) => r.index)).toEqual([2, 3]);
    expect(events.find((e) => e.type === "rewind")).toMatchObject({ action: "rewind", checkpoint: 1, redo: 2 });

    const two = await session.redoNext();
    expect(two.checkpoint).toBe(2);
    expect(session.messages).toHaveLength(4);
    expect(read(dir, "a.txt")).toBe("v2");
    expect(read(dir, "b.txt")).toBe("new");
    const three = await session.redoNext();
    expect(three.checkpoint).toBe(3);
    expect(read(dir, "a.txt")).toBe("v3");
    expect(session.checkpoints().redo).toEqual([]);
    await expect(session.redoNext()).rejects.toMatchObject({ code: "NOTHING_TO_REDO" });

    // The rewound conversation is saved.
    await session.rewind({ checkpoint: 0, rollbackFiles: true });
    expect(read(dir, "a.txt")).toBe("v0");
    const saved = new SessionManager(dir).loadSession(session.id);
    expect(saved?.tabMessages.get(saved.meta.activeTabId)).toEqual([]);
  });

  test("a chat-only rewind leaves the files and its redo does not touch them", async () => {
    const dir = repo();
    const { session } = await threeTurns(dir);
    const back = await session.rewind({ checkpoint: 2, rollbackFiles: false });
    expect(back.rollback).toBeNull();
    expect(read(dir, "a.txt")).toBe("v3");
    expect(back.redo[0]?.filesRolledBack).toBe(false);
    writeFileSync(join(dir, "a.txt"), "mine");
    const again = await session.redoNext();
    expect(again.rollback).toBeNull();
    expect(read(dir, "a.txt")).toBe("mine");
  });

  test("a rewind with files after a chat-only one also restores the dropped turns' files", async () => {
    const dir = repo();
    const { session } = await threeTurns(dir);
    await session.rewind({ checkpoint: 2, rollbackFiles: false });
    await session.rewind({ checkpoint: 1, rollbackFiles: true });
    expect(read(dir, "a.txt")).toBe("v1");
    await session.redoNext();
    expect(read(dir, "a.txt")).toBe("v2");
    await session.redoNext();
    expect(read(dir, "a.txt")).toBe("v3");
  });

  test("files changed outside the agent stay unless forced", async () => {
    const dir = repo();
    const { session } = await threeTurns(dir);
    writeFileSync(join(dir, "a.txt"), "user edit");
    const kept = await session.rewind({ checkpoint: 1, rollbackFiles: true });
    expect(read(dir, "a.txt")).toBe("user edit");
    expect(kept.rollback?.skipped.map((s) => s.path)).toEqual([join(dir, "a.txt")]);
    await session.redoNext();
    await session.redoNext();
    const forced = await session.rewind({ checkpoint: 1, rollbackFiles: true, force: true });
    expect(read(dir, "a.txt")).toBe("v1");
    expect(forced.rollback?.restored).toContain(join(dir, "a.txt"));
  });

  test("a new turn clears the redo list and the dropped turns' snapshots", async () => {
    const dir = repo();
    const { session, host, a } = await threeTurns(dir);
    await session.rewind({ checkpoint: 1, rollbackFiles: true });
    host.edits.push([{ path: a, text: "other" }]);
    session.send("instead");
    await session.settled();
    expect(session.checkpoints().redo).toEqual([]);
    expect(session.checkpointTags.map((t) => t.index)).toEqual([0, 1, 2]);
    expect(session.checkpoints().checkpoints.map((c) => c.prompt)).toEqual(["first", "instead"]);
    await expect(session.redoNext()).rejects.toMatchObject({ code: "NOTHING_TO_REDO" });
  });

  test("an unknown checkpoint and a running turn are refused", async () => {
    const dir = repo();
    const { session } = await threeTurns(dir);
    await expect(session.rewind({ checkpoint: 7, rollbackFiles: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    session.send("fourth");
    await expect(session.rewind({ checkpoint: 1, rollbackFiles: true })).rejects.toMatchObject({
      code: "SESSION_BUSY",
    });
    await session.settled();
  });

  test("without Git a rewind that must restore files is refused and changes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-rewind-nogit-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.txt"), "v0");
    const { session } = await threeTurns(dir);
    await expect(session.rewind({ checkpoint: 1, rollbackFiles: true })).rejects.toMatchObject({
      code: "ROLLBACK_UNAVAILABLE",
    });
    expect(session.messages).toHaveLength(6);
    const chatOnly = await session.rewind({ checkpoint: 1, rollbackFiles: false });
    expect(chatOnly.session.messages).toHaveLength(2);
  });
});
