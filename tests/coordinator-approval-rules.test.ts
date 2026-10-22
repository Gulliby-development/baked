import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { launchedHeading, messageLines } from "../src/components/coordinator/model.js";
import { startApiServer } from "../src/core/api/server.js";
import { coordinatorId, runRulesCommand } from "../src/core/chat/approval-rules-command.js";
import {
  type ApprovalRule,
  ApprovalRulesStore,
  matchPrompt,
  matchRunApproval,
  personOnly,
  ruleText,
} from "../src/core/chat/approval-rules.js";
import { BriefStore } from "../src/core/chat/coordinator.js";
import { ScriptedChatHost } from "../src/core/chat/scripted-host.js";
import {
  type ChatAgentHost,
  type ChatPrompt,
  ChatService,
  type ChatSession,
  type TurnAgentRequest,
} from "../src/core/chat/sessions.js";
import { getCwd, setCwd } from "../src/core/cwd.js";
import { runSessionCli } from "../src/headless/session.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const prompt = (body: Omit<ChatPrompt, "id" | "createdAt">): ChatPrompt =>
  ({ ...body, id: "p", createdAt: 0 }) as ChatPrompt;

const rules: ApprovalRule[] = [
  { id: "search", kind: "web-search" },
  { id: "docs", kind: "fetch-page", hosts: ["github.com", "bun.sh"] },
  { id: "small-plans", kind: "plan-review", maxSteps: 3 },
  { id: "small-runs", kind: "run-approval", maxTokens: 2_000_000, paths: ["src/**", "tests/**"] },
];

const plan = (title: string, steps: number, content = "Edit src/a.ts") =>
  prompt({
    kind: "plan-review",
    title,
    depth: "standard" as never,
    steps: Array.from({ length: steps }, (_, i) => ({ id: `s${i}`, label: `Step ${i}` })),
    planFile: "plan.md",
    content,
  });

describe("matching approvals to rules", () => {
  test("session prompts: listed hosts over https, small plans, never destructive or outside", () => {
    expect(matchPrompt(rules, prompt({ kind: "web-search", query: "bun wal" }))?.id).toBe("search");
    expect(matchPrompt(rules, prompt({ kind: "fetch-page", url: "https://docs.github.com/x" }))?.id).toBe("docs");
    expect(matchPrompt(rules, prompt({ kind: "fetch-page", url: "https://bun.sh" }))?.id).toBe("docs");
    for (const url of [
      "http://github.com/x",
      "https://github.com.evil.io/x",
      "https://notgithub.com/",
      "https://user:pw@github.com/",
      "https://github.com:8443/",
      "not a url",
    ])
      expect(matchPrompt(rules, prompt({ kind: "fetch-page", url }))).toBeNull();
    expect(matchPrompt(rules, plan("Rename a helper", 3))?.id).toBe("small-plans");
    expect(matchPrompt(rules, plan("Rename a helper", 4))).toBeNull();
    expect(matchPrompt(rules, plan("Deploy the site", 1))).toBeNull();
    expect(matchPrompt(rules, plan("Tidy", 1, "Read the API key from .env"))).toBeNull();
    expect(matchPrompt(rules, prompt({ kind: "destructive", description: "rm -rf build" }))).toBeNull();
    expect(matchPrompt(rules, prompt({ kind: "outside-cwd", tool: "read", path: "/etc" }))).toBeNull();
    expect(
      matchPrompt(rules, prompt({ kind: "question", question: "Which?", allowSkip: true, options: [] })),
    ).toBeNull();
    expect(matchPrompt([], prompt({ kind: "web-search", query: "x" }))).toBeNull();
  });

  test("run plans: under the budget and inside the paths, never secrets, CI, deletes or user changes", () => {
    const body = (over: Record<string, unknown> = {}) => ({
      writes: [
        { path: "src/a.ts", action: "modify" },
        { path: "tests/a.test.ts", action: "create" },
      ],
      policy: { maxTotalTokens: 1_500_000 },
      ...over,
    });
    expect(matchRunApproval(rules, body())?.id).toBe("small-runs");
    expect(matchRunApproval(rules, body({ policy: { maxTotalTokens: 3_000_000 } }))).toBeNull();
    expect(matchRunApproval(rules, body({ writes: [{ path: "docs/a.md", action: "modify" }] }))).toBeNull();
    for (const path of [".env", "src/.env.local", ".github/workflows/ci.yml", "package.json", "src/key.pem"])
      expect(personOnly(body({ writes: [{ path, action: "modify" }] }))).toEqual([
        `${path} always needs a person`,
      ]);
    expect(personOnly(body({ writes: [{ path: "src/a.ts", action: "delete" }] }))).toEqual([
      "src/a.ts would be deleted",
    ]);
    expect(personOnly(body({ worktree: { userChangesInScope: ["src/a.ts"] } }))).toEqual([
      "it writes files with uncommitted changes",
    ]);
    expect(personOnly(body({ deferredCriteria: ["AC-2"] }))).toEqual(["it defers post-release criteria"]);
    expect(personOnly({ testsFirst: {}, writes: [], policy: { maxTotalTokens: 1 } })).toEqual([
      "tests written first are reviewed by a person",
    ]);
    expect(personOnly({ writes: [] })).toEqual(["its budget is unknown"]);
    const anywhere: ApprovalRule[] = [{ id: "any", kind: "run-approval", maxTokens: 2_000_000 }];
    expect(matchRunApproval(anywhere, body({ writes: [{ path: "docs/a.md", action: "modify" }] }))?.id).toBe("any");
  });

  test("rules read as one line each", () => {
    expect(rules.map(ruleText)).toEqual([
      "Approve web searches of launched sessions",
      "Approve fetching pages from github.com, bun.sh",
      "Approve plans of up to 3 steps",
      "Approve run plans with a budget up to 2M tokens that write only src/**, tests/**",
    ]);
  });
});

describe("the rules store", () => {
  test("off by default, saved by revision, validated, and keeps a bounded log", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-rules-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const store = new ApprovalRulesStore(root, "coord");
    expect(store.read()).toMatchObject({ revision: 0, enabled: false, rules: [], log: [] });
    const saved = store.write({ enabled: true, rules }, 0);
    expect(saved.revision).toBe(1);
    expect(() => store.write({ enabled: false, rules: [] }, 0)).toThrow(/revision 1, not 0/);
    expect(() =>
      store.write({ enabled: true, rules: [rules[0] as ApprovalRule, rules[0] as ApprovalRule] }, 1),
    ).toThrow(/Rule ids repeat/);
    expect(() =>
      store.write({ enabled: true, rules: [{ id: "x", kind: "fetch-page", hosts: ["not a host"] }] }, 1),
    ).toThrow(/host/);
    const entry = { at: 1, ruleId: "search", rule: "r", kind: "session" as const, id: "s", what: "w" };
    store.record(Array.from({ length: 120 }, (_, i) => ({ ...entry, at: i })));
    const read = store.read();
    expect(read.revision).toBe(1);
    expect(read.log).toHaveLength(100);
    expect(read.log[0]?.at).toBe(20);
  });
});

/** Waits until `check` holds, checking the coordinator's launched work in between. */
async function until(chat: ChatService, check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await chat.syncLaunched();
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("the coordinator answers by rules (scripted scenario)", () => {
  test("a launched session's web search is approved by a rule; other prompts wait for a person", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-rules-chat-"));
    const host = new ScriptedChatHost({
      delayMs: 1,
      turns: [
        {
          steps: [
            { tool: "web_search", input: { query: "bun wal" }, approval: { webSearch: "bun wal" } },
            { ifApproved: "searched." },
            {
              tool: "fetch_page",
              input: { url: "https://evil.example.com/x" },
              approval: { fetchPage: "https://evil.example.com/x" },
            },
            { ifDenied: "not fetched." },
            { tool: "bash", input: { command: "rm -rf build" }, approval: { destructive: "rm -rf build" } },
            { ifDenied: "kept build." },
          ],
        },
      ],
    });
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
    const coordinator = (await chat.coordinator(true)) as ChatSession;
    const session = await chat.create({ title: "Research WAL" });
    const briefs = new BriefStore(root, coordinator.id);
    const brief = briefs.read();
    briefs.write(
      { ...brief, launched: [{ kind: "session", id: session.id, title: "Research WAL", why: "Find WAL docs", status: "working" }] },
      brief.revision,
    );
    const store = new ApprovalRulesStore(root, coordinator.id);
    store.write({ enabled: false, rules }, 0);

    session.send("go");
    const pending = (kind: ChatPrompt["kind"]) => session.pendingPrompts.find((p) => p.kind === kind);
    await until(chat, () => !!pending("web-search"), "the web search prompt");
    // Off by default: the rules exist but are not on, so the prompt waits for a person.
    await chat.syncLaunched();
    expect(pending("web-search")).toBeDefined();
    expect(store.read().log).toEqual([]);

    store.write({ enabled: true, rules }, 1);
    await until(chat, () => !!pending("fetch-page"), "the fetch prompt");
    // A host the rules do not list stays with the person, through several checks.
    await chat.syncLaunched();
    await chat.syncLaunched();
    const fetch = pending("fetch-page");
    expect(fetch).toBeDefined();
    session.answer(fetch?.id ?? "", { approve: false });
    await until(chat, () => !!pending("destructive"), "the destructive prompt");
    await chat.syncLaunched();
    const destructive = pending("destructive");
    expect(destructive).toBeDefined();
    session.answer(destructive?.id ?? "", { approve: false });
    await session.settled();

    expect(session.messages.at(-1)?.content).toContain("searched.");
    expect(session.messages.at(-1)?.content).toContain("not fetched.");
    expect(session.messages.at(-1)?.content).toContain("kept build.");
    const log = store.read().log;
    expect(log.map((a) => [a.ruleId, a.kind, a.id, a.what])).toEqual([
      ["search", "session", session.id, 'web search "bun wal"'],
    ]);
    const note = coordinator.messages.find((m) => m.launch?.event === "auto-answered");
    expect(note).toMatchObject({
      content:
        'Approved web search "bun wal" for "Research WAL" by the rule: Approve web searches of launched sessions.',
      launch: {
        kind: "session",
        id: session.id,
        event: "auto-answered",
        answered: 'web search "bun wal"',
        why: "Approve web searches of launched sessions",
      },
    });
    expect(session.messages.some((m) => m.role === "system" && /^The project coordinator approved web search/.test(m.content))).toBe(true);
  });
});

class DoneHost implements ChatAgentHost {
  requests: TurnAgentRequest[] = [];
  async agent(request: TurnAgentRequest) {
    this.requests.push(request);
    return {
      contextWindow: 1000,
      agent: {
        stream: async (_args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "done" };
            yield { type: "finish-step", usage: { inputTokens: 10, outputTokens: 1 } };
          })(),
          responseMessages: Promise.resolve([]),
        }),
      },
    };
  }
  release() {}
  async dispose() {}
}

type Tool = { execute: (input: Record<string, unknown>) => Promise<{ success: boolean; output: string }> };

describe("the coordinator answers a run's plan approval by a rule", () => {
  test("a run over the rule's budget waits; under it, it is approved and completes", async () => {
    const fixture = workflowFixture();
    const host = new DoneHost();
    const chat = new ChatService({
      workspace: fixture.root,
      config: { ...fixture.service.config, defaultModel: "openai/gpt-test" },
      host,
      homeDir: fixture.root,
    });
    const server = await startApiServer({ service: fixture.service, chat, pollMs: 20, log: () => {} });
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
    });
    const coordinator = (await chat.coordinator(true)) as ChatSession;
    coordinator.send("plan");
    await coordinator.settled();
    const startRun = (host.requests.at(-1)?.tools as Record<string, Tool>).start_run as Tool;
    const store = new ApprovalRulesStore(chat.workspace, coordinator.id);
    store.write({ enabled: true, rules: [{ id: "tiny", kind: "run-approval", maxTokens: 1 }] }, 0);

    const starting = startRun.execute({ prompt: "Create ready value", feature: "fixture", why: "Ship" });
    // start_run asks the user first; approve its workflow card.
    await until(chat, () => coordinator.pendingPrompts.some((p) => p.kind === "workflow"), "the workflow card");
    const card = coordinator.pendingPrompts.find((p) => p.kind === "workflow");
    if (card?.kind === "workflow") coordinator.answer(card.id, { approve: true, digest: card.digest });
    const started = await starting;
    expect(started).toMatchObject({ success: true });
    const runId = /run ([0-9a-f-]{36})/.exec(started.output)?.[1] ?? "";
    const status = () => fixture.service.store.run(runId).status;
    await until(chat, () => status() === "waiting", "the run to wait for approval");
    await chat.syncLaunched();
    expect(status()).toBe("waiting");
    expect(store.read().log).toEqual([]);

    store.write({ enabled: true, rules: [{ id: "budget", kind: "run-approval", maxTokens: 1_000_000_000 }] }, 1);
    await until(chat, () => status() === "completed", "the approved run to complete");
    const log = store.read().log;
    expect(log.map((a) => [a.ruleId, a.kind, a.id])).toEqual([["budget", "run", runId]]);
    expect(log[0]?.what).toMatch(/^the plan of run [0-9a-f]{8} \(.+ tokens, 1 files\)$/);
    const approval = fixture.service.store.requests(runId).find((r) => r.kind === "approval");
    expect(approval?.status).toBe("accepted");
    expect(
      coordinator.messages.some((m) => m.launch?.event === "auto-answered" && m.launch.id === runId),
    ).toBe(true);

    const api = await fetch(`${server.url}/v1/coordinator/approval-rules`, {
      headers: { Authorization: `Bearer ${server.token}` },
    });
    expect(await api.json()).toMatchObject({ enabled: true, revision: 2, log: [{ ruleId: "budget" }] });
  }, 60000);
});

describe("the approval rules API", () => {
  test("GET and PUT with the revision; a stale or invalid save is refused", async () => {
    const fixture = workflowFixture();
    const chat = new ChatService({
      workspace: fixture.root,
      config: { ...fixture.service.config, defaultModel: "openai/gpt-test" },
      host: new DoneHost(),
      homeDir: fixture.root,
    });
    const server = await startApiServer({ service: fixture.service, chat, pollMs: 20, log: () => {} });
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
    });
    const call = (method: string, body?: unknown) =>
      fetch(`${server.url}/v1/coordinator/approval-rules`, {
        method,
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    expect((await call("GET")).status).toBe(404);
    await chat.coordinator(true);
    expect(await (await call("GET")).json()).toMatchObject({ revision: 0, enabled: false, rules: [] });
    const saved = await call("PUT", { enabled: true, rules: [{ id: "search", kind: "web-search" }], expectedRevision: 0 });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ revision: 1, enabled: true });
    expect((await call("PUT", { enabled: false, rules: [], expectedRevision: 0 })).status).toBe(409);
    const invalid = await call("PUT", { enabled: true, rules: [{ id: "x", kind: "destructive" }], expectedRevision: 1 });
    expect(invalid.status).toBe(400);
  });
});

describe("rules as text commands (terminal app and CLI)", () => {
  async function project() {
    const root = mkdtempSync(join(tmpdir(), "baked-rules-cli-"));
    const chat = new ChatService({
      workspace: root,
      config: { defaultModel: "openai/gpt-test" } as never,
      host: new DoneHost(),
      homeDir: root,
    });
    cleanups.push(async () => {
      await chat.shutdown();
      await removeTempDir(root);
    });
    return { root, chat };
  }

  async function cli(dir: string, argv: string[]) {
    const previous = getCwd();
    setCwd(dir, { changeProcess: false });
    const out: string[] = [];
    const err: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => out.push(String(chunk)) > 0) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => err.push(String(chunk)) > 0) as typeof process.stderr.write;
    try {
      const code = await runSessionCli(argv);
      return { code, stdout: out.join(""), stderr: err.join("") };
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      setCwd(previous, { changeProcess: false });
    }
  }

  test("show, switch, add and remove rules; mistakes say what to type", async () => {
    const { root, chat } = await project();
    expect(coordinatorId(root)).toBeNull();
    {
      const result = await cli(root, ["coordinator", "rules"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/no coordinator yet/);
    }
    const coordinator = (await chat.coordinator(true)) as ChatSession;
    expect(coordinatorId(root)).toBe(coordinator.id);
    const run = (...args: string[]) => runRulesCommand(root, coordinator.id, args);

    expect(run()).toContain("Approval rules: off (every approval waits for you)\n  No rules yet.");
    expect(run("add", "web-search")).toStartWith("Added web-search.");
    expect(run("add", "pages", "https://docs.github.com/en", "bun.sh")).toContain(
      "fetch-page: Approve fetching pages from docs.github.com, bun.sh",
    );
    expect(run("add", "plans", "3")).toContain("plan-review: Approve plans of up to 3 steps");
    expect(run("add", "runs", "1.5M", "src/**")).toContain(
      "run-approval: Approve run plans with a budget up to 1.5M tokens that write only src/**",
    );
    expect(run("add", "runs", "500k")).toContain("run-approval-2: Approve run plans with a budget up to 500k tokens");
    expect(run("on")).toStartWith("The coordinator now answers matching approvals");
    expect(run("remove", "plan-review")).toStartWith("Removed plan-review.");
    const rules = new ApprovalRulesStore(root, coordinator.id).read();
    expect(rules.enabled).toBe(true);
    expect(rules.rules.map((r) => r.id)).toEqual(["web-search", "fetch-page", "run-approval", "run-approval-2"]);

    expect(() => run("add", "runs", "lots")).toThrow("lots is not a token count such as 2M or 500k");
    expect(() => run("add", "pages", "not a host")).toThrow(/host/);
    expect(() => run("add", "deploys")).toThrow("Unknown rule deploys; use web-search, pages, plans or runs");
    expect(() => run("remove", "nope")).toThrow("No rule nope; the ids are listed by rules");
    expect(() => run("maybe")).toThrow(/Unknown rules command maybe/);

    const shown = await cli(root, ["coordinator", "rules"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toStartWith("Approval rules: on\n  web-search: Approve web searches of launched sessions");
    expect(shown.stdout).toContain("always wait for you");
    {
      const result = await cli(root, ["coordinator", "rules", "off"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/every approval waits for you/);
    }
    {
      const result = await cli(root, ["coordinator", "rules", "add"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/Unknown rule/);
    }
  });

  test("the terminal app shows an answer by rule and the rules that are on", () => {
    const lines = messageLines(
      [
        {
          id: "n",
          role: "system",
          content: "Approved …",
          timestamp: 0,
          showInChat: true,
          launch: {
            kind: "session",
            id: "s",
            title: "Research WAL",
            status: "approved by rule",
            why: "Approve web searches of launched sessions",
            event: "auto-answered",
            answered: 'web search "bun wal"',
          },
        },
      ],
      "",
      100,
    );
    expect(lines.slice(0, 2)).toEqual([
      { text: '  ✓ Approved web search "bun wal" for Session "Research WAL"', tone: "accent" },
      { text: "    by your rule: Approve web searches of launched sessions", tone: "muted" },
    ]);
    expect(launchedHeading(0)).toBe("Launched");
    expect(launchedHeading(2)).toBe("Launched · 2 approval rules on (/coordinator rules)");
  });
});
