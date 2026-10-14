import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { ChatService, type ChatSession } from "../src/core/chat/sessions.js";
import type { LspServiceDeps } from "../src/core/intelligence/lsp-service.js";
import { MemoryManager } from "../src/core/memory/manager.js";
import { createSetupTool, SETUP_TOOL, type SetupArgs } from "../src/core/tools/baked-setup.js";
import { RESTRICTED_TOOL_ACTIONS, TOOL_CATALOG } from "../src/core/tools/constants.js";
import { buildTools } from "../src/core/tools/index.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { AppConfig } from "../src/types/index.js";
import { writePackage } from "./helpers/package-fixture.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => removeTempDir(dir));
  return dir;
}

/** A project whose workflow policy has a check, so presets with a checks stage are valid. */
const CONFIG = {
  ...DEFAULT_CONFIG,
  workflows: {
    policy: {
      ...defaultWorkflowPolicy,
      checks: [
        { id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] },
      ],
    },
  },
} as unknown as AppConfig;

type Result = { success: boolean; output: string; error?: string };

/** A setup tool over a fresh workspace whose approvals answer `answer` and are recorded. */
function setup(answer: boolean | null = true, extra: Partial<Parameters<typeof createSetupTool>[0]> = {}) {
  const workspace = temp("baked-setup-ws-");
  const home = temp("baked-setup-home-");
  const asked: string[] = [];
  const tool = createSetupTool({
    cwd: workspace,
    homeDir: home,
    configDir: join(home, ".baked"),
    config: () => CONFIG,
    ...(answer === null
      ? {}
      : {
          approve: async (text: string) => {
            asked.push(text);
            return answer;
          },
        }),
    ...extra,
  });
  const run = async (args: Partial<SetupArgs> & Pick<SetupArgs, "area" | "action">): Promise<Result> =>
    (await (tool as unknown as { execute: (a: SetupArgs) => Promise<Result> }).execute(args as SetupArgs));
  return { workspace, home, asked, run };
}

describe("baked_setup workflows", () => {
  test("creates a workflow from a built-in one after approval, then shows, edits and removes it", async () => {
    const { workspace, asked, run } = setup();
    const created = await run({
      area: "workflow",
      action: "create",
      from: "quick",
      name: "site-fix",
      description: "Fix a site issue",
    });
    expect(created.success).toBe(true);
    const file = join(workspace, "baked", "workflows", "site-fix.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ id: "site-fix", description: "Fix a site issue" });
    expect(asked[0]).toContain("Create workflow site-fix");

    const listed = await run({ area: "workflow", action: "list" });
    expect(listed.output).toContain("site-fix (project");
    const shown = await run({ area: "workflow", action: "show", name: "site-fix" });
    expect(shown.output).toContain("Workflow site-fix: Fix a site issue");
    expect(shown.output).toContain("Transitions:");

    const edited = await run({ area: "workflow", action: "edit", name: "site-fix", description: "Fix any site issue" });
    expect(edited.success).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).description).toBe("Fix any site issue");

    expect((await run({ area: "workflow", action: "remove", name: "site-fix" })).success).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(asked).toHaveLength(3);
  });

  test("a built-in workflow is read only and cannot be removed", async () => {
    const { run } = setup();
    const edit = await run({ area: "workflow", action: "edit", name: "quick", description: "x" });
    expect(edit.success).toBe(false);
    expect(edit.output).toContain('create with from: "quick"');
    expect((await run({ area: "workflow", action: "remove", name: "quick" })).success).toBe(false);
  });

  test("an editor operation that fails writes nothing", async () => {
    const { workspace, asked, run } = setup();
    const result = await run({
      area: "workflow",
      action: "create",
      from: "quick",
      name: "broken",
      ops: [{ op: "removeStage", stageId: "no-such-stage" }],
    });
    expect(result.success).toBe(false);
    expect(asked).toHaveLength(0);
    expect(existsSync(join(workspace, "baked", "workflows", "broken.json"))).toBe(false);
  });
});

describe("baked_setup approvals", () => {
  test("a declined change writes nothing", async () => {
    const { workspace, asked, run } = setup(false);
    const result = await run({ area: "agent_context", action: "write", name: "AGENTS.md", content: "# Rules\n" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("declined");
    expect(asked).toHaveLength(1);
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(false);
  });

  test("without a way to ask, changes are refused and reading still works", async () => {
    const { workspace, run } = setup(null);
    const write = await run({ area: "agent_context", action: "write", content: "# Rules\n" });
    expect(write.success).toBe(false);
    expect(write.output).toContain("needs a person to approve");
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(false);
    expect((await run({ area: "workflow", action: "list" })).success).toBe(true);
  });

  test("an action the area does not take is refused with the list", async () => {
    const { run } = setup();
    const result = await run({ area: "hook", action: "edit" });
    expect(result.success).toBe(false);
    expect(result.output).toBe("hook takes the actions list, add, remove");
  });
});

describe("baked_setup areas", () => {
  test("agent context: writes AGENTS.md and reads it back", async () => {
    const { workspace, asked, run } = setup();
    expect((await run({ area: "agent_context", action: "write", content: "# Rules\nUse bun." })).success).toBe(true);
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toBe("# Rules\nUse bun.\n");
    expect(asked[0]).toContain("Create the agent context file AGENTS.md");
    expect((await run({ area: "agent_context", action: "list" })).output).toContain("AGENTS.md (project");
    expect((await run({ area: "agent_context", action: "show", name: "AGENTS.md" })).output).toContain("Use bun.");
    expect((await run({ area: "agent_context", action: "write", name: "notes.txt", content: "x" })).success).toBe(false);
  });

  test("memory: pins, hides and shares chat memory", async () => {
    const workspace = temp("baked-setup-mem-");
    const manager = new MemoryManager(workspace, temp("baked-setup-mem-global-"));
    cleanups.push(() => manager.close());
    const record = manager.write("project", { summary: "Use bun", details: "", category: "pref", source: "user" }).record;
    const { run } = setup(true, { cwd: workspace, memory: () => manager });
    expect((await run({ area: "memory", action: "list" })).output).toContain("Use bun");
    expect((await run({ area: "memory", action: "pin", name: record.id.slice(0, 8) })).success).toBe(true);
    expect(manager.read("project", record.id)?.pinned).toBeTruthy();
    expect((await run({ area: "memory", action: "edit", name: record.id, content: "Use bun, never npm" })).success).toBe(true);
    expect(manager.read("project", record.id)?.summary).toBe("Use bun, never npm");
    expect((await run({ area: "memory", action: "share_with_runs", enabled: true })).success).toBe(true);
    expect(manager.scopeConfig.shareWithRuns).toBe(true);
    expect((await run({ area: "memory", action: "hide", name: "zzzz" })).output).toContain("No memory zzzz");
  });

  test("skills: creates, lists, shows and removes a project skill", async () => {
    const { workspace, run } = setup();
    const created = await run({
      area: "skill",
      action: "create",
      name: "release-notes",
      description: "Write release notes",
      content: "# Release notes\nGroup by feature.",
    });
    expect(created.success).toBe(true);
    const file = join(workspace, ".baked", "skills", "release-notes", "SKILL.md");
    expect(readFileSync(file, "utf8")).toStartWith("---\nname: release-notes\ndescription: Write release notes\n---");
    expect((await run({ area: "skill", action: "list" })).output).toContain("release-notes (project)");
    expect((await run({ area: "skill", action: "show", name: "release-notes" })).output).toContain("Group by feature.");
    expect((await run({ area: "skill", action: "create", name: "Bad Name", description: "x", content: "x" })).success).toBe(false);
    expect((await run({ area: "skill", action: "remove", name: "release-notes" })).success).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  test("hooks: adds a project hook, lists it and removes it", async () => {
    const { workspace, asked, run } = setup();
    const added = await run({ area: "hook", action: "add", event: "PostToolUse", matcher: "edit_file", command: "bun run lint" });
    expect(added.success).toBe(true);
    expect(asked[0]).toContain("bun run lint");
    const config = JSON.parse(readFileSync(join(workspace, ".baked", "config.json"), "utf8"));
    expect(config.hooks.PostToolUse[0]).toMatchObject({ matcher: "edit_file", hooks: [{ command: "bun run lint" }] });
    const listed = await run({ area: "hook", action: "list" });
    expect(listed.output).toContain("project:PostToolUse:0:0 PostToolUse [edit_file]: bun run lint");
    expect((await run({ area: "hook", action: "remove", name: "project:PostToolUse:0:0" })).success).toBe(true);
    expect((await run({ area: "hook", action: "list" })).output).toBe("No hooks.");
  });

  test("mcp: adds, disables and removes a server and reports the effective list", async () => {
    const changes: string[][] = [];
    const { workspace, run } = setup(true, { onMcpChange: (servers) => changes.push(servers.map((s) => s.name)) });
    const added = await run({ area: "mcp", action: "add", name: "docs", server: { command: "docs-mcp", args: ["--stdio"] } });
    expect(added.success).toBe(true);
    const file = join(workspace, ".baked", "config.json");
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers).toEqual([{ name: "docs", command: "docs-mcp", args: ["--stdio"] }]);
    expect((await run({ area: "mcp", action: "list" })).output).toContain("docs (project, stdio) docs-mcp --stdio");
    expect((await run({ area: "mcp", action: "disable", name: "docs" })).success).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers[0].disabled).toBe(true);
    // An invalid server is refused before anyone is asked.
    const invalid = await run({ area: "mcp", action: "add", name: "web", server: { transport: "http" } });
    expect(invalid.success).toBe(false);
    expect((await run({ area: "mcp", action: "remove", name: "docs" })).success).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers).toBeUndefined();
    expect(changes).toEqual([["docs"], ["docs"], []]);
  });

  test("lsp: disables and enables a language server in the project config", async () => {
    const deps: Partial<LspServiceDeps> = {
      candidates: () => [{ command: "gopls", args: ["serve"], languages: ["go"] }],
      resolve: () => ({ path: "/usr/bin/gopls", source: "PATH" }),
      registry: () => [],
      detectLanguages: async () => ["go"],
      started: () => false,
      refresh: () => {},
    };
    const { workspace, run } = setup(true, { lsp: { deps } });
    mkdirSync(join(workspace, ".baked"), { recursive: true });
    writeFileSync(join(workspace, ".baked", "config.json"), JSON.stringify({ disabledLspServers: [] }));
    expect((await run({ area: "lsp", action: "list" })).output).toContain("- gopls (go): installed");
    expect((await run({ area: "lsp", action: "disable", name: "gopls" })).success).toBe(true);
    expect(JSON.parse(readFileSync(join(workspace, ".baked", "config.json"), "utf8")).disabledLspServers).toEqual(["gopls"]);
    expect((await run({ area: "lsp", action: "enable", name: "gopls" })).success).toBe(true);
    expect(JSON.parse(readFileSync(join(workspace, ".baked", "config.json"), "utf8")).disabledLspServers).toEqual([]);
  });

  test("packages: inspects, installs and removes a package", async () => {
    const source = writePackage();
    cleanups.push(() => removeTempDir(source));
    const { workspace, asked, run } = setup();
    expect((await run({ area: "package", action: "inspect", path: source })).success).toBe(true);
    const installed = await run({ area: "package", action: "install", path: source });
    expect(installed.success).toBe(true);
    expect(asked[0]).toContain("Install package");
    expect(existsSync(join(workspace, "baked", "workflows", "pkg-quick.json"))).toBe(true);
    const listed = await run({ area: "package", action: "list" });
    expect(listed.success).toBe(true);
    const name = JSON.parse(readFileSync(join(workspace, "baked", "packages.json"), "utf8")).packages[0].name;
    expect((await run({ area: "package", action: "remove", name })).success).toBe(true);
    expect(existsSync(join(workspace, "baked", "workflows", "pkg-quick.json"))).toBe(false);
  });
});

describe("baked_setup surfaces", () => {
  test("the chat builds it, lists it for request_tools and allows only reading in restricted modes", () => {
    const workspace = temp("baked-setup-chat-");
    const memoryManager = new MemoryManager(workspace, temp("baked-setup-chat-global-"));
    cleanups.push(() => memoryManager.close());
    const tools = buildTools(workspace, undefined, { memoryManager }) as Record<string, unknown>;
    expect(tools[SETUP_TOOL]).toBeDefined();
    expect(TOOL_CATALOG[SETUP_TOOL]).toBeDefined();
    expect(RESTRICTED_TOOL_ACTIONS[SETUP_TOOL]).toEqual(["list", "show", "inspect"]);
  });

  test("the coordinator gets it with approvals on its own cards", async () => {
    const workspace = temp("baked-setup-coord-");
    const chat = new ChatService({
      workspace,
      config: { ...DEFAULT_CONFIG, defaultModel: "openai/gpt-test" },
      host: { agent: async () => Promise.reject(new Error("no model")), release() {}, async dispose() {} },
      homeDir: workspace,
    });
    cleanups.push(() => chat.shutdown());
    const coordinator = (await chat.coordinator(true)) as ChatSession;
    const tool = chat.coordinatorTools(coordinator)[SETUP_TOOL] as {
      execute: (a: SetupArgs) => Promise<Result>;
    };
    expect(tool).toBeDefined();
    const pending = tool.execute({ area: "agent_context", action: "write", content: "# Rules\n" } as SetupArgs);
    await Bun.sleep(10);
    const prompt = coordinator.pendingPrompts.find((p) => p.kind === "destructive");
    expect(prompt).toBeDefined();
    coordinator.answer(prompt?.id ?? "", { approve: true });
    expect((await pending).success).toBe(true);
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toBe("# Rules\n");
  });
});
