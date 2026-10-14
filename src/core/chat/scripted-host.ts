import { readFileSync } from "node:fs";
import type { ModelMessage } from "ai";
import type {
  ChatAgentHost,
  CompactionRequest,
  CompactionResponse,
  TurnAgent,
  TurnAgentRequest,
} from "./sessions.js";

/**
 * TEST ONLY. A chat host that plays turns from a JSON file instead of calling a model, so the
 * desktop app can be tested end to end against a real `baked serve`. It is used only when the
 * BAKED_TEST_SCRIPT environment variable names the file; no config file can turn it on.
 *
 * File format: `{ "turns": [{ "steps": [...] }, ...] }`, one entry per user message in order. A
 * turn with `"when": "text"` instead answers the first message that contains that text, so
 * parallel chats and launched sessions get their own turns whatever order they start in.
 * Steps:
 * - `{ "text": "..." }` and `{ "reasoning": "..." }` stream word by word;
 * - `{ "tool": "read", "input": {...}, "output": "..." }` shows a tool call and its result;
 *   `"approval": { "outsideCwd": "/path" }`, `{ "destructive": "rm -rf x" }`,
 *   `{ "webSearch": "query" }` or `{ "fetchPage": "https://..." }` first asks the user through the
 *   same prompts as a real tool, and a denial fails the call;
 * - `{ "ifDenied": "..." }` after an approval streams this text only when it was denied, and
 *   `{ "ifApproved": "..." }` only when it was approved;
 * - `{ "tool": "start_run", "input": {...}, "run": true }` calls the turn's real tool of that name
 *   (such as a coordinator's launch tools) and shows what it returned;
 * - `{ "ask": "question", "options": ["A", "B"] }` asks the user as `ask_user` does, and
 *   `{ "ifAnswer": "A", "reply": "..." }` streams the reply only when the user picked that option.
 * Turns after the last one answer "The test script has no more turns." Compaction replaces all
 * but the last two messages with `compaction` (a summary text) or a fixed summary.
 */
export const TEST_SCRIPT_ENV = "BAKED_TEST_SCRIPT";

export type ScriptStep =
  | { text: string }
  | { reasoning: string }
  | { ifApproved: string }
  | { ifDenied: string }
  | { ask: string; options: string[] }
  | { ifAnswer: string; reply: string }
  | {
      tool: string;
      input?: Record<string, unknown>;
      output?: string;
      approval?:
        | { outsideCwd: string }
        | { destructive: string }
        | { webSearch: string }
        | { fetchPage: string };
      /** Call the turn's own tool of this name instead of showing `output`. */
      run?: boolean;
    };

export interface ChatScript {
  turns: { steps: ScriptStep[]; when?: string }[];
  /** The summary a compaction keeps. */
  compaction?: string;
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
  const { delayMs, compaction } = raw as { delayMs?: unknown; compaction?: unknown };
  return {
    turns: turns as ChatScript["turns"],
    delayMs: typeof delayMs === "number" ? delayMs : 15,
    ...(typeof compaction === "string" ? { compaction } : {}),
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
  private used = new Set<number>();

  constructor(private readonly script: ChatScript) {}

  /** The first unplayed turn whose `when` the message contains, else the next turn without one. */
  private take(message: string | null): ScriptStep[] {
    const turns = this.script.turns;
    const free = (i: number) => !this.used.has(i);
    let index = turns.findIndex(
      (turn, i) => free(i) && turn.when !== undefined && (message ?? "").includes(turn.when),
    );
    if (index < 0) index = turns.findIndex((turn, i) => free(i) && turn.when === undefined);
    if (index < 0) return [{ text: "The test script has no more turns." }];
    this.used.add(index);
    return turns[index]?.steps ?? [];
  }

  async agent(request: TurnAgentRequest): Promise<{ agent: TurnAgent; contextWindow: number }> {
    const delay = this.script.delayMs ?? 15;
    let said = "";
    async function* play(steps: ScriptStep[], signal: AbortSignal) {
      let lastApproval: boolean | null = null;
      let lastAnswer: string | null = null;
      let calls = 0;
      const words = async function* (type: "text-delta" | "reasoning-delta", text: string) {
        for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
          await sleep(delay, signal);
          if (type === "text-delta") said += piece;
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
        } else if ("ifAnswer" in step) {
          if (lastAnswer === step.ifAnswer) yield* words("text-delta", step.reply);
        } else if ("ask" in step) {
          const toolCallId = `scripted-${++calls}`;
          const input = { question: step.ask, options: step.options };
          yield { type: "tool-call", toolCallId, toolName: "ask_user", input };
          lastAnswer = await request.callbacks.onAskUser(
            step.ask,
            step.options.map((label) => ({ label, value: label })),
            false,
          );
          const output = { success: true, output: `The user answered: ${lastAnswer}` };
          yield { type: "tool-result", toolCallId, toolName: "ask_user", input, output };
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
          const real = step.run
            ? (request.tools?.[step.tool] as
                | {
                    execute?: (input: Record<string, unknown>) => Promise<unknown>;
                    inputSchema?: { parse?: (input: unknown) => Record<string, unknown> };
                  }
                | undefined)
            : undefined;
          const output = !allowed
            ? { success: false, output: "", error: "Denied by the user." }
            : real?.execute
              ? // As the model's call would, with the schema's defaults applied.
                await real.execute(real.inputSchema?.parse?.(input) ?? input)
              : step.run
                ? { success: false, output: "", error: `No tool ${step.tool} in this turn.` }
                : { success: true, output: step.output ?? "" };
          await sleep(delay, signal);
          yield { type: "tool-result", toolCallId, toolName: step.tool, input, output };
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
        stream: async ({ abortSignal, options }) => {
          let finished = () => {};
          const done = new Promise<void>((resolve) => {
            finished = resolve;
          });
          const steps = this.take(options.userMessage);
          async function* played() {
            try {
              yield* play(steps, abortSignal);
            } finally {
              finished();
            }
          }
          return {
            stream: played(),
            // The streamed text, so later turns, compaction and rewind see a real history.
            responseMessages: done.then((): ModelMessage[] =>
              said ? [{ role: "assistant", content: said }] : [],
            ),
          };
        },
      },
    };
  }

  async compact(request: CompactionRequest): Promise<CompactionResponse> {
    const kept = request.messages.slice(-2);
    const summary = this.script.compaction ?? "Summary of the earlier conversation.";
    return {
      result: {
        status: "compacted",
        messages: [{ role: "user", content: summary }, ...kept],
        summary,
        compacted: request.messages.length - kept.length,
        strategy: "v1",
      },
    };
  }

  release(): void {}

  async dispose(): Promise<void> {}
}
