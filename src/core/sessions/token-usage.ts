import type { TabMeta } from "./types.js";

/**
 * A chat tab's saved token usage, the one meaning every surface (TUI, headless, `baked serve`
 * and the desktop app) writes and reads (#2784):
 *
 * - `prompt` is uncached input only; `prompt + cacheRead + cacheWrite` is the whole input.
 * - `total` is the whole input plus `completion`.
 * - `modelBreakdown` holds the same split per model (`input` uncached), which prices the tab.
 *
 * Surfaces save through `addTabUsage` and load through `readTabUsage`, never by hand.
 */

export interface ModelTokens {
  /** Uncached input. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TabTokenUsage {
  prompt: number;
  completion: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  subagentInput?: number;
  subagentOutput?: number;
  modelBreakdown: Record<string, ModelTokens>;
}

/** One step's (or turn's) usage as providers report it: `input` includes the cached tokens. */
export interface StepTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
}

/** The usage of a tab that has spent nothing. */
export function emptyTabUsage(): TabTokenUsage {
  return { prompt: 0, completion: 0, total: 0, cacheRead: 0, cacheWrite: 0, modelBreakdown: {} };
}

/**
 * Reads a saved tab's usage into the shared meaning. A tab saved without a `modelBreakdown` was
 * written by headless or the API before #2784, whose `prompt` is the whole input: its cache reads
 * are taken out, and its tokens go into a breakdown under the tab's model so their cost survives.
 */
export function readTabUsage(
  saved: TabMeta["tokenUsage"] | undefined,
  tabModel?: string | null,
): TabTokenUsage {
  if (!saved) return emptyTabUsage();
  const cacheRead = saved.cacheRead ?? 0;
  const cacheWrite = saved.cacheWrite ?? 0;
  if (saved.modelBreakdown) {
    return { ...saved, cacheRead, cacheWrite, modelBreakdown: { ...saved.modelBreakdown } };
  }
  const prompt = Math.max(0, saved.prompt - cacheRead - cacheWrite);
  const spent = prompt + saved.completion + cacheRead + cacheWrite > 0;
  const model = tabModel && tabModel !== "none" ? tabModel : null;
  return {
    ...saved,
    prompt,
    cacheRead,
    cacheWrite,
    modelBreakdown:
      model && spent
        ? { [model]: { input: prompt, output: saved.completion, cacheRead, cacheWrite } }
        : {},
  };
}

/** Adds a step's usage, run on `modelId`, to a tab's usage. Returns a new object. */
export function addTabUsage(
  usage: TabTokenUsage,
  modelId: string,
  step: StepTokens,
): TabTokenUsage {
  const cacheWrite = step.cacheWrite ?? 0;
  const uncached = Math.max(0, step.input - step.cacheRead - cacheWrite);
  const prev = usage.modelBreakdown[modelId] ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  return {
    ...usage,
    prompt: usage.prompt + uncached,
    completion: usage.completion + step.output,
    total: usage.total + step.input + step.output,
    cacheRead: usage.cacheRead + step.cacheRead,
    cacheWrite: usage.cacheWrite + cacheWrite,
    modelBreakdown: {
      ...usage.modelBreakdown,
      [modelId]: {
        input: prev.input + uncached,
        output: prev.output + step.output,
        cacheRead: prev.cacheRead + step.cacheRead,
        cacheWrite: prev.cacheWrite + cacheWrite,
      },
    },
  };
}

/** The whole input of a tab's usage, cached tokens included, as the API reports it. */
export function tabInput(usage: TabTokenUsage): number {
  return usage.prompt + usage.cacheRead + usage.cacheWrite;
}
