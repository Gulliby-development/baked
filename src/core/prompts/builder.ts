/**
 * PromptBuilder — assembles system prompts from modular sections.
 *
 * Architecture:
 * 1. Base prompt selected by model family (claude, openai, google, default)
 * 2. Shared tool guidance appended (with/without Baked Map variant)
 * 3. Dynamic project context appended (cwd, toolchain, instructions, git, memory, etc.)
 * 4. Mode overlay appended if active
 *
 * Cache strategy:
 * - The system prompt string returned here is marked with EPHEMERAL_CACHE in forge.ts
 * - Baked Map is injected as a separate user→assistant message pair (aider pattern)
 *   so it can update after edits without invalidating the cached system prompt
 * - Skills are injected as a separate message pair (same pattern)
 */

import type { ForgeMode } from "../../types/index.js";
import { detectModelFamily, extractBaseModel } from "../llm/provider-options.js";
import {
  CLAUDE_PROMPT,
  DEEPSEEK_REASONER_PROMPT,
  DEFAULT_PROMPT,
  GOOGLE_PROMPT,
  OPENAI_PROMPT,
} from "./families/index.js";
import { TOOL_GUIDANCE_NO_MAP, TOOL_GUIDANCE_WITH_MAP } from "./shared/index.js";

export type { ModelFamily } from "../llm/provider-options.js";

const FAMILY_PROMPTS: Record<string, string> = {
  claude: CLAUDE_PROMPT,
  openai: OPENAI_PROMPT,
  google: GOOGLE_PROMPT,
  // xAI uses OpenAI-style prompts — Grok responds best to that shape.
  xai: OPENAI_PROMPT,
  // DeepSeek V3 / V3.1-non-think → OpenAI-shape (function calling supported).
  deepseek: OPENAI_PROMPT,
  // deepseek-reasoner (R1 / V3.1-think) → minimal prompt, no tool guidance.
  "deepseek-reasoner": DEEPSEEK_REASONER_PROMPT,
  other: DEFAULT_PROMPT,
};

/** Get the base prompt for a model family. */
export function getFamilyPrompt(family: string): string {
  return FAMILY_PROMPTS[family] ?? DEFAULT_PROMPT;
}

/** Get the base prompt for a model ID. */
export function getPromptForModel(modelId: string): string {
  const family = detectModelFamily(modelId);
  return getFamilyPrompt(family);
}

export interface PromptBuilderOptions {
  modelId: string;
  hasRepoMap: boolean;
  hasSymbols: boolean;
  forgeMode: ForgeMode;
  contextPercent?: number;
  projectInstructions: string | null;
  cwd?: string;
  hasGhCli?: boolean;
}

/**
 * Build the complete system prompt.
 *
 * Returns a single string. The caller (forge.ts) wraps it in a system message
 * with EPHEMERAL_CACHE for Anthropic prompt caching.
 *
 * The Baked Map is NOT included here — it's injected as a separate user message
 * in prepareStep (aider pattern: user message = context, system = instructions).
 */
export function buildSystemPrompt(opts: PromptBuilderOptions): string {
  const family = detectModelFamily(opts.modelId);
  const parts: string[] = [];

  // ── STATIC SECTION (stable across steps → cached) ──

  // 1. Family-specific base prompt
  parts.push(getFamilyPrompt(family));

  // 2. Tool guidance — skip entirely for deepseek-reasoner (no function calling).
  const skipToolGuidance = family === "deepseek-reasoner";
  if (!skipToolGuidance) {
    if (opts.hasRepoMap) {
      parts.push(TOOL_GUIDANCE_WITH_MAP);

      if (!opts.hasSymbols) {
        parts.push(
          "Code intelligence limited: No symbols indexed. Intelligence tools fall back to regex.",
        );
      }
    } else {
      parts.push(TOOL_GUIDANCE_NO_MAP);
    }
  }

  // 2b. Gemini Flash temporal context (per Google's published Flash strategies).
  if (family === "google") {
    const base = extractBaseModel(opts.modelId);
    if (base.includes("flash")) {
      parts.push(
        "For time-sensitive queries that require up-to-date information, you MUST use the current date provided in tool calls. Your knowledge cutoff is January 2025; assume the current year is 2026 unless tool results state otherwise.",
      );
    }
  }

  // 3. Working directory and environment (stable — never changes during a session)
  if (opts.cwd)
    parts.push(
      `Working directory: ${opts.cwd} (shell commands already run here — do not prepend \`cd ${opts.cwd}\`)`,
    );
  if (opts.hasGhCli)
    parts.push("GitHub CLI (gh) is available. Use it for PRs, issues, and GitHub API operations.");

  // ── DYNAMIC SECTION ──

  // Project instructions (baked.md, CLAUDE.md, etc.)
  if (opts.projectInstructions) parts.push(opts.projectInstructions);

  // Mode overlay is NOT baked into the cached system prompt — it's injected as
  // a cache-stable user message in prepareStep (forge.ts) so switching modes
  // doesn't invalidate the system cache breakpoint (discussion #85, source #1).

  // 9. Skills reference (skills are injected as message pairs, not here)
  parts.push(
    "Skills may be loaded as context at the start of the conversation. Use skills(action: search) to find new ones, or Ctrl+S to browse.",
  );

  return parts.filter(Boolean).join("\n");
}
