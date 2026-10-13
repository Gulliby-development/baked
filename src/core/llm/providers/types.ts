import type { LanguageModel } from "ai";
import type { AppConfig } from "../../../types/index.js";
import type { DetectedLogin } from "../detected-logins.js";

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

/** One context window a provider offers for a model, and the model ID that asks for it. */
export interface ContextSizeOption {
  tokens: number;
  /** The provider's own model ID (without the `provider/` prefix) for this size. */
  modelId: string;
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
  /**
   * The context windows the provider offers for a model, smallest first, when it offers more
   * than one (Claude Code's `[1m]` variants). Absent or fewer than two: the model has one size.
   */
  contextSizes?(modelId: string): ContextSizeOption[];
  grouped?: boolean;
  checkAvailability?(): Promise<boolean>;
  /** A login another tool already holds, used when no key is set in the environment or saved. */
  detectLogin?(): DetectedLogin | null;
  onRequestAuth?(): Promise<void>;
  onActivate?(): Promise<void>;
  onDeactivate?(): void;
}
