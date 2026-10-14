import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { startApiServer } from "../src/core/api/server.js";
import { BriefStore } from "../src/core/chat/coordinator.js";
import { renderWorkflows, workflowCard } from "../src/core/chat/coordinator-launch.js";
import { ScriptedChatHost } from "../src/core/chat/scripted-host.js";
import { type ChatAgentHost, ChatService, type TurnAgentRequest } from "../src/core/chat/sessions.js";
import { readGates } from "../src/core/workflows/gates.js";
import { needsGates, resolveGateRequests } from "../src/core/workflows/gate-setup.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { projectDefinitions } from "../src/core/workflows/v2/propose.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

type Result = { success: boolean; output: string; error?: string };
type Tool = { execute: (input: Record<string, unknown>) => Promise<Result> };

class RecordingHost implements ChatAgentHost {
  requests: TurnAgentRequest[] = [];
  async agent(request: TurnAgentRequest) {
    this.requests.push(request);
    return {
      contextWindow: 1000,
      agent: {
        stream: async (_args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "ok" };
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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A project without gates, served with the coordinator over the same config object as the server. */
async function serve(host: ChatAgentHost) {
  const fixture = workflowFixture({ policy: { ...defaultWorkflowPolicy, checks: [] } });
  // As `baked serve`: the chat and the workflow service share one configuration object.
  const config = Object.assign(fixture.service.config, {
    defaultModel: "openai/gpt-test",
    coordinator: { wake: false },
  });
  const chat = new ChatService({ workspace: fixture.root, config, host, homeDir: fixture.root });
  const server = await startApiServer({ service: fixture.service, chat, pollMs: 20, log: () => {} });
  cleanups.push(async () => {
    await server.stop();
    await fixture.dispose();
  });
  const coordinator = await chat.coordinator(true);
  if (!coordinator) throw new Error("no coordinator");
  return { fixture, chat, coordinator };
}

async function until<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(20);
  }
}

const PASSING = 'bun -e "process.exit(0)"';
/** How a card shows PASSING: quotes only where a word needs them. */
const SHOWN = "bun -e process.exit(0)";

describe("coordinator gate setup", () => {
  test("a workflow without gates is flagged, refused before its card, then set up by the run card", async () => {
    // The scripted coordinator proposes standard without gates (refused before any card), then
    // again with the gate the user named; one approval saves the gate and starts the run.
    const host = new ScriptedChatHost({
      delayMs: 1,
      turns: [
        {
          steps: [
            {
              tool: "start_run",
              run: true,
              input: { prompt: "Create ready value", feature: "fixture", workflow: "standard", why: "Ship it" },
            },
            {
              tool: "start_run",
              run: true,
              input: {
                prompt: "Create ready value",
                feature: "fixture",
                workflow: "standard",
                gates: [{ id: "check", command: PASSING }],
                why: "Ship it",
              },
            },
          ],
        },
      ],
    });
    const { fixture, chat, coordinator } = await serve(host);
    expect(needsGates(fixture.root, fixture.config, "standard")).toBe(true);

    coordinator.send("Fix the value");
    const card = await until(
      () => coordinator.pendingPrompts.find((p) => p.kind === "workflow"),
      (p) => p !== undefined,
    );
    if (card?.kind !== "workflow") throw new Error("no workflow card");
    // Only the second call showed a card, and it carries the gate it saves.
    expect(coordinator.pendingPrompts).toHaveLength(1);
    expect(card).toMatchObject({ workflow: "standard", gates: [`check: ${SHOWN}`] });
    // Nothing saved or started before the yes.
    expect(readGates(fixture.root)).toEqual([]);
    expect((await fixture.service.list({ limit: 10 })).items).toEqual([]);

    coordinator.answer(card.id, { approve: true, digest: card.digest });
    await coordinator.settled();
    const refusal = JSON.stringify(
      coordinator.messages.flatMap((m) => m.toolCalls ?? []).find((c) => c.name === "start_run")?.result,
    );
    expect(refusal).toContain("Workflow standard cannot start yet");
    expect(refusal).toContain("Fill the gates in yourself");
    expect(readGates(fixture.root).map((c) => c.id)).toEqual(["check"]);
    expect(fixture.config.workflows?.policy?.checks?.map((c) => c.id)).toEqual(["check"]);
    const [run] = new BriefStore(chat.workspace, coordinator.id).read().launched;
    expect(run).toMatchObject({ kind: "run", workflow: "standard" });
    expect((await fixture.service.list({ limit: 10 })).items).toHaveLength(1);
    expect(needsGates(fixture.root, fixture.config, "standard")).toBe(false);
  }, 60_000);

  test("start_run fills in the detected gates on its card without asking", async () => {
    const host = new RecordingHost();
    const { fixture, coordinator } = await serve(host);
    writeFileSync(join(fixture.root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    writeFileSync(join(fixture.root, "bun.lock"), "");
    coordinator.send("hello");
    await coordinator.settled();
    const tools = (host.requests.at(-1)?.tools ?? {}) as Record<string, Tool>;
    const started = tools.start_run?.execute({
      prompt: "Create ready value",
      feature: "fixture",
      workflow: "standard",
      why: "Ship it",
    });
    const card = await until(() => coordinator.pendingPrompts[0], (p) => p !== undefined);
    expect(card).toMatchObject({ kind: "workflow", workflow: "standard", gates: ["tests: bun run test"] });
    // Declining saves nothing.
    coordinator.answer(card?.id ?? "", { approve: false });
    expect(await started).toMatchObject({ success: false });
    expect(readGates(fixture.root)).toEqual([]);
  }, 60_000);

  test("list_workflows and list_gates show what is missing and what BAKED detects", async () => {
    const host = new RecordingHost();
    const { fixture, coordinator } = await serve(host);
    writeFileSync(join(fixture.root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    writeFileSync(join(fixture.root, "bun.lock"), "");
    coordinator.send("hello");
    await coordinator.settled();
    const tools = (host.requests.at(-1)?.tools ?? {}) as Record<string, Tool>;

    const listed = await tools.list_workflows?.execute({});
    expect(listed?.output).toMatch(/- standard \(.*NEEDS GATES/);
    const gates = await tools.list_gates?.execute({});
    expect(gates?.output).toContain("## Configured gates\nNone.");
    expect(gates?.output).toContain("- tests: bun run test [from package.json script \"test\"]");
    expect(gates?.output).toMatch(/cannot start until a feature gate exists\n.*standard/);

    // A detected gate by its ID alone takes the detected command.
    const resolved = resolveGateRequests(fixture.root, fixture.config, [{ id: "tests" }]);
    expect(resolved).toMatchObject({ ok: true, checks: [{ id: "tests", executable: "bun", args: ["run", "test"] }] });
    expect(resolveGateRequests(fixture.root, fixture.config, [{ id: "nope" }])).toMatchObject({
      ok: false,
      error: expect.stringContaining("No detected gate nope"),
    });
  }, 60_000);

  test("save_gates saves only after the user approves its card, in any chat", async () => {
    const host = new RecordingHost();
    const { fixture, chat } = await serve(host);
    const session = await chat.create({ title: "plain chat" });
    session.send("hello");
    await session.settled();
    const tools = (host.requests.at(-1)?.tools ?? {}) as Record<string, Tool>;
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(["list_gates", "save_gates"]));

    const declined = tools.save_gates?.execute({ gates: [{ id: "check", command: PASSING }], why: "Verify runs" });
    const first = await until(() => session.pendingPrompts[0], (p) => p !== undefined);
    expect(first).toMatchObject({ kind: "destructive" });
    if (first?.kind === "destructive") expect(first.description).toContain(`+ check: ${SHOWN}`);
    session.answer(first?.id ?? "", { approve: false });
    expect(await declined).toMatchObject({ success: false });
    expect(readGates(fixture.root)).toEqual([]);

    const saved = tools.save_gates?.execute({ gates: [{ id: "check", command: PASSING }], why: "Verify runs" });
    const second = await until(() => session.pendingPrompts[0], (p) => p !== undefined);
    session.answer(second?.id ?? "", { approve: true });
    expect(await saved).toMatchObject({ success: true });
    expect(readGates(fixture.root).map((c) => c.id)).toEqual(["check"]);
    expect(projectDefinitions(fixture.root, fixture.config).find((d) => d.id === "standard")).toBeDefined();
  }, 60_000);

  test("the card digest binds the gates and stays unchanged without them", () => {
    const chosen = { id: "standard", summary: null, reason: "named" };
    const plain = workflowCard(chosen, "Do it", "why");
    expect(plain.gates).toBeUndefined();
    expect(workflowCard(chosen, "Do it", "why", undefined, []).digest).toBe(plain.digest);
    expect(workflowCard(chosen, "Do it", "why", undefined, ["check: x"]).digest).not.toBe(plain.digest);
    expect(
      renderWorkflows({
        list: () => [],
        propose: () => {
          throw new Error("unused");
        },
      }),
    ).toContain("None.");
  });
});
