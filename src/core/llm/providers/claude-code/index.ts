import { randomUUID } from "node:crypto";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  SharedV3Warning,
} from "@ai-sdk/provider";
import type { ProviderDefinition, ProviderModelInfo } from "../types.js";
import { assertClaudeCodeReady, getClaudeCodeLoginStatus } from "./cli.js";
import { buildClaudeCodePromptParts, parseClaudeCodeResponse } from "./prompt.js";
import {
  type ClaudeCodeRunner,
  closeDefaultClaudeCodeRunner,
  getDefaultClaudeCodeRunner,
} from "./session.js";

/** Claude Code model aliases; each resolves to the newest model of its family. */
export const CLAUDE_CODE_FALLBACK_MODELS: ProviderModelInfo[] = [
  { id: "opus", name: "Opus (latest)" },
  { id: "sonnet", name: "Sonnet (latest)" },
  { id: "haiku", name: "Haiku (latest)" },
  { id: "fable", name: "Fable (latest)" },
];

// Plans differ in the context they allow, so aliases get the window every plan has;
// a `[1m]` model id asks Claude Code for the 1M window.
export const CLAUDE_CODE_CONTEXT_WINDOWS: [pattern: string, tokens: number][] = [
  ["[1m]", 1_000_000],
  ["opus", 200_000],
  ["sonnet", 200_000],
  ["haiku", 200_000],
  ["fable", 200_000],
  ["claude", 200_000],
];

const UNSUPPORTED_SETTINGS = [
  "maxOutputTokens",
  "temperature",
  "stopSequences",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "seed",
] as const;

function collectWarnings(options: LanguageModelV3CallOptions): SharedV3Warning[] {
  return UNSUPPORTED_SETTINGS.filter((setting) => options[setting] !== undefined).map(
    (setting) => ({
      type: "unsupported" as const,
      feature: setting,
      details: "Claude Code CLI ignores this setting",
    }),
  );
}

export function createClaudeCodeLanguageModel(
  modelId: string,
  runner: ClaudeCodeRunner = getDefaultClaudeCodeRunner(),
): LanguageModelV3 {
  const generate = async (options: LanguageModelV3CallOptions) => {
    const result = await runner.run({
      modelId,
      parts: buildClaudeCodePromptParts(options),
      abortSignal: options.abortSignal,
    });
    const parsed = parseClaudeCodeResponse(result.structured, result.text);
    return {
      content: parsed.content,
      finishReason: parsed.finishReason,
      usage: result.usage,
      warnings: collectWarnings(options),
    };
  };

  return {
    specificationVersion: "v3",
    provider: "claude-code",
    modelId,
    supportedUrls: {},
    doGenerate: generate,
    async doStream(options) {
      const generated = await generate(options);
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: generated.warnings });
          for (const part of generated.content) {
            if (part.type === "text") {
              const id = `text-${randomUUID()}`;
              controller.enqueue({ type: "text-start", id });
              controller.enqueue({ type: "text-delta", id, delta: part.text });
              controller.enqueue({ type: "text-end", id });
            } else if (part.type === "tool-call") {
              controller.enqueue(part);
            }
          }
          controller.enqueue({
            type: "finish",
            finishReason: generated.finishReason,
            usage: generated.usage,
          });
          controller.close();
        },
      });
      return { stream };
    },
  };
}

export const claudeCode: ProviderDefinition = {
  id: "claude-code",
  name: "Claude Code",
  // Empty envVar: the CLI authenticates outside BAKED, so no key is stored.
  envVar: "",
  icon: "󱜙", // nf-md-* U+F1719, same mark as Claude
  asciiIcon: "K",
  description:
    "Claude models through your Claude Code login (subscription). Output appears when each step finishes.",
  noAuthLabel: "login required — Enter to authenticate",
  authErrorLabel: "login/session error",
  badge: "non-streaming",
  onRequestAuth: async () => {
    const { requestClaudeCodeAuth } = await import("./auth.js");
    await requestClaudeCodeAuth();
  },
  createModel(modelId: string) {
    assertClaudeCodeReady();
    return createClaudeCodeLanguageModel(modelId);
  },
  async fetchModels() {
    // The CLI has no model listing; its aliases always point at the newest models.
    return null;
  },
  fallbackModels: CLAUDE_CODE_FALLBACK_MODELS,
  contextWindows: CLAUDE_CODE_CONTEXT_WINDOWS,
  checkAvailability: async () => {
    const status = getClaudeCodeLoginStatus();
    return status.installed && status.loggedIn;
  },
  onDeactivate: () => closeDefaultClaudeCodeRunner(),
};

export {
  getClaudeCodeLoginStatus,
  invalidateClaudeCodeStatus,
  logoutClaudeCode,
  parseClaudeCodeAuthStatus,
  parseClaudeCodeFlags,
} from "./cli.js";
export {
  buildClaudeCodePromptParts,
  buildClaudeCodeSchema,
  parseClaudeCodeResponse,
  renderClaudeCodeTurn,
} from "./prompt.js";
export type { ClaudeCodeProcess, ClaudeCodeProcessFactory, ClaudeCodeRunner } from "./session.js";
export { ClaudeCodeSessionRunner, usageFromResult } from "./session.js";
