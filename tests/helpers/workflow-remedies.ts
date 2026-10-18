import { expect } from "bun:test";
import { desktopRecoveryText } from "../../apps/desktop/src/renderer/client/remedies.js";
import { tuiRecoveryText } from "../../src/components/workflow/remedies.js";
import { type RecoveryAdvice, type Remedy } from "../../src/core/workflows/remedies.js";

/** The actual producer must attach advice while preserving its CLI message. */
export function expectRecovery(message: string, advice: RecoveryAdvice | undefined, action: Remedy["action"]): void {
  expect(advice).toBeDefined();
  expect(advice?.remedies.some((r) => r.action === action)).toBe(true);
  expect(message).toContain("workflow");
  for (const text of [tuiRecoveryText(message, advice), desktopRecoveryText(message, advice)]) {
    expect(text).not.toContain("baked workflow");
    expect(text).not.toContain("workflow revise");
    expect(text).toContain(advice?.summary ?? "missing advice");
  }
}
