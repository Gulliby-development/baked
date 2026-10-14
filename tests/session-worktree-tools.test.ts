import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BAKED_NO_REPOMAP = "1";

import { createBakeAgent } from "../src/core/agents/bake.js";
import { ContextManager } from "../src/core/context/manager.js";
import { getCwd } from "../src/core/cwd.js";
import { scopeToolArgs } from "../src/core/tools/cwd-scope.js";
import { removeTempDir } from "./helpers/temp-dir.js";

/**
 * #1135: a chat session in its own worktree runs the real tools. Its edits, commands and reads
 * must happen in the worktree, never in the process's workspace (the project inside `baked serve`).
 */
type Result = { success: boolean; output: string; error?: string };
type Tools = Record<string, { execute: (args: unknown, options: unknown) => Promise<Result> }>;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function worktree(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "baked-worktree-tools-")));
  cleanups.push(() => removeTempDir(dir));
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "math.ts"), "export const one = 1;\n");
  return dir;
}

function agentTools(cwd: string): Tools {
  const context = new ContextManager(cwd);
  cleanups.push(() => context.dispose());
  const agent = createBakeAgent({
    // biome-ignore lint/suspicious/noExplicitAny: minimal model stub for agent construction
    model: { modelId: "anthropic/claude-sonnet-4-6", doGenerate: async () => ({}) } as any,
    contextManager: context,
    cwd,
    permissionMode: "full",
  }) as unknown as { tools: Tools };
  return agent.tools;
}

const call = (tools: Tools, name: string, args: unknown) => {
  const tool = tools[name];
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.execute(args, { toolCallId: name, messages: [] });
};

describe("tools of an agent in its own worktree", () => {
  test("edit, read, list, search and shell work in the worktree, not the process directory", async () => {
    const dir = worktree();
    expect(getCwd()).not.toBe(dir);
    const tools = agentTools(dir);

    const edit = await call(tools, "edit_file", { path: "docs/add.md", oldString: "", newString: "# add\n" });
    expect(edit.success).toBe(true);
    expect(readFileSync(join(dir, "docs", "add.md"), "utf8")).toBe("# add\n");
    expect(existsSync(join(getCwd(), "docs", "add.md"))).toBe(false);

    const read = await call(tools, "read", { files: [{ path: "src/math.ts" }] });
    expect(read.output).toContain("export const one = 1;");

    const list = await call(tools, "list_dir", {});
    expect(list.output).toContain("src/");
    expect(list.output).toContain("docs/");

    const grep = await call(tools, "grep", { pattern: "const one" });
    expect(grep.output).toContain("math.ts");

    const shell = await call(tools, "shell", { command: "pwd", description: "Print the directory" });
    expect(shell.output.trim()).toContain(dir);
  });

  test("relative paths become absolute under the worktree; others stay as they are", () => {
    const dir = "/work/tree";
    expect(scopeToolArgs("edit_file", { path: "a.md", newString: "x" }, dir)).toEqual({
      path: "/work/tree/a.md",
      newString: "x",
    });
    expect(scopeToolArgs("read", { files: '[{"path":"a.ts"}]' }, dir)).toEqual({
      files: [{ path: "/work/tree/a.ts" }],
    });
    expect(scopeToolArgs("read", { files: ["a.ts", "/abs/b.ts"] }, dir)).toEqual({
      files: ["/work/tree/a.ts", "/abs/b.ts"],
    });
    expect(scopeToolArgs("grep", { pattern: "x" }, dir)).toEqual({ pattern: "x", path: dir });
    expect(scopeToolArgs("shell", { command: "ls", cwd: "src" }, dir)).toEqual({
      command: "ls",
      cwd: "/work/tree/src",
    });
    expect(scopeToolArgs("bake_vision", { path: "https://example.com/a.png" }, dir)).toEqual({
      path: "https://example.com/a.png",
    });
    expect(scopeToolArgs("baked_setup", { from: "spec", to: "plan" }, dir)).toEqual({ from: "spec", to: "plan" });
  });
});
