import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelMessage } from "ai";
import { type ChatAgentHost, ChatService, type TurnAgentRequest } from "../src/core/chat/sessions.js";
import { parseHeadlessArgs } from "../src/headless/parse.js";
import {
  manualApprovalRequest,
  splitLegacyMode,
  withManualApproval,
} from "../src/core/security/permission-mode.js";

type Result = { success: boolean; output: string; error?: string };

const ran: string[] = [];
const tool = (name: string) => ({
  description: name,
  execute: async (input: unknown): Promise<Result> => {
    ran.push(`${name} ${JSON.stringify(input)}`);
    return { success: true, output: "ok" };
  },
});

describe("manual permission mode", () => {
  // Resolved, so the expected paths carry a drive letter on Windows.
  const cwd = resolve("/work/project");

  test("asks before edits, commands, mutating git and project actions, not before reads", () => {
    expect(manualApprovalRequest("edit_file", { path: "src/a.ts" }, cwd)?.prompt).toBe(
      "Edit `src/a.ts`",
    );
    expect(manualApprovalRequest("shell", { command: "bun test" }, cwd)?.detail).toEqual({
      kind: "shell",
      command: "bun test",
      cwd,
    });
    expect(manualApprovalRequest("git", { action: "commit" }, cwd)?.prompt).toBe("Git: commit");
    expect(manualApprovalRequest("git", { action: "cherry_pick" }, cwd)?.prompt).toBe(
      "Git: cherry pick",
    );
    expect(manualApprovalRequest("project", { action: "run", script: "dev" }, cwd)?.prompt).toBe(
      "Project: run `dev`",
    );
    expect(manualApprovalRequest("rename_symbol", { path: "a.ts" }, cwd)).not.toBeNull();
    for (const [name, input] of [
      ["read", { path: "a.ts" }],
      ["grep", { pattern: "x" }],
      ["git", { action: "diff" }],
      ["project", { action: "list" }],
      ["str_replace_based_edit_tool", { command: "view", path: "a.ts" }],
    ] as const)
      expect(manualApprovalRequest(name, input, cwd)).toBeNull();
  });

  test("leaves calls the auto gates already ask about to them, so nothing asks twice", () => {
    expect(manualApprovalRequest("shell", { command: "rm -rf build" }, cwd)).toBeNull();
    expect(manualApprovalRequest("edit_file", { path: ".env" }, cwd)).toBeNull();
  });

  test("wraps the gated tools: a no denies, a yes runs, other tools run unasked", async () => {
    ran.length = 0;
    const asked: string[] = [];
    let answer = false;
    const tools = withManualApproval(
      { shell: tool("shell"), read: tool("read") },
      async (prompt) => {
        asked.push(prompt);
        return answer;
      },
      cwd,
    );
    const denied = (await tools.shell.execute({ command: "bun test" })) as Result;
    expect(denied.success).toBe(false);
    expect(denied.output).toContain("manual permission mode");
    answer = true;
    expect(((await tools.shell.execute({ command: "bun test" })) as Result).success).toBe(true);
    await tools.read.execute({ path: "a.ts" });
    expect(asked).toEqual(["Shell: run a command\n\n`bun test`", "Shell: run a command\n\n`bun test`"]);
    expect(ran).toEqual([`shell {"command":"bun test"}`, `read {"path":"a.ts"}`]);
  });

  test("without anyone to ask, every gated call is refused", async () => {
    const tools = withManualApproval({ edit_file: tool("edit_file") }, undefined, cwd);
    expect(((await tools.edit_file.execute({ path: "a.ts" })) as Result).success).toBe(false);
  });
});

describe("permission mode of a chat", () => {
  test("the legacy auto mode is the default mode with full access", () => {
    expect(splitLegacyMode("auto", "manual")).toEqual({ mode: "default", permissions: "full" });
    expect(splitLegacyMode("plan", undefined)).toEqual({ mode: "plan", permissions: "auto" });
  });

  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  class RecordingHost implements ChatAgentHost {
    requests: TurnAgentRequest[] = [];
    async agent(request: TurnAgentRequest) {
      this.requests.push(request);
      return {
        contextWindow: 1000,
        agent: {
          stream: async (_args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => ({
            stream: (async function* () {
              yield { type: "text-delta", text: "done" };
            })(),
            responseMessages: Promise.resolve([]),
          }),
        },
      };
    }
    release() {}
    async dispose() {}
  }

  function service(host: ChatAgentHost, defaultPermissionMode: "manual" | "auto" | "full") {
    const dir = mkdtempSync(join(tmpdir(), "baked-permissions-"));
    dirs.push(dir);
    return new ChatService({
      workspace: dir,
      config: { defaultModel: "openai/gpt-test", ...(defaultPermissionMode ? { defaultPermissionMode } : {}) },
      host,
      homeDir: dir,
    });
  }

  test("is saved with the session, reaches the turn, and survives a reload", async () => {
    const host = new RecordingHost();
    const chat = service(host, "manual");
    const session = await chat.create({ title: "t" });
    expect(session.summary().permissions).toBe("manual");
    session.update({ mode: "auto" });
    expect(session.summary()).toMatchObject({ mode: "default", permissions: "full" });
    session.update({ permissions: "auto" });
    session.send("hello");
    await session.settled();
    expect(host.requests.at(-1)?.permissions).toBe("auto");
    await chat.persist(session);
    // A second service over the same folder reads the saved session.
    const reloaded = new ChatService({
      workspace: chat.workspace,
      config: { defaultModel: "openai/gpt-test" },
      host,
      homeDir: chat.workspace,
    });
    expect(reloaded.get(session.id).summary()).toMatchObject({ mode: "default", permissions: "auto" });
  });

  test("headless takes --permissions for a run", async () => {
    const action = await parseHeadlessArgs(["--headless", "--permissions", "manual", "fix it"]);
    expect(action).toMatchObject({ type: "run", opts: { permissions: "manual" } });
  });
});
