import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { ModelMessage } from "ai";
import { act } from "react";
import { CoordinatorView } from "../src/components/coordinator/CoordinatorView";
import {
  keyHints,
  launchedLines,
  messageLines,
  promptLines,
  questionAnswer,
  wrap,
} from "../src/components/coordinator/model";
import {
  type CoordinatorWorkflowClient,
  clientLauncher,
  LocalCoordinator,
  ReadonlyProjectState,
} from "../src/core/chat/coordinator-host";
import { ScheduleStore } from "../src/core/chat/coordinator-schedules";
import type { ChatAgentHost, ChatPrompt, TurnAgentRequest } from "../src/core/chat/sessions";
import { nextLabel, scheduleLines } from "../src/components/coordinator/schedules";
import type { InitiativeView } from "../src/core/workflows/initiatives/service";
import type { AppConfig } from "../src/types/index";

class RecordingHost implements ChatAgentHost {
  requests: TurnAgentRequest[] = [];
  async agent(request: TurnAgentRequest) {
    this.requests.push(request);
    return {
      contextWindow: 1000,
      agent: {
        stream: async (_args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "Two runs are active." };
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

class FakeClient implements CoordinatorWorkflowClient {
  commands: string[][] = [];
  actions: unknown[] = [];
  async command(argv: string[], _signal: AbortSignal, onDrive?: (runId: string) => void) {
    this.commands.push(argv);
    onDrive?.("run-1");
    return null;
  }
  async startInitiative() {
    return {
      initiativeId: "init-1",
      revision: 3,
      pendingDecisions: [{ kind: "split_approval", requestId: "req-1", digest: "abc" }],
    } as unknown as InitiativeView;
  }
  async initiativeAction(initiativeId: string, action: unknown) {
    this.actions.push(action);
    return { initiativeId, revision: 4, pendingDecisions: [] } as unknown as InitiativeView;
  }
}

type Result = { success: boolean; output: string };
type Tool = { execute: (input: Record<string, unknown>) => Promise<Result> };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function project(): { root: string; config: AppConfig } {
  const root = mkdtempSync(join(tmpdir(), "baked-coordinator-tui-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, config: { defaultModel: "openai/gpt-test" } as AppConfig };
}

async function openLocal(client: CoordinatorWorkflowClient | null = new FakeClient()) {
  const { root, config } = project();
  const host = new RecordingHost();
  const local = await LocalCoordinator.open({
    workspace: root,
    config,
    client,
    model: () => "openai/gpt-test",
    host,
    homeDir: root,
    watchMs: 0,
  });
  cleanups.push(() => local.close());
  return { local, host, root };
}

const split: Extract<ChatPrompt, { kind: "split" }> = {
  id: "p1",
  createdAt: 0,
  kind: "split",
  title: "Auth rework",
  mode: "runs",
  digest: "d1",
  flows: [
    { id: "tokens", title: "Token checks", paths: ["src/auth/"], dependsOn: [], task: "acme/app#12" },
    { id: "docs", title: "Auth docs", paths: ["docs/auth.md"], dependsOn: [], task: "new issue" },
  ],
};

describe("terminal coordinator host", () => {
  test("project state is empty before any workflow run", () => {
    const { root, config } = project();
    const state = new ReadonlyProjectState(root, config);
    expect(state.runs(10)).toEqual([]);
    expect(state.initiatives()).toEqual([]);
    expect(state.attention()).toEqual([]);
    expect(state.featureTaken("anything")).toBe(false);
    expect(() => state.run("missing")).toThrow("No workflow run");
  });

  test("start_run goes through the workflow client with the coordinator as owner", async () => {
    const client = new FakeClient();
    const { local, host } = await openLocal(client);
    local.session.send("plan the week");
    await local.session.settled();
    const tools = (host.requests.at(-1)?.tools ?? {}) as Record<string, Tool>;
    const result = await tools.start_run?.execute({
      prompt: "Add rate limits",
      feature: "rate-limits",
      why: "Ship rate limits",
    });
    expect(result).toMatchObject({ success: true });
    expect(client.commands[0]).toEqual([
      "run",
      "--prompt",
      "Add rate limits",
      "--model",
      "openai/gpt-test",
      "--owner",
      "Coordinator",
      "--feature",
      "rate-limits",
    ]);
    expect(local.chat.launched(local.session.id).map((e) => e.id)).toEqual(["run-1"]);
  });

  test("a run without a feature or issue gets a feature id from its prompt", async () => {
    const client = new FakeClient();
    const { root, config } = project();
    const launcher = clientLauncher(client, {
      workspace: root,
      config,
      model: () => "m",
      featureTaken: () => false,
    });
    await launcher.startRun({ prompt: "Add rate limits", worktree: true });
    const argv = client.commands[0] ?? [];
    expect(argv[argv.indexOf("--feature") + 1]).toMatch(/rate-limits/);
    expect(argv).toContain("--worktree");
  });

  test("an approved split approves the initiative's split with its digest", async () => {
    const client = new FakeClient();
    const { root, config } = project();
    const launcher = clientLauncher(client, {
      workspace: root,
      config,
      model: () => "m",
      featureTaken: () => false,
    });
    const started = await launcher.startInitiative({
      initiativeId: "init-1",
      prompt: "Auth rework",
      approveSplit: true,
    });
    expect(started).toEqual({ initiativeId: "init-1" });
    expect(client.actions).toEqual([
      { kind: "approve", expectedRevision: 3, requestId: "req-1", digest: "abc" },
    ]);
  });
});

describe("terminal coordinator view model", () => {
  test("wrap breaks at spaces and keeps blank lines", () => {
    expect(wrap("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrap("a\n\nb", 10)).toEqual(["a", "", "b"]);
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("launched lines show status, tokens, task and why", () => {
    const [line] = launchedLines(
      [
        {
          kind: "run",
          id: "run-1",
          why: "Ship it",
          status: "running",
          active: true,
          tokens: 12_400,
          task: { ref: "acme/app#12", state: "open" },
        },
      ],
      200,
    );
    expect(line).toEqual({
      text: "● Run run-1: running · 12k tokens · acme/app#12 · Ship it",
      tone: "accent",
    });
  });

  test("launched lines name a session by its title and colour a wait", () => {
    const [line] = launchedLines(
      [
        {
          kind: "session",
          id: "e372f9bc-ae25-4098-96b0-3c7188fb7fd3",
          title: "Deploy to Vercel",
          why: "Publish the page",
          status: "waiting for you",
          active: true,
          tokens: 900,
        },
      ],
      200,
    );
    expect(line).toEqual({
      text: '● Session "Deploy to Vercel": waiting for you · 900 tokens · Publish the page',
      tone: "warning",
    });
  });

  test("a launch notice is a marked headline with its why, not a raw id", () => {
    const lines = messageLines(
      [
        {
          id: "n",
          role: "system",
          content: "fallback",
          timestamp: 0,
          showInChat: true,
          launch: {
            kind: "session",
            id: "e372f9bc-ae25-4098-96b0-3c7188fb7fd3",
            status: "waiting for you",
            why: "Publish the page",
            event: "status",
          },
        },
      ],
      "",
      80,
    );
    expect(lines.slice(0, 2)).toEqual([
      { text: "  ◆ Session e372f9bc: waiting for you", tone: "warning" },
      { text: "    Publish the page", tone: "muted" },
    ]);
  });

  test("a launched session's answer shows under its note, cut to a few lines", () => {
    const lines = messageLines(
      [
        {
          id: "n",
          role: "system",
          content: "fallback",
          timestamp: 0,
          launch: {
            kind: "session",
            id: "s1",
            title: "Survey",
            status: "done",
            why: "Survey",
            result: Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join("\n"),
            event: "status",
          },
        },
      ],
      "",
      80,
    ).map((l) => l.text);
    expect(lines.slice(0, 8)).toEqual([
      '  ◆ Session "Survey": done',
      "    │ line 1",
      "    │ line 2",
      "    │ line 3",
      "    │ line 4",
      "    │ line 5",
      "    │ line 6",
      "    │ … 3 more lines",
    ]);
  });

  test("messages label the speaker and list tool calls", () => {
    const lines = messageLines(
      [
        { id: "1", role: "user", content: "status?", timestamp: 0 },
        {
          id: "2",
          role: "assistant",
          content: "All quiet.",
          timestamp: 0,
          toolCalls: [{ id: "t", name: "project_state", args: {} }],
        },
      ],
      "Still typing",
      80,
    ).map((l) => l.text);
    expect(lines).toEqual(["you  status?", "", "  ↳ project_state", "     All quiet.", "", "     Still typing"]);
  });

  test("a split card lists flows and the keys that answer it", () => {
    const text = promptLines(split, 80).map((l) => l.text);
    expect(text[0]).toBe("Split: Auth rework (parallel runs)");
    expect(text).toContain("1. Token checks [tokens] · acme/app#12");
    expect(keyHints(split, false).map((h) => h.label)).toEqual([
      "approve split",
      "reject",
      "edit",
      "back",
    ]);
    expect(keyHints(undefined, false).map((h) => h.label)).toEqual(["send", "back"]);
    expect(keyHints(undefined, true).map((h) => h.label)).toEqual(["send", "stop"]);
  });

  test("a question takes an option number or free text", () => {
    const question = {
      id: "q",
      createdAt: 0,
      kind: "question" as const,
      question: "Which?",
      allowSkip: false,
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
    };
    expect(questionAnswer(question, "2")).toBe("b");
    expect(questionAnswer(question, "neither")).toBe("neither");
  });
});

async function settle(view: Awaited<ReturnType<typeof testRender>>) {
  for (let frame = 0; frame < 3; frame++) {
    await act(async () => {
      await view.flush();
      await view.renderOnce();
    });
  }
}

async function until(view: Awaited<ReturnType<typeof testRender>>, text: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await settle(view);
    if (view.captureCharFrame().includes(text)) return;
    await Bun.sleep(20);
  }
  throw new Error(`"${text}" never showed:\n${view.captureCharFrame()}`);
}

describe("terminal coordinator view", () => {
  for (const [width, height] of [
    [120, 40],
    [80, 24],
    [50, 20],
  ] as const) {
    test(`sends a message and answers a split card at ${width}x${height}`, async () => {
      const { local } = await openLocal();
      const view = await testRender(
        <CoordinatorView visible open={async () => local} onClose={() => {}} />,
        { width, height },
      );
      try {
        await until(view, "Message the coordinator");
        await act(async () => {
          await view.mockInput.typeText("status?");
        });
        await settle(view);
        await act(async () => {
          view.mockInput.pressEnter();
        });
        await until(view, "Two runs are active.");
        expect(view.captureCharFrame()).toContain("you  status?");

        const answered = local.session.proposeSplit({
          kind: "split",
          title: split.title,
          mode: split.mode,
          digest: split.digest,
          flows: split.flows,
        });
        await until(view, "Split: Auth rework");
        expect(view.captureCharFrame()).toContain("Esc");
        await act(async () => {
          view.mockInput.pressKey("e", { ctrl: true });
        });
        expect(await answered).toBe(false);
        await until(view, "Change the split:");

        const popup = view.renderer.root.findDescendantById("baked-popup");
        expect(popup?.width).toBeLessThanOrEqual(width);
        expect(popup?.height).toBeLessThanOrEqual(height);
      } finally {
        await act(async () => {
          view.renderer.destroy();
        });
      }
    });
  }
});

describe("terminal coordinator schedules", () => {
  test("schedule lines show name, when and the next firing", () => {
    const now = new Date(2026, 9, 10, 8, 0).getTime();
    const base = { prompt: "x", createdAt: now, lastRunAt: null };
    const lines = scheduleLines(
      [
        { ...base, id: "a", name: "Nightly", when: "0 2 * * *", enabled: true, nextRunAt: new Date(2026, 9, 11, 2, 0).getTime() },
        { ...base, id: "b", name: "Deps", when: "every 1d", enabled: false, nextRunAt: now },
      ],
      80,
      now,
    );
    expect(lines).toEqual([
      { text: "\u25f7 Nightly \u00b7 0 2 * * * \u00b7 next 2026-10-11 02:00", tone: "accent" },
      { text: "\u2016 Deps \u00b7 every day \u00b7 paused", tone: "muted" },
    ]);
    expect(nextLabel(new Date(2026, 9, 10, 9, 30).getTime(), now)).toBe("09:30");
    const long = { ...base, id: "c", name: "A long name", when: "every 1h", enabled: true, nextRunAt: now };
    expect(scheduleLines([long], 10, now)[0]?.text).toHaveLength(10);
  });

  test("the view lists the coordinator's schedules", async () => {
    const { local } = await openLocal();
    new ScheduleStore(local.chat.workspace, local.session.id).add({
      name: "Morning summary",
      prompt: "Summarize the night",
      when: "0 9 * * *",
    });
    const view = await testRender(<CoordinatorView visible open={async () => local} onClose={() => {}} />, {
      width: 100,
      height: 30,
    });
    try {
      await until(view, "Morning summary");
      expect(view.captureCharFrame()).toContain("Schedules");
    } finally {
      await act(async () => {
        view.renderer.destroy();
      });
    }
  });
});
