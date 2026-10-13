import { readFileSync } from "node:fs";
import type { ChatAgentHost, TurnAgent, TurnAgentRequest } from "./sessions.js";

/**
 * TEST ONLY. A chat host that plays turns from a JSON file instead of calling a model, so the
 * desktop app can be tested end to end against a real `baked serve`. It is used only when the
 * BAKED_TEST_SCRIPT environment variable names the file; no config file can turn it on.
 *
 * File format: `{ "turns": [{ "steps": [...] }, ...] }`, one entry per user message in order.
 * Steps:
 * - `{ "text": "..." }` and `{ "reasoning": "..." }` stream word by word;
 * - `{ "tool": "read", "input": {...}, "output": "..." }` shows a tool call and its result;
 *   `"approval": { "outsideCwd": "/path" }`, `{ "destructive": "rm -rf x" }`,
 *   `{ "webSearch": "query" }` or `{ "fetchPage": "https://..." }` first asks the user through the
 *   same prompts as a real tool, and a denial fails the call;
 * - `{ "ifDenied": "..." }` after an approval streams this text only when it was denied, and
 *   `{ "ifApproved": "..." }` only when it was approved.
 * Turns after the last one answer "The test script has no more turns."
 */
export const TEST_SCRIPT_ENV = "BAKED_TEST_SCRIPT";

export type ScriptStep =
  | { text: string }
  | { reasoning: string }
  | { ifApproved: string }
  | { ifDenied: string }
  | {
      tool: string;
      input?: Record<string, unknown>;
      output?: string;
      approval?:
        | { outsideCwd: string }
        | { destructive: string }
        | { webSearch: string }
        | { fetchPage: string };
    };

export interface ChatScript {
  turns: { steps: ScriptStep[] }[];
  /** Milliseconds between streamed words; 15 by default. */
  delayMs?: number;
}

export function parseChatScript(raw: unknown): ChatScript {
  const turns = (raw as { turns?: unknown } | null)?.turns;
  if (!Array.isArray(turns)) throw new Error(`${TEST_SCRIPT_ENV}: the script needs a turns array`);
  for (const [i, turn] of turns.entries()) {
    const steps = (turn as { steps?: unknown } | null)?.steps;
    if (!Array.isArray(steps)) throw new Error(`${TEST_SCRIPT_ENV}: turn ${i + 1} has no steps`);
  }
  const delayMs = (raw as { delayMs?: unknown }).delayMs;
  return {
    turns: turns as ChatScript["turns"],
    delayMs: typeof delayMs === "number" ? delayMs : 15,
  };
}

/** The scripted host when BAKED_TEST_SCRIPT is set, else undefined. */
export function scriptedHostFromEnv(
  env: Record<string, string | undefined> = process.env,
): ScriptedChatHost | undefined {
  const file = env[TEST_SCRIPT_ENV];
  if (!file) return undefined;
  return new ScriptedChatHost(parseChatScript(JSON.parse(readFileSync(file, "utf8"))));
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

export class ScriptedChatHost implements ChatAgentHost {
  private next = 0;

  constructor(private readonly script: ChatScript) {}

  async agent(request: TurnAgentRequest): Promise<{ agent: TurnAgent; contextWindow: number }> {
    const steps = this.script.turns[this.next++]?.steps ?? [
      { text: "The test script has no more turns." },
    ];
    const delay = this.script.delayMs ?? 15;
    async function* play(signal: AbortSignal) {
      let lastApproval: boolean | null = null;
      let calls = 0;
      const words = async function* (type: "text-delta" | "reasoning-delta", text: string) {
        for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
          await sleep(delay, signal);
          yield { type, id: "scripted", text: piece };
        }
      };
      for (const step of steps) {
        if ("text" in step) yield* words("text-delta", step.text);
        else if ("reasoning" in step) yield* words("reasoning-delta", step.reasoning);
        else if ("ifApproved" in step) {
          if (lastApproval === true) yield* words("text-delta", step.ifApproved);
        } else if ("ifDenied" in step) {
          if (lastApproval === false) yield* words("text-delta", step.ifDenied);
        } else {
          const toolCallId = `scripted-${++calls}`;
          const input = step.input ?? {};
          yield { type: "tool-call", toolCallId, toolName: step.tool, input };
          let allowed = true;
          const approval = step.approval;
          if (approval)
            allowed =
              "outsideCwd" in approval
                ? await request.onApproveOutsideCwd(step.tool, approval.outsideCwd)
                : "webSearch" in approval
                  ? ((await request.callbacks.onWebSearchApproval?.(approval.webSearch)) ?? false)
                  : "fetchPage" in approval
                    ? ((await request.callbacks.onFetchPageApproval?.(approval.fetchPage)) ?? false)
                    : await request.onApproveDestructive(approval.destructive);
          if (step.approval) lastApproval = allowed;
          await sleep(delay, signal);
          yield {
            type: "tool-result",
            toolCallId,
            toolName: step.tool,
            input,
            output: allowed
              ? { success: true, output: step.output ?? "" }
              : { success: false, output: "", error: "Denied by the user." },
          };
        }
      }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1000, outputTokens: 100, inputTokenDetails: { cacheReadTokens: 0 } },
      };
    }
    return {
      contextWindow: 200_000,
      agent: {
        stream: async ({ abortSignal }) => ({
          stream: play(abortSignal),
          responseMessages: Promise.resolve([]),
        }),
      },
    };
  }

  release(): void {}

  async dispose(): Promise<void> {}
}
