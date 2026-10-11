import type { ProviderDefinition, ProviderModelInfo } from "../types.js";
import {
  assertCodexReady,
  fetchCodexModelsFromAppServer,
  getCodexLoginStatus,
  logoutCodex,
  parseCodexLoginStatus,
  parseCodexModelListResult,
} from "./client.js";
import { createCodexNativeLanguageModel, getDefaultCodexSessions } from "./native.js";
import {
  buildCodexSchema,
  CodexCliRunner,
  createCodexLanguageModel,
  parseCodexResponse,
  serializeCodexPrompt,
} from "./runner.js";

const GPT_55_INPUT_CONTEXT = 272_000;

export const CODEX_FALLBACK_MODELS: ProviderModelInfo[] = [
  { id: "gpt-5.5", name: "GPT-5.5", contextWindow: GPT_55_INPUT_CONTEXT },
  { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 1_050_000 },
  { id: "gpt-5.2-codex", name: "GPT-5.2-Codex", contextWindow: 400_000 },
];

export const CODEX_CONTEXT_WINDOWS: [pattern: string, tokens: number][] = [
  ["gpt-5.5", GPT_55_INPUT_CONTEXT],
  ["gpt-5.4", 1_050_000],
  ["gpt-5.2-codex", 400_000],
];

const CODEX_CONTEXT_WINDOW_OVERRIDES: [pattern: string, tokens: number][] = [
  ["gpt-5.5", GPT_55_INPUT_CONTEXT],
];

export const codex: ProviderDefinition = {
  id: "codex",
  name: "Codex",
  // Empty envVar marks providers that authenticate outside baked and keeps them
  // out of getProviderSecretEntries(), which only registers non-empty env-backed secrets.
  envVar: "",
  icon: "⌘",
  asciiIcon: "C",
  description: "OpenAI Codex via the official CLI app-server, with your ChatGPT login.",
  noAuthLabel: "login required — Enter to authenticate",
  authErrorLabel: "login/session error",
  onRequestAuth: async () => {
    const { requestCodexAuth } = await import("./auth.js");
    await requestCodexAuth();
  },
  createModel(modelId: string) {
    assertCodexReady();
    const exec = createCodexLanguageModel(modelId, new CodexCliRunner());
    if (process.env.BAKED_CODEX_TRANSPORT === "exec") return exec;
    return createCodexNativeLanguageModel(modelId, getDefaultCodexSessions(), exec);
  },
  async fetchModels() {
    const status = getCodexLoginStatus();
    if (!status.installed || !status.loggedIn) return null;
    return fetchCodexModelsFromAppServer();
  },
  fallbackModels: CODEX_FALLBACK_MODELS,
  contextWindows: CODEX_CONTEXT_WINDOWS,
  contextWindowOverrides: CODEX_CONTEXT_WINDOW_OVERRIDES,
  checkAvailability: async () => {
    const status = getCodexLoginStatus();
    return status.installed && status.loggedIn;
  },
};

export {
  buildCodexSchema,
  createCodexLanguageModel,
  getCodexLoginStatus,
  logoutCodex,
  parseCodexLoginStatus,
  parseCodexModelListResult,
  parseCodexResponse,
  serializeCodexPrompt,
};
