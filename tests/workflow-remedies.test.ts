import { describe, expect, test } from "bun:test";
import { desktopRecoveryText } from "../apps/desktop/src/renderer/client/remedies.js";
import { tuiErrorText, tuiRecoveryText } from "../src/components/workflow/remedies.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { errorRecovery, recoveryAdvice, recoveryOf, type Remedy } from "../src/core/workflows/remedies.js";

describe("workflow recovery text (#1578)", () => {
  const actions: Remedy["action"][] = ["resume", "extend", "accept-workspace", "reroute", "revise", "replan", "deliver", "recover", "fork", "cancel", "pause"];
  test.each(actions)("%s keeps the CLI command and renders app actions", (action) => {
    const advice = recoveryAdvice("Use baked workflow command RUN", "The run needs a decision.", { action, runId: "RUN", initiativeId: "idea" });
    const fault = new WorkflowFault("STALE_DECISION", advice, { reason: "example" });
    expect(fault.message).toBe(advice.message);
    expect(errorRecovery(fault)).toEqual(advice);
    const tui = tuiErrorText(fault);
    const desktop = desktopRecoveryText(fault.message, recoveryOf(JSON.parse(JSON.stringify(advice))));
    for (const text of [tui, desktop]) {
      expect(text).toContain(advice.summary);
      expect(text).not.toContain("baked workflow");
    }
    if (action === "resume") {
      expect(tui).toContain("press R");
      expect(desktop).toContain("choose Retry");
    }
    if (action === "accept-workspace") {
      expect(tui).toContain("press A");
      expect(desktop).toContain("choose Accept changes");
    }
  });

  test("older messages and errors without advice remain readable", () => {
    expect(tuiRecoveryText("old message")).toBe("old message");
    expect(desktopRecoveryText("old message")).toBe("old message");
    expect(tuiErrorText(new Error("old error"))).toBe("old error");
    expect(recoveryOf({ summary: "incomplete" })).toBeUndefined();
  });
});
