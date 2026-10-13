import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { savedSessionCheckpoints } from "../src/core/checkpoints/list.js";
import { register } from "../src/core/commands/checkpoint.js";
import { SessionManager } from "../src/core/sessions/manager.js";
import { buildTabMeta } from "../src/hooks/useSessionBuilder.js";
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

/**
 * A chat whose messages live in a plain array, like the command handlers see it. With a session
 * store it saves the tab as the terminal UI's autosave does.
 */
function fakeChat(initial: ChatMessage[], save?: { store: SessionManager; id: string; cwd: string }) {
  const chat = {
    messages: initial,
    isLoading: false,
    persisted: [] as string[][],
    setMessages(action: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) {
      chat.messages = typeof action === "function" ? action(chat.messages) : action;
    },
    setCoreMessages() {},
    async persist(options: { rewrite?: boolean } = {}) {
      chat.persisted.push(chat.messages.map((m) => m.id));
      if (save) await saveTab(save, chat.messages, options);
    },
  };
  return chat;
}

/** Saves the tab with the slice and metadata the terminal UI's autosave and exit save write. */
async function saveTab(
  save: { store: SessionManager; id: string; cwd: string },
  messages: ChatMessage[],
  options: { rewrite?: boolean } = {},
): Promise<void> {
  const filtered = messages.filter((m) => m.role !== "system" || m.showInChat);
  const { tabMeta } = buildTabMeta({
    tabId: TAB,
    tabLabel: "Tab",
    activeModel: "openai/gpt-test",
    sessionId: save.id,
    planMode: false,
    planRequest: null,
    coAuthorCommits: false,
    bakeMode: "default",
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    messages: filtered,
  });
  await save.store.saveTab(
    save.id,
    tabMeta,
    filtered,
    undefined,
    { title: "t", cwd: save.cwd, bakeMode: "default", activeTabId: TAB },
    options,
  );
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

test("a /undo is saved at once and survives a quit and resume, so /redo still works", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baked-undo-resume-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "t-a.txt"), "seed");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const store = useCheckpointStore.getState();
  const sessions = new SessionManager(dir);
  const save = { store: sessions, id: "8270aaaa-resume", cwd: dir };

  // Turn 1 writes t-a.txt = alpha; turn 2 creates t-b.txt and changes t-a.txt to gamma. The
  // autosave at the end of each turn saves the tab.
  await store.ensureBaseTag(TAB, dir, []);
  writeFileSync(join(dir, "t-a.txt"), "alpha");
  let messages = [user("u1"), edits("a1", ["t-a.txt"])];
  store.syncFromMessages(TAB, messages, false);
  await store.tagFinishedTurns(TAB, dir);
  await saveTab(save, messages);
  writeFileSync(join(dir, "t-a.txt"), "gamma");
  writeFileSync(join(dir, "t-b.txt"), "beta");
  messages = [...messages, user("u2"), edits("a2", ["t-a.txt", "t-b.txt"])];
  store.syncFromMessages(TAB, messages, false);
  await store.tagFinishedTurns(TAB, dir);
  await saveTab(save, messages);

  const handlers = new Map<string, CommandHandler>();
  register(handlers);
  const chat = fakeChat(messages, save);
  const ctx = { tabMgr: { activeTabId: TAB }, chat, cwd: dir, refreshGit() {} } as unknown as CommandContext;
  await handlers.get("/undo")?.("/undo", ctx);
  expect(readFileSync(join(dir, "t-a.txt"), "utf8")).toBe("alpha");
  expect(existsSync(join(dir, "t-b.txt"))).toBe(false);

  // The session file already holds the shortened conversation and the undone turn.
  let saved = sessions.loadSession(save.id);
  expect(saved?.tabMessages.get(TAB)?.map((m) => m.id)).toEqual(["u1", "a1"]);
  expect(saved?.meta.tabs[0]?.redoTurns?.map((t) => t.anchorMessageId)).toEqual(["u2"]);

  // The exit save writes the same state again and keeps it.
  const live = chat.messages.filter((m) => m.role !== "system");
  await saveTab(save, live);
  saved = sessions.loadSession(save.id);
  expect(saved?.tabMessages.get(TAB)?.map((m) => m.id)).toEqual(["u1", "a1"]);
  const tab = saved?.meta.tabs[0];
  expect(tab?.redoTurns?.map((t) => t.anchorMessageId)).toEqual(["u2"]);
  expect(tab?.checkpointTags?.length).toBe(3);

  // Resume: a fresh store restores the snapshots and the redo stack from the session file.
  store.clear(TAB);
  store.restoreTagsFromMeta(TAB, tab?.checkpointTags ?? [], tab?.redoTurns);
  const restored = saved?.tabMessages.get(TAB) ?? [];
  store.syncFromMessages(TAB, restored, false);
  const resumed = fakeChat(restored, save);
  const resumedCtx = { ...ctx, chat: resumed } as unknown as CommandContext;
  await handlers.get("/redo")?.("/redo", resumedCtx);
  expect(resumed.messages.at(-1)?.content).toContain("Redo applied.");
  expect(readFileSync(join(dir, "t-a.txt"), "utf8")).toBe("gamma");
  expect(readFileSync(join(dir, "t-b.txt"), "utf8")).toBe("beta");
  saved = sessions.loadSession(save.id);
  expect(saved?.tabMessages.get(TAB)?.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
  expect(saved?.meta.tabs[0]?.redoTurns).toBeUndefined();
});

test("the redo stack survives the first sync after a resume and goes once a new turn starts", () => {
  const store = useCheckpointStore.getState();
  const undone = { index: 2, anchorMessageId: "u2", messages: [user("u2"), edits("a2", ["x.txt"])] };
  store.restoreTagsFromMeta(TAB, [], [undone]);
  store.syncFromMessages(TAB, [user("u1"), edits("a1", ["x.txt"])], false);
  expect(store.canRedo(TAB)).toBe(true);
  // A redo puts the same turn back: the stack is not stale.
  store.syncFromMessages(TAB, [user("u1"), edits("a1", ["x.txt"]), ...undone.messages], false);
  expect(useCheckpointStore.getState().redoTurns(TAB)).toHaveLength(1);
  // A different turn in its place is a new turn after the undo.
  store.syncFromMessages(TAB, [user("u1"), edits("a1", ["x.txt"]), user("u9")], true);
  expect(store.canRedo(TAB)).toBe(false);
});

test("TUI scenario: /undo, quit, resume, /redo restores the files from the kept snapshot tags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baked-undo-quit-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "seed.txt"), "seed");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const store = useCheckpointStore.getState();
  const sessions = new SessionManager(dir);
  const save = { store: sessions, id: "8270bbbb-quit", cwd: dir };
  const handlers = new Map<string, CommandHandler>();
  register(handlers);

  // First TUI run. Turn 1 creates t-a.txt = alpha; turn 2 creates t-b.txt and writes gamma to
  // t-a.txt. Each turn ends with the tab's snapshot and the autosave.
  await store.ensureBaseTag(TAB, dir, []);
  writeFileSync(join(dir, "t-a.txt"), "alpha");
  let messages = [user("u1"), edits("a1", ["t-a.txt"])];
  store.syncFromMessages(TAB, messages, false);
  await store.tagFinishedTurns(TAB, dir);
  await saveTab(save, messages);
  await store.ensureBaseTag(TAB, dir, messages);
  writeFileSync(join(dir, "t-a.txt"), "gamma");
  writeFileSync(join(dir, "t-b.txt"), "beta");
  messages = [...messages, user("u2"), edits("a2", ["t-a.txt", "t-b.txt"])];
  store.syncFromMessages(TAB, messages, false);
  await store.tagFinishedTurns(TAB, dir);
  await saveTab(save, messages);
  const turnTags = git(dir, "tag", "-l", "baked/cp-*").trim().split("\n");
  expect(turnTags).toHaveLength(3);

  const chat = fakeChat(messages, save);
  const ctx = { tabMgr: { activeTabId: TAB }, chat, cwd: dir, refreshGit() {} } as unknown as CommandContext;
  await handlers.get("/undo")?.("/undo", ctx);
  expect(chat.messages.at(-1)?.content).toContain("Restored 1 file(s), removed 1.");
  expect(readFileSync(join(dir, "t-a.txt"), "utf8")).toBe("alpha");
  expect(existsSync(join(dir, "t-b.txt"))).toBe(false);

  // Quit (Ctrl+C): the shutdown saves every tab, then the renderer unmounts the tab views, which
  // release their checkpoint state.
  await saveTab(
    save,
    chat.messages.filter((m) => m.role !== "system"),
  );
  await store.releaseTab(TAB, dir);
  expect(git(dir, "tag", "-l", "baked/cp-*").trim().split("\n")).toEqual(turnTags);

  // `baked --session ID`: the session is loaded, the tab's tags and redo stack restored before the
  // tab view mounts and syncs its messages.
  const saved = sessions.loadSession(save.id);
  const tab = saved?.meta.tabs[0];
  expect(tab?.redoTurns?.map((t) => t.anchorMessageId)).toEqual(["u2"]);
  store.restoreTagsFromMeta(TAB, tab?.checkpointTags ?? [], tab?.redoTurns);
  const restored = saved?.tabMessages.get(TAB) ?? [];
  store.syncFromMessages(TAB, restored, false);

  const resumed = fakeChat(restored, save);
  await handlers.get("/redo")?.("/redo", { ...ctx, chat: resumed } as unknown as CommandContext);
  expect(resumed.messages.at(-1)?.content).toContain("Redo applied. Restored 2 file(s).");
  expect(readFileSync(join(dir, "t-a.txt"), "utf8")).toBe("gamma");
  expect(readFileSync(join(dir, "t-b.txt"), "utf8")).toBe("beta");
  for (const t of turnTags) expect(git(dir, "tag", "-l", t).trim()).toBe(t);

  // Quitting the resumed session keeps them as well.
  await saveTab(save, resumed.messages.filter((m) => m.role !== "system"));
  await store.releaseTab(TAB, dir);
  expect(git(dir, "tag", "-l", "baked/cp-*").trim().split("\n")).toEqual(turnTags);
});

test("closing a tab drops its snapshot tags, since the tab leaves the session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baked-undo-close-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "seed.txt"), "seed");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const store = useCheckpointStore.getState();
  await store.ensureBaseTag(TAB, dir, []);
  writeFileSync(join(dir, "t-a.txt"), "alpha");
  store.syncFromMessages(TAB, [user("u1"), edits("a1", ["t-a.txt"])], false);
  await store.tagFinishedTurns(TAB, dir);
  expect(git(dir, "tag", "-l", "baked/cp-*").trim().split("\n")).toHaveLength(2);

  store.discardTags(TAB);
  await store.releaseTab(TAB, dir);
  expect(git(dir, "tag", "-l", "baked/cp-*").trim()).toBe("");
});

test("session checkpoints reports no snapshot for a turn whose tag is gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baked-undo-stale-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "seed.txt"), "seed");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const store = useCheckpointStore.getState();
  const sessions = new SessionManager(dir);
  const save = { store: sessions, id: "8270cccc-stale", cwd: dir };
  await store.ensureBaseTag(TAB, dir, []);
  writeFileSync(join(dir, "t-a.txt"), "alpha");
  const messages = [user("u1"), edits("a1", ["t-a.txt"])];
  store.syncFromMessages(TAB, messages, false);
  await store.tagFinishedTurns(TAB, dir);
  await saveTab(save, messages);
  expect(savedSessionCheckpoints(sessions, save.id).checkpoints.map((c) => c.snapshot)).toEqual([
    true,
  ]);

  const turnTag = store.getCheckpoints(TAB)[0]?.gitTag ?? "";
  git(dir, "tag", "-d", turnTag);
  expect(savedSessionCheckpoints(sessions, save.id).checkpoints.map((c) => c.snapshot)).toEqual([
    false,
  ]);
});
