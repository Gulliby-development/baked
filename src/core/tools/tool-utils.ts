import type { ToolResult } from "../../types/index.js";

/**
 * Construct a failed ToolResult where output and error share the same message.
 */
export function toolError(msg: string): ToolResult {
  return { success: false, output: msg, error: msg };
}

/**
 * Construct a denied ToolResult (e.g. forbidden path, unapproved action).
 */
export function toolDenied(msg: string): ToolResult {
  return { success: false, output: msg, error: msg };
}

/**
 * Clone an AI SDK tool, preserving prototype properties (inputSchema, description,
 * toModelOutput) that live on the prototype and are lost by object spread.
 *
 * Use instead of `{ ...tool, execute: ... }` whenever overriding tool properties.
 */
export function deriveTool<T extends object>(tool: T, overrides?: Partial<T>): T {
  const derived = Object.create(
    Object.getPrototypeOf(tool),
    Object.getOwnPropertyDescriptors(tool),
  ) as T;
  if (overrides) Object.assign(derived, overrides);
  return derived;
}
/**
 * Fast, stable content hash for change-detection / CAS preconditions.
 * Bun's native non-crypto hasher; hex string is the agent-facing `hash:` token.
 * Same input → same output across mac/linux/windows (no platform dependence).
 */
export function contentHash(s: string): string {
  return Bun.hash(s).toString(16);
}
