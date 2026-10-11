import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchCheckpointPrefix, register } from "../src/core/commands/checkpoint.js";
import { resolveAlias } from "../src/core/commands/registry.js";
import type { CommandHandler } from "../src/core/commands/types.js";
import { useCheckpointStore } from "../src/stores/checkpoints.js";
import type { ChatMessage } from "../src/types/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const dirs: string[] = [];
afterEach(async () => {
  const store = useCheckpointStore.getState();
  for (const dir of dirs) await store.cleanupGitTags("tab-redo", dir);
  store.clear("tab-redo");
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

let seq = 0;
const user = (id: string): ChatMessage => ({ id, role: "user", content: id, timestamp: ++seq });
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

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-redo-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), "local.env\n");
  writeFileSync(join(dir, "a.txt"), "v0");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/**
 * Turn 1 edits a.txt; turn 2 edits it again, adds src/new/b.txt and touches an ignored file;
 * turn 3 edits a.txt once more. Every turn is snapshotted, as the terminal UI does after a turn.
 */
async function threeTurns(dir: string) {
  const store = useCheckpointStore.getState();
  await store.ensureBaseTag("tab-redo", dir, []);
  const messages: ChatMessage[] = [];
  const turn = async (prompt: string, write: () => void, files: string[]) => {
    write();
    messages.push(user(prompt), edit(...files));
    store.syncFromMessages("tab-redo", [...messages], false);
    const index = store.getCheckpoints("tab-redo").length;
    expect(await store.createGitTag("tab-redo", index, dir)).toBe(true);
  };
  await turn("u1", () => writeFileSync(join(dir, "a.txt"), "v1"), [join(dir, "a.txt")]);
  await turn(
    "u2",
    () => {
      writeFileSync(join(dir, "a.txt"), "v2");
      mkdirSync(join(dir, "src", "new"), { recursive: true });
      writeFileSync(join(dir, "src", "new", "b.txt"), "new");
      writeFileSync(join(dir, "local.env"), "SECRET=1");
    },
    [join(dir, "a.txt"), join(dir, "src", "new", "b.txt"), join(dir, "local.env")],
  );
  await turn("u3", () => writeFileSync(join(dir, "a.txt"), "v3"), ["a.txt"]);
  return messages;
}

const ids = (messages: ChatMessage[] | undefined) =>
  messages?.filter((m) => m.role === "user").map((m) => m.id);
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

test("/undo keeps the whole target turn, /redo brings turns back one at a time", async () => {
  const dir = repo();
  const live = await threeTurns(dir);
  const store = useCheckpointStore.getState();

  const undone = await store.undoToCheckpoint("tab-redo", 1, dir, live);
  expect(ids(undone?.messages)).toEqual(["u1"]);
  expect(undone?.messages).toHaveLength(2);
  expect(read(dir, "a.txt")).toBe("v1");
  expect(existsSync(join(dir, "src", "new", "b.txt"))).toBe(false);
  expect(read(dir, "local.env")).toBe("SECRET=1");
  expect(undone?.rollback?.skipped.map((s) => s.reason)).toEqual([
    expect.stringContaining("ignored"),
  ]);
  expect(undone?.rollback?.backupTag).toMatch(/^baked\/undo-backup-/);
  expect(store.getRedoCount("tab-redo")).toBe(2);

  // The UI syncs the store from the new messages; that keeps the redo list.
  store.syncFromMessages("tab-redo", undone?.messages ?? [], false);
  expect(store.getRedoCount("tab-redo")).toBe(2);

  const second = await store.redo("tab-redo", dir, undone?.messages ?? []);
  expect(second?.checkpoint).toBe(2);
  expect(ids(second?.messages)).toEqual(["u1", "u2"]);
  expect(read(dir, "a.txt")).toBe("v2");
  expect(read(dir, "src/new/b.txt")).toBe("new");
  store.syncFromMessages("tab-redo", second?.messages ?? [], false);
  expect(store.getRedoCount("tab-redo")).toBe(1);

  const third = await store.redo("tab-redo", dir, second?.messages ?? []);
  expect(ids(third?.messages)).toEqual(["u1", "u2", "u3"]);
  expect(read(dir, "a.txt")).toBe("v3");
  expect(store.canRedo("tab-redo")).toBe(false);
  expect(await store.redo("tab-redo", dir, third?.messages ?? [])).toBeNull();
});

test("/undo leaves files changed outside the agent unless forced", async () => {
  const dir = repo();
  const live = await threeTurns(dir);
  const store = useCheckpointStore.getState();
  writeFileSync(join(dir, "a.txt"), "user edit");

  const kept = await store.undoToCheckpoint("tab-redo", 2, dir, live);
  expect(read(dir, "a.txt")).toBe("user edit");
  expect(kept?.rollback?.skipped[0]?.reason).toContain("no checkpoint holds");

  // Redo, then undo again with force.
  const back = await store.redo("tab-redo", dir, kept?.messages ?? []);
  const forced = await store.undoToCheckpoint("tab-redo", 2, dir, back?.messages ?? [], {
    force: true,
  });
  expect(read(dir, "a.txt")).toBe("v2");
  expect(forced?.rollback?.restored).toEqual([join(dir, "a.txt")]);
});

test("a new prompt after /undo ends the redo list; undo to the last turn does nothing", async () => {
  const dir = repo();
  const live = await threeTurns(dir);
  const store = useCheckpointStore.getState();
  expect(await store.undoToCheckpoint("tab-redo", 3, dir, live)).toBeNull();

  const undone = await store.undoToCheckpoint("tab-redo", 0, dir, live);
  expect(undone?.messages).toEqual([]);
  expect(read(dir, "a.txt")).toBe("v0");
  expect(store.getRedoCount("tab-redo")).toBe(3);
  store.syncFromMessages("tab-redo", [user("other")], true);
  expect(store.canRedo("tab-redo")).toBe(false);
  expect(store.snapshotTags("tab-redo").map((t) => t.index)).toEqual([0]);
});

test("/undo and /redo resolve to the checkpoint commands", () => {
  const map = new Map<string, CommandHandler>();
  register(map);
  expect(map.get("/undo")).toBe(map.get("/checkpoint undo"));
  expect(map.get("/redo")).toBe(map.get("/checkpoint redo"));
  expect(matchCheckpointPrefix("/undo 2")).toBe(map.get("/checkpoint undo") ?? null);
  expect(matchCheckpointPrefix("/undo 2 --force")).toBe(map.get("/checkpoint undo") ?? null);
  expect(matchCheckpointPrefix("/redo --force")).toBe(map.get("/checkpoint redo") ?? null);
  expect(resolveAlias("/redo")).toBe("/checkpoint redo");
});
