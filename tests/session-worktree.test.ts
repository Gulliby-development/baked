import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { launchedView, syncLaunched } from "../src/core/chat/coordinator-launch.js";
import { type ChatAgentHost, ChatService, type TurnAgentRequest } from "../src/core/chat/sessions.js";
import { removeTempDir } from "./helpers/temp-dir.js";

/**
 * Scripted scenario for #897: the coordinator launches two editing sessions that each write the
 * same file. Each must work in its own worktree; the project's working copy stays untouched.
 */
class EditingHost implements ChatAgentHost {
  requests: TurnAgentRequest[] = [];
  async agent(request: TurnAgentRequest) {
    this.requests.push(request);
    return {
      contextWindow: 1000,
      agent: {
        stream: async (_args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => {
          // A launched session's agent edits notes.txt where it works, as a write tool would.
          if (!request.coordinator) writeFileSync(join(request.cwd, "notes.txt"), `by ${request.sessionId}\n`);
          return {
            stream: (async function* () {
              yield { type: "text-delta", text: "done" };
              yield { type: "finish-step", usage: { inputTokens: 10, outputTokens: 1 } };
            })(),
            responseMessages: Promise.resolve([]),
          };
        },
      },
    };
  }
  release() {}
  async dispose() {}
}

type Result = { success: boolean; output: string; error?: string };
type Tool = { execute: (input: Record<string, unknown>) => Promise<Result> };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function setup(repo: boolean) {
  const root = mkdtempSync(join(tmpdir(), "baked-session-worktree-"));
  writeFileSync(join(root, "notes.txt"), "original\n");
  if (repo) {
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, ".gitignore"), ".baked/\n");
    git(root, "add", ".");
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  }
  const host = new EditingHost();
  const chat = new ChatService({
    workspace: root,
    config: { defaultModel: "openai/gpt-test" } as never,
    host,
    homeDir: root,
  });
  cleanups.push(async () => {
    await chat.shutdown();
    await removeTempDir(root);
  });
  const coordinator = await chat.coordinator(true);
  if (!coordinator) throw new Error("no coordinator");
  coordinator.send("plan the week");
  await coordinator.settled();
  const tools = (host.requests.at(-1)?.tools ?? {}) as Record<string, Tool>;
  /** Launches a session, saying yes to the confirmation an editing session asks for. */
  const launch = async (input: Record<string, unknown>): Promise<Result> => {
    const pending = tools.launch_session?.execute({ brief: "Edit notes.txt", why: "Edit", ...input });
    if (!pending) throw new Error("no launch_session tool");
    if (input.mode !== "architect") {
      await Bun.sleep(10);
      const prompt = coordinator.pendingPrompts[0];
      if (!prompt) throw new Error("no confirmation prompt");
      coordinator.answer(prompt.id, { approve: true });
    }
    return pending;
  };
  return { root, chat, coordinator, launch };
}

const idOf = (output: string): string => /session ([0-9a-f-]{36})/.exec(output)?.[1] ?? "";

describe("editing sessions launched by the coordinator (#897)", () => {
  test("each works in its own worktree and branch, and the project folder is untouched", async () => {
    const { root, chat, coordinator, launch } = await setup(true);
    const first = await launch({ title: "First edit", mode: "default" });
    const second = await launch({ title: "Second edit", mode: "auto" });
    expect(first.success && second.success).toBe(true);
    const ids = [idOf(first.output), idOf(second.output)];
    for (const id of ids) await chat.get(id).settled();

    const worktrees = ids.map((id) => chat.get(id).summary().worktree);
    expect(worktrees.map((w) => w?.branch)).toEqual(ids.map((id) => `baked/session/${id.slice(0, 8)}`));
    expect(new Set(worktrees.map((w) => w?.path)).size).toBe(2);
    expect(first.output).toContain(`on branch baked/session/${ids[0]?.slice(0, 8)}`);
    for (const [i, worktree] of worktrees.entries()) {
      if (!worktree) throw new Error("no worktree");
      expect(readFileSync(join(worktree.path, "notes.txt"), "utf8")).toBe(`by ${ids[i]}\n`);
      expect(git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(worktree.branch);
    }
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("original\n");

    // The launched panel and the coordinator's notice name the branch.
    expect(launchedView(chat, coordinator.id, null).map((v) => v.worktree?.branch)).toEqual(
      worktrees.map((w) => w?.branch),
    );
    await syncLaunched(chat, coordinator, null);
    const notes = coordinator.messages.filter((m) => m.launch?.kind === "session");
    expect(notes.map((m) => m.launch?.worktree?.branch).sort()).toEqual(
      worktrees.map((w) => w?.branch ?? "").sort(),
    );
    // The list reads the worktree from the saved session as well.
    expect(chat.list().every((s) => s.worktree?.path && existsSync(s.worktree.path))).toBe(true);
  }, 60000);

  test("a read-only session and an opt-out keep the project folder", async () => {
    const { root, chat, launch } = await setup(true);
    const architect = await launch({ title: "Survey", mode: "architect" });
    const shared = await launch({ title: "Shared edit", mode: "default", worktree: false });
    for (const result of [architect, shared]) await chat.get(idOf(result.output)).settled();
    expect(chat.get(idOf(architect.output)).summary().worktree).toBeUndefined();
    expect(chat.get(idOf(shared.output)).summary().worktree).toBeUndefined();
    expect(shared.output).toContain("shared project folder");
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe(`by ${idOf(shared.output)}\n`);
  }, 60000);

  test("without a Git repository an editing session falls back to the project folder", async () => {
    const { chat, launch } = await setup(false);
    const result = await launch({ title: "Edit", mode: "default" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("not a Git repository; it works in the shared project folder");
    expect(chat.get(idOf(result.output)).summary().worktree).toBeUndefined();
  }, 60000);
});
