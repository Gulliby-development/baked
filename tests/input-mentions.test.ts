import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { expandChatInput, parseChatInput } from "../src/core/chat/input-expansion.js";
import { clearMentionCache, mentionAtCursor, suggestMentions } from "../src/core/chat/mention-suggest.js";
import {
  type ChatAgentHost,
  ChatService,
  type InputExpansionRequest,
  type TurnAgentRequest,
} from "../src/core/chat/sessions.js";
import type { IntelligenceClient } from "../src/core/workers/intelligence-client.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const roots: string[] = [];
afterEach(async () => {
  clearMentionCache();
  for (const root of roots.splice(0)) await removeTempDir(root);
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "baked-mentions-"));
  roots.push(root);
  mkdirSync(join(root, "src", "auth"), { recursive: true });
  writeFileSync(join(root, "src", "auth", "service.ts"), "export class AuthService {\n  login() {\n    return true;\n  }\n}\n");
  writeFileSync(join(root, "README.md"), "line one\nline two\nline three\n");
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  return root;
}

/** A repository graph that knows one method, `AuthService.login`, called from one place. */
function fakeGraph(): IntelligenceClient {
  const graph = {
    isReady: true,
    findSymbolDefinitions: async (query: string) =>
      query === "AuthService.login" || query === "login"
        ? [{ name: "login", qualifiedName: "AuthService.login", kind: "method", path: "src/auth/service.ts", line: 2, endLine: 4 }]
        : [],
    getSymbolReferences: async () => ({
      calls: [{ path: "src/api.ts", line: 12, caller: "handleLogin" }],
      importers: [],
    }),
    searchSymbolsFts: async (query: string) =>
      "AuthService".startsWith(query.replace("*", ""))
        ? [{ name: "AuthService", path: "src/auth/service.ts", kind: "class", line: 1, isExported: true, pagerank: 1 }]
        : [],
    getClassMembers: async () => [],
  };
  return graph as unknown as IntelligenceClient;
}

describe("parseChatInput", () => {
  test("finds mentions, line ranges and quoted paths", () => {
    const parsed = parseChatInput('Explain @src/a.ts#10-20, then @"docs/my file.md" and @Foo.bar.');
    expect(parsed.command).toBeNull();
    expect(parsed.mentions.map((m) => m.target)).toEqual(["src/a.ts", "docs/my file.md", "Foo.bar"]);
    expect(parsed.mentions[0]?.lines).toEqual({ start: 10, end: 20 });
  });

  test("ignores e-mail addresses and code spans", () => {
    const parsed = parseChatInput("Mail me@example.com about `@decorator` and\n```\n@inside\n```");
    expect(parsed.mentions).toEqual([]);
  });

  test("a leading ! is a command; following lines are the prompt", () => {
    const parsed = parseChatInput("!git log -5\nwhat changed in @README.md?");
    expect(parsed.command).toBe("git log -5");
    expect(parsed.prompt).toBe("what changed in @README.md?");
    expect(parsed.mentions.map((m) => m.target)).toEqual(["README.md"]);
  });

  test("@ inside the command is shell text", () => {
    expect(parseChatInput("!npm view @types/node version").mentions).toEqual([]);
  });
});

describe("expandChatInput", () => {
  test("attaches a file, a line range and a directory", async () => {
    const cwd = workspace();
    const out = await expandChatInput("Look at @README.md#2-3 and @src/auth/", { cwd, mode: "default" });
    expect(out.send).toBe(true);
    expect(out.text.startsWith("Look at @README.md#2-3 and @src/auth/")).toBe(true);
    expect(out.text).toContain('<file path="README.md" lines="2-3">\nline two\nline three\n</file>');
    expect(out.text).toContain('<directory path="src/auth">\nservice.ts\n</directory>');
    expect(out.items.map((i) => [i.kind, i.ok])).toEqual([
      ["file", true],
      ["directory", true],
    ]);
    expect(out.files).toEqual([join(cwd, "README.md")]);
  });

  test("leaves unknown mentions as text and refuses forbidden or outside paths", async () => {
    const cwd = workspace();
    const out = await expandChatInput("ping @nobody, read @.env and @../../etc/hosts", { cwd, mode: "default" });
    const byRef = Object.fromEntries(out.items.map((i) => [i.ref, i]));
    expect(byRef.nobody?.ok).toBe(false);
    expect(byRef[".env"]?.ok).toBe(false);
    expect(out.text).not.toContain("SECRET");
    expect(out.text).not.toContain("@nobody (");
    expect(out.text).toContain("Not attached: @.env");
    expect(byRef["../../etc/hosts"]?.ok).toBe(false);
  });

  test("attaches a symbol definition with its references", async () => {
    const cwd = workspace();
    const out = await expandChatInput("Why does @AuthService.login return true?", {
      cwd,
      mode: "default",
      repoMap: fakeGraph(),
    });
    expect(out.items[0]).toMatchObject({ kind: "symbol", ok: true });
    expect(out.text).toContain('<symbol name="AuthService.login" kind="method" path="src/auth/service.ts" lines="2-4">');
    expect(out.text).toContain("  login() {\n    return true;\n  }");
    expect(out.text).toContain("src/api.ts:12 in handleLogin");
  });

  test("runs a command and attaches its output", async () => {
    const cwd = workspace();
    const out = await expandChatInput("!echo mention-test", { cwd, mode: "default" });
    expect(out.send).toBe(true);
    expect(out.items[0]).toMatchObject({ kind: "command", ref: "echo mention-test", ok: true });
    expect(out.items[0]?.output).toContain("mention-test");
    expect(out.text).toContain('<command cmd="echo mention-test" status="ok">');
  });

  test("destructive commands follow the shell approval rules", async () => {
    const cwd = workspace();
    const denied = await expandChatInput("!rm -rf src", { cwd, mode: "default" });
    expect(denied.send).toBe(false);
    expect(denied.items[0]?.ok).toBe(false);

    const asked: string[] = [];
    const refused = await expandChatInput("!rm -rf src\nthen explain", {
      cwd,
      mode: "default",
      onApproveDestructive: async (description) => {
        asked.push(description);
        return false;
      },
    });
    expect(asked).toHaveLength(1);
    expect(refused.send).toBe(true);
    expect(refused.text).toContain("Not attached: !rm -rf src");
  });

  test("commands do not run in plan or architect mode", async () => {
    const cwd = workspace();
    const out = await expandChatInput("!echo nope", { cwd, mode: "architect" });
    expect(out.send).toBe(false);
    expect(out.items[0]?.summary).toBe("shell is disabled in architect mode");
  });
});

describe("mention completion", () => {
  test("finds the @ token at the cursor", () => {
    expect(mentionAtCursor("see @src/au")).toEqual({ query: "src/au", start: 4 });
    expect(mentionAtCursor("mail me@x")).toBeNull();
    expect(mentionAtCursor("!npm i @ty")).toBeNull();
    expect(mentionAtCursor("plain text")).toBeNull();
  });

  test("suggests files, directories and symbols", async () => {
    const cwd = workspace();
    const files = await suggestMentions("service", { cwd });
    expect(files[0]).toMatchObject({ kind: "file", insert: "src/auth/service.ts" });
    expect((await suggestMentions("src/a", { cwd })).some((s) => s.kind === "directory")).toBe(true);
    expect((await suggestMentions("", { cwd })).some((s) => s.insert === ".env")).toBe(false);
    const symbols = await suggestMentions("Auth", { cwd, repoMap: fakeGraph() });
    expect(symbols[0]).toMatchObject({ kind: "symbol", insert: "AuthService" });
  });
});

/** Records the messages each turn sends to the model and expands input like the API host. */
class ExpandingHost implements ChatAgentHost {
  seen: ModelMessage[][] = [];
  expanded: InputExpansionRequest[] = [];
  async agent(_request: TurnAgentRequest) {
    return {
      contextWindow: 1000,
      agent: {
        stream: async (args: { messages: ModelMessage[] }) => {
          this.seen.push(args.messages);
          return {
            stream: (async function* () {
              yield { type: "text-delta", text: "ok" };
            })(),
            responseMessages: Promise.resolve([]),
          };
        },
      },
    };
  }
  async expandInput(request: InputExpansionRequest) {
    this.expanded.push(request);
    return expandChatInput(request.text, {
      cwd: this.cwd,
      mode: request.mode,
      onApproveDestructive: request.onApproveDestructive,
    });
  }
  constructor(private readonly cwd: string) {}
  release() {}
  async dispose() {}
}

describe("chat sessions", () => {
  test("send the expansion to the model and show the message as typed", async () => {
    const cwd = workspace();
    const host = new ExpandingHost(cwd);
    const chat = new ChatService({
      workspace: cwd,
      config: { ...DEFAULT_CONFIG, defaultModel: "openai/gpt-test" },
      host,
    });
    const session = await chat.create({});
    session.send("Summarize @README.md");
    await session.settled();
    const user = session.detail().messages[0];
    expect(user?.content).toBe("Summarize @README.md");
    expect(user?.inputContext?.[0]).toMatchObject({ kind: "file", ref: "README.md", ok: true });
    const sent = host.seen[0]?.at(-1);
    expect(String(sent?.content)).toContain("<file path=\"README.md\"");
    await chat.shutdown();
  });

  test("a denied command alone starts no model turn", async () => {
    const cwd = workspace();
    const host = new ExpandingHost(cwd);
    const chat = new ChatService({
      workspace: cwd,
      config: { ...DEFAULT_CONFIG, defaultModel: "openai/gpt-test" },
      host,
    });
    const session = await chat.create({ mode: "architect" });
    session.send("!echo hi");
    await session.settled();
    expect(host.seen).toHaveLength(0);
    expect(session.detail().messages[0]?.inputContext?.[0]?.ok).toBe(false);
    await chat.shutdown();
  });
});
