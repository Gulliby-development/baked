import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "../src/core/commands/checkpoint.js";
import type { CommandContext, CommandHandler } from "../src/core/commands/types.js";
import { useCheckpointStore } from "../src/stores/checkpoints.js";
import type { ChatMessage } from "../src/types/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const TAB = "d4070a62-undo-tab";
const dirs: string[] = [];
afterEach(async () => {
  useCheckpointStore.getState().clear(TAB);
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

const user = (id: string): ChatMessage => ({ id, role: "user", content: id, timestamp: 0 });

/** An assistant message as the chat records an `edit_file` call: relative path, success. */
const edits = (id: string, paths: string[]): ChatMessage => ({
  id,
  role: "assistant",
  content: "done",
  timestamp: 0,
  toolCalls: paths.map((path, i) => ({
    id: `${id}-${String(i)}`,
    name: "edit_file",
    args: { path, content: "x" },
    result: { success: true, output: "ok" },
  })),
});

/** A chat whose messages live in a plain array, like the command handlers see it. */
function fakeChat(initial: ChatMessage[]) {
  const chat = {
    messages: initial,
    isLoading: false,
    persisted: [] as string[][],
    setMessages(action: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) {
      chat.messages = typeof action === "function" ? action(chat.messages) : action;
    },
    setCoreMessages() {},
    persist() {
      chat.persisted.push(chat.messages.map((m) => m.id));
    },
  };
  return chat;
}

test("chat turns are snapshotted, and /undo restores and /redo puts back their files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baked-undo-turns-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "seed.txt"), "seed");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const store = useCheckpointStore.getState();

  // Before the first turn the tab snapshots the workspace.
  await store.ensureBaseTag(TAB, dir, []);

  // Turn 1 creates undo-a.txt; when it finishes the tab snapshots it.
  writeFileSync(join(dir, "undo-a.txt"), "alpha");
  let messages = [user("u1"), edits("a1", ["undo-a.txt"])];
  store.syncFromMessages(TAB, messages, false);
  await store.tagFinishedTurns(TAB, dir);

  // Turn 2 changes seed.txt and creates undo-b.txt.
  writeFileSync(join(dir, "seed.txt"), "changed");
  writeFileSync(join(dir, "undo-b.txt"), "beta");
  messages = [...messages, user("u2"), edits("a2", ["seed.txt", "undo-b.txt"])];
  store.syncFromMessages(TAB, messages, false);
  await store.tagFinishedTurns(TAB, dir);

  const tags = git(dir, "tag", "-l", "baked/cp-*").trim().split("\n");
  expect(tags).toHaveLength(3);
  expect(store.getCheckpoints(TAB).map((c) => c.gitTag !== null)).toEqual([true, true]);

  const handlers = new Map<string, CommandHandler>();
  register(handlers);
  const chat = fakeChat(messages);
  const ctx = {
    tabMgr: { activeTabId: TAB },
    chat,
    cwd: dir,
    refreshGit() {},
  } as unknown as CommandContext;

  await handlers.get("/undo")?.("/undo", ctx);
  expect(readFileSync(join(dir, "seed.txt"), "utf8")).toBe("seed");
  expect(existsSync(join(dir, "undo-b.txt"))).toBe(false);
  expect(readFileSync(join(dir, "undo-a.txt"), "utf8")).toBe("alpha");
  const report = chat.messages.at(-1)?.content ?? "";
  expect(report).toContain("Restored 1 file(s), removed 1.");
  expect(report).toMatch(/Git tag baked\/undo-backup-/);
  // The undo is saved before the next turn, with the undone turn kept for redo.
  expect(chat.persisted.at(-1)).toEqual(["u1", "a1"]);
  expect(store.redoTurns(TAB).map((t) => t.anchorMessageId)).toEqual(["u2"]);

  chat.messages = chat.messages.filter((m) => m.role !== "system");
  await handlers.get("/redo")?.("/redo", ctx);
  expect(readFileSync(join(dir, "seed.txt"), "utf8")).toBe("changed");
  expect(readFileSync(join(dir, "undo-b.txt"), "utf8")).toBe("beta");
  expect(chat.persisted.at(-1)).toEqual(["u1", "a1", "u2", "a2"]);
});
