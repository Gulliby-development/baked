import { afterEach, describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { startApiServer } from "../src/core/api/server.js";
import {
  requestSummary,
  SUMMARY_DISPLAY,
  SUMMARY_SECTIONS,
  summaryPrompt,
} from "../src/core/chat/coordinator-summary.js";
import { type ChatAgentHost, ChatService, type SessionDetail } from "../src/core/chat/sessions.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

/** Records what the model is sent and answers every turn with one text part. */
class FakeHost implements ChatAgentHost {
  sent: ModelMessage[][] = [];
  async agent() {
    const sent = this.sent;
    return {
      contextWindow: 1000,
      agent: {
        stream: async (args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => {
          sent.push(args.messages);
          return {
            stream: (async function* () {
              yield { type: "text-delta", text: "**Running**\nNothing." };
              yield { type: "finish-step", usage: { inputTokens: 10, outputTokens: 0 } };
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

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function lastUserText(messages: ModelMessage[] | undefined): string {
  const last = messages?.filter((m) => m.role === "user").at(-1);
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((part) => ("text" in part ? part.text : "")).join("");
}

async function setup() {
  const fixture = workflowFixture();
  const host = new FakeHost();
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
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(`${server.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { chat, host, call };
}

describe("coordinator summary", () => {
  test("the prompt asks for the four sections from project state without launching", () => {
    const prompt = summaryPrompt();
    for (const section of SUMMARY_SECTIONS) expect(prompt).toContain(`**${section}**`);
    expect(prompt).toContain("project_state");
    expect(prompt).toContain("do not launch");
    expect(prompt).toContain('"Nothing."');
  });

  test("only the coordinator gives a summary", async () => {
    const { chat } = await setup();
    const ordinary = await chat.create({});
    expect(() => requestSummary(ordinary)).toThrow("coordinator");
  });

  test("POST /v1/coordinator/summary starts a turn shown as the short question", async () => {
    const { chat, host, call } = await setup();
    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("coordinator-summary");
    expect((await call("/v1/coordinator/summary", "POST", {})).status).toBe(404);

    const session = (await (await call("/v1/coordinator", "POST", {})).json()) as SessionDetail;
    const started = await call("/v1/coordinator/summary", "POST", {});
    expect(started.status).toBe(202);
    expect(((await started.json()) as { queued: boolean }).queued).toBe(false);
    const coordinator = chat.get(session.id);
    await coordinator.settled();
    // A request while a turn runs waits as a turn of its own.
    expect(requestSummary(coordinator).queued).toBe(false);
    expect(requestSummary(coordinator).queued).toBe(true);
    await coordinator.settled();
    await coordinator.settled();

    expect(host.sent.length).toBe(3);
    expect(lastUserText(host.sent[0])).toBe(summaryPrompt());
    const shown = coordinator.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(shown).toEqual([SUMMARY_DISPLAY, SUMMARY_DISPLAY, SUMMARY_DISPLAY]);
    expect((await call("/v1/coordinator/summary")).status).toBe(405);
  });
});
