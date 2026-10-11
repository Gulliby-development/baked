import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotWorkspace } from "../src/core/checkpoints/snapshot.js";
import { matchCheckpointPrefix, register } from "../src/core/commands/checkpoint.js";
import { resolveAlias } from "../src/core/commands/registry.js";
import type { CommandHandler } from "../src/core/commands/types.js";
import { type Checkpoint, useCheckpointStore } from "../src/stores/checkpoints.js";
import type { ChatMessage } from "../src/types/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const dirs: string[] = [];
afterEach(async () => {
  useCheckpointStore.getState().clear("tab-redo");
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

const cp = (index: number, anchor: string, gitTag: string, filesEdited: string[]): Checkpoint => ({
  index,
  promptPreview: anchor,
  prompt: anchor,
  anchorMessageId: anchor,
  startedAt: index,
  durationMs: 1,
  filesRead: [],
  filesEdited,
  lineDelta: [0, 0],
  gitTag,
  status: "done",
  undone: false,
});

const msg = (id: string, role: "user" | "assistant"): ChatMessage => ({
  id,
  role,
  content: id,
  timestamp: 0,
});

test("/redo restores what /undo rolled back, including new folders, and keeps ignored files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baked-redo-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), "local.env\n");
  writeFileSync(join(dir, "a.txt"), "v0");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");

  // Turn 1 edits a.txt; turn 2 edits it again, adds src/new/b.txt and touches an ignored file.
  writeFileSync(join(dir, "a.txt"), "v1");
  expect(await snapshotWorkspace(dir, "baked/cp-redo-1", "cp1")).toBe(true);
  writeFileSync(join(dir, "a.txt"), "v2");
  mkdirSync(join(dir, "src", "new"), { recursive: true });
  writeFileSync(join(dir, "src", "new", "b.txt"), "new");
  writeFileSync(join(dir, "local.env"), "SECRET=1");
  expect(await snapshotWorkspace(dir, "baked/cp-redo-2", "cp2")).toBe(true);

  const files2 = [join(dir, "a.txt"), join(dir, "src", "new", "b.txt"), join(dir, "local.env")];
  useCheckpointStore.setState((s) => ({
    tabs: {
      ...s.tabs,
      "tab-redo": {
        checkpoints: [
          cp(1, "u1", "baked/cp-redo-1", [join(dir, "a.txt")]),
          cp(2, "u2", "baked/cp-redo-2", files2),
        ],
        viewing: null,
        redoStack: [],
        lastSyncedLen: 4,
      },
    },
  }));
  const live = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user"), msg("a2", "assistant")];
  const store = useCheckpointStore.getState();

  const undone = await store.undoToCheckpoint("tab-redo", 1, dir, live);
  expect(undone?.messages.map((m) => m.id)).toEqual(["u1"]);
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("v1");
  expect(existsSync(join(dir, "src", "new", "b.txt"))).toBe(false);
  expect(readFileSync(join(dir, "local.env"), "utf8")).toBe("SECRET=1");
  expect(store.canRedo("tab-redo")).toBe(true);

  // Simulate the undo also removing the folder the turn created.
  rmSync(join(dir, "src"), { recursive: true, force: true });
  const redone = await store.redo("tab-redo", dir, undone?.messages ?? []);
  expect(redone?.messages.map((m) => m.id)).toEqual(["u1", "u2", "a2"]);
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("v2");
  expect(readFileSync(join(dir, "src", "new", "b.txt"), "utf8")).toBe("new");
  expect(readFileSync(join(dir, "local.env"), "utf8")).toBe("SECRET=1");
  expect(store.canRedo("tab-redo")).toBe(false);
});

test("/undo and /redo resolve to the checkpoint commands", () => {
  const map = new Map<string, CommandHandler>();
  register(map);
  expect(map.get("/undo")).toBe(map.get("/checkpoint undo"));
  expect(map.get("/redo")).toBe(map.get("/checkpoint redo"));
  expect(matchCheckpointPrefix("/undo 2")).toBe(map.get("/checkpoint undo") ?? null);
  expect(resolveAlias("/redo")).toBe("/checkpoint redo");
});
