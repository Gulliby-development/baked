import type { LanguageModel } from "ai";
import type { AppConfig } from "../../../types/index.js";

/** What a model is created with besides its id. */
export interface CreateModelOptions {
  /**
   * The configuration the model's calls run with, such as a chat's own reasoning effort; the
   * saved configuration when absent. Only providers that fix options at creation read it.
   */
  config?: AppConfig;
}

export interface ProviderModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  envVar: string;
  icon: string;
  /** Kebab-case key for the secrets store (e.g. "anthropic-api-key"). Derived from envVar if omitted. */
  secretKey?: string;
  /** URL where users can create/manage their API key (shown in /keys UI). */
  keyUrl?: string;

  asciiIcon?: string;
  /** Short description for wizard/UI (e.g. "Claude models"). */
  description?: string;
  /** Inline badge for provider selectors (e.g. "unofficial", "non-streaming"). */
  badge?: string;
  /** Custom label shown when the provider is unavailable and needs auth. */
  noAuthLabel?: string;
  /** Custom label shown when model loading fails after the provider is available. */
  authErrorLabel?: string;
  createModel(modelId: string, options?: CreateModelOptions): LanguageModel;
  fetchModels(): Promise<ProviderModelInfo[] | null>;
  fallbackModels: ProviderModelInfo[];
  contextWindows: [pattern: string, tokens: number][];

  contextWindowOverrides?: [pattern: string, tokens: number][];
  grouped?: boolean;
  checkAvailability?(): Promise<boolean>;
  onRequestAuth?(): Promise<void>;
  onActivate?(): Promise<void>;
  onDeactivate?(): void;
}
