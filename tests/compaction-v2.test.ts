import { describe, expect, test } from "bun:test";
import {
  extractFromAssistantMessage,
  extractFromToolCall,
  extractFromToolResult,
  extractFromUserMessage,
} from "../src/core/compaction/extractor.js";
import { buildV2Summary } from "../src/core/compaction/summarize.js";
import { WorkingStateManager } from "../src/core/compaction/working-state.js";

function userMsg(text: string) {
  return { role: "user" as const, content: text };
}
function assistantMsg(text: string) {
  return { role: "assistant" as const, content: text };
}

describe("WorkingStateManager", () => {
  test("starts empty with zero slots", () => {
    const wsm = new WorkingStateManager();
    expect(wsm.slotCount()).toBe(0);
    expect(wsm.serialize()).toBe("");
  });

  test("tracks task from first user message", () => {
    const wsm = new WorkingStateManager();
    wsm.setTask("fix the login bug");
    expect(wsm.getState().task).toBe("fix the login bug");
    expect(wsm.slotCount()).toBe(1);
  });

  test("tracks files with actions", () => {
    const wsm = new WorkingStateManager();
    wsm.trackFile("src/auth.ts", { type: "read", summary: "read" });
    wsm.trackFile("src/auth.ts", { type: "edit", detail: "fixed validation" });
    const file = wsm.getState().files.get("src/auth.ts");
    expect(file?.actions).toHaveLength(2);
    expect(file?.actions[0]?.type).toBe("read");
    expect(file?.actions[1]?.type).toBe("edit");
  });

  test("deduplicates decisions", () => {
    const wsm = new WorkingStateManager();
    wsm.addDecision("use zod for validation");
    wsm.addDecision("use zod for validation");
    wsm.addDecision("use zod for validation");
    expect(wsm.getState().decisions).toHaveLength(1);
  });

  test("does not deduplicate failures", () => {
    const wsm = new WorkingStateManager();
    wsm.addFailure("timeout error");
    wsm.addFailure("timeout error");
    expect(wsm.getState().failures).toHaveLength(2);
  });

  test("enforces max list size with FIFO", () => {
    const wsm = new WorkingStateManager();
    for (let i = 0; i < 30; i++) {
      wsm.addUserRequirement(`requirement ${i} is important enough`);
    }
    expect(wsm.getState().userRequirements).toHaveLength(25);
    expect(wsm.getState().userRequirements[0]).toContain("requirement 5");
  });

  test("enforces max tool results with FIFO", () => {
    const wsm = new WorkingStateManager({ maxToolResults: 5 });
    for (let i = 0; i < 10; i++) {
      wsm.addToolResult("shell", `command ${i}`);
    }
    expect(wsm.getState().toolResults).toHaveLength(5);
    expect(wsm.getState().toolResults[0]?.summary).toContain("command 5");
  });

  test("reset clears all state", () => {
    const wsm = new WorkingStateManager();
    wsm.setTask("do stuff");
    wsm.addDecision("decided something");
    wsm.trackFile("foo.ts", { type: "read", summary: "read" });
    expect(wsm.slotCount()).toBeGreaterThan(0);
    wsm.reset();
    expect(wsm.slotCount()).toBe(0);
    expect(wsm.getState().task).toBe("");
  });

  test("serialize produces structured markdown", () => {
    const wsm = new WorkingStateManager();
    wsm.setTask("fix auth bug");
    wsm.addUserRequirement("must work with OAuth too please");
    wsm.trackFile("src/auth.ts", { type: "read", summary: "150 lines — exports: login, logout" });
    wsm.trackFile("src/auth.ts", { type: "edit", detail: "added validation" });
    wsm.addDecision("use zod for input validation");
    wsm.addFailure("shell: typecheck failed — 3 errors");
    wsm.addToolResult("shell", "bun run typecheck → 3 errors");

    const md = wsm.serialize();
    expect(md).toContain("## Task\nfix auth bug");
    expect(md).toContain("## User Requirements");
    expect(md).toContain("OAuth");
    expect(md).toContain("## Files Touched");
    expect(md).toContain("`src/auth.ts`");
    expect(md).toContain("exports: login, logout");
    expect(md).toContain("added validation");
    expect(md).toContain("## Key Decisions");
    expect(md).toContain("zod");
    expect(md).toContain("## Errors & Failures");
    expect(md).toContain("## Tool Results");
  });

  test("plan serialization with status icons", () => {
    const wsm = new WorkingStateManager();
    wsm.setPlan([
      { id: "1", label: "Research", status: "done" },
      { id: "2", label: "Implement", status: "active" },
      { id: "3", label: "Test", status: "pending" },
      { id: "4", label: "Skipped step", status: "skipped" },
    ]);
    const md = wsm.serialize();
    expect(md).toContain("✓ [1] Research — done");
    expect(md).toContain("▸ [2] Implement — active");
    expect(md).toContain("○ [3] Test — pending");
    expect(md).toContain("⊘ [4] Skipped step — skipped");
  });
});

describe("extractFromToolCall", () => {
  test("tracks read", () => {
    const wsm = new WorkingStateManager();
    extractFromToolCall(wsm, "read", { path: "src/index.ts" });
    expect(wsm.getState().files.has("src/index.ts")).toBe(true);
    expect(wsm.getState().files.get("src/index.ts")?.actions[0]?.type).toBe("read");
  });

  test("tracks edit_file with detail", () => {
    const wsm = new WorkingStateManager();
    extractFromToolCall(wsm, "edit_file", {
      path: "src/foo.ts",
      old_string: "const x = 1",
      new_string: "const x = 2",
    });
    const file = wsm.getState().files.get("src/foo.ts");
    expect(file?.actions[0]?.type).toBe("edit");
  });

  test("tracks grep with pattern summary", () => {
    const wsm = new WorkingStateManager();
    extractFromToolCall(wsm, "grep", { path: "src/", pattern: "TODO" });
    expect(wsm.getState().files.has("src/")).toBe(true);
  });

  test("tracks shell command", () => {
    const wsm = new WorkingStateManager();
    extractFromToolCall(wsm, "shell", { command: "bun run typecheck" });
    expect(wsm.getState().toolResults).toHaveLength(1);
    expect(wsm.getState().toolResults[0]?.summary).toContain("bun run typecheck");
  });

  test("tracks project tool", () => {
    const wsm = new WorkingStateManager();
    extractFromToolCall(wsm, "project", { action: "test", command: "bun test" });
    expect(wsm.getState().toolResults).toHaveLength(1);
    expect(wsm.getState().toolResults[0]?.summary).toContain("test");
  });

  test("tracks bake_grep", () => {
    const wsm = new WorkingStateManager();
    extractFromToolCall(wsm, "bake_grep", { pattern: "handleSubmit", path: "src/" });
    expect(wsm.getState().files.has("src/")).toBe(true);
  });
});

describe("extractFromToolResult", () => {
  test("captures error from failed tool", () => {
    const wsm = new WorkingStateManager();
    extractFromToolResult(wsm, "shell", "Error: Command failed with exit code 1");
    expect(wsm.getState().failures).toHaveLength(1);
    expect(wsm.getState().failures[0]).toContain("shell");
  });

  test("captures grep match count", () => {
    const wsm = new WorkingStateManager();
    extractFromToolResult(wsm, "grep", "src/a.ts:10:const foo\nsrc/b.ts:20:const bar");
    expect(wsm.getState().toolResults).toHaveLength(1);
    expect(wsm.getState().toolResults[0]?.summary).toContain("2 matches");
  });

  test("appends shell result to previous shell entry", () => {
    const wsm = new WorkingStateManager();
    extractFromToolCall(wsm, "shell", { command: "bun test" });
    extractFromToolResult(wsm, "shell", "5 tests passed");
    // Should append to existing, not create new
    const results = wsm.getState().toolResults;
    expect(results).toHaveLength(1);
    expect(results[0]?.summary).toContain("5 tests passed");
  });

  test("updates read with outline", () => {
    const wsm = new WorkingStateManager();
    extractFromToolCall(wsm, "read", { path: "src/auth.ts" });
    extractFromToolResult(
      wsm,
      "read",
      "export function login() {}\nexport function logout() {}\nexport class AuthService {}",
      { path: "src/auth.ts" },
    );
    const file = wsm.getState().files.get("src/auth.ts");
    const lastRead = file?.actions.find((a) => a.type === "read");
    expect(lastRead?.type === "read" && lastRead.summary).toContain("exports:");
  });
});

describe("extractFromUserMessage", () => {
  test("sets task from first message", () => {
    const wsm = new WorkingStateManager();
    extractFromUserMessage(wsm, userMsg("fix the login bug in auth.ts"));
    expect(wsm.getState().task).toBe("fix the login bug in auth.ts");
  });

  test("adds subsequent messages as requirements", () => {
    const wsm = new WorkingStateManager();
    extractFromUserMessage(wsm, userMsg("fix the login bug"));
    extractFromUserMessage(wsm, userMsg("also make sure it handles OAuth"));
    expect(wsm.getState().task).toBe("fix the login bug");
    expect(wsm.getState().userRequirements).toHaveLength(1);
    expect(wsm.getState().userRequirements[0]).toContain("OAuth");
  });

  test("truncates long task to 400 chars", () => {
    const wsm = new WorkingStateManager();
    extractFromUserMessage(wsm, userMsg("x".repeat(600)));
    expect(wsm.getState().task.length).toBeLessThanOrEqual(403); // 400 + "..."
  });
});

describe("extractFromAssistantMessage", () => {
  test("skips very short messages", () => {
    const wsm = new WorkingStateManager();
    extractFromAssistantMessage(wsm, assistantMsg("ok"));
    expect(wsm.getState().assistantNotes).toHaveLength(0);
  });

  test("filters filler phrases", () => {
    const wsm = new WorkingStateManager();
    extractFromAssistantMessage(
      wsm,
      assistantMsg(
        "Let me look at the file. Sure, I'll check that. " +
          "The authentication module uses JWT tokens for session management. " +
          "The validation logic has a bug where it doesn't check expiry. " +
          "Ok, understood, I'll fix it now.",
      ),
    );
    const notes = wsm.getState().assistantNotes;
    expect(notes).toHaveLength(1);
    // Should keep substantive sentences, not filler
    expect(notes[0]).toContain("JWT tokens");
    expect(notes[0]).not.toContain("Let me");
    expect(notes[0]).not.toContain("Sure,");
  });

  test("keeps short messages (<= 3 sentences) as-is", () => {
    const wsm = new WorkingStateManager();
    extractFromAssistantMessage(
      wsm,
      assistantMsg("The bug is in auth.ts line 42. The expiry check is missing."),
    );
    expect(wsm.getState().assistantNotes).toHaveLength(1);
    expect(wsm.getState().assistantNotes[0]).toContain("auth.ts");
  });
});

describe("buildV2Summary", () => {
  test("returns serialized state when skipLlm=true", async () => {
    const wsm = new WorkingStateManager();
    wsm.setTask("test task");
    wsm.addDecision("use v2");
    const result = await buildV2Summary({
      wsm,
      olderMessages: [],
      skipLlm: true,
    });
    expect(result.summary).toContain("## Task\ntest task");
    expect(result.summary).toContain("use v2");
  });

  test("returns serialized state when no model provided", async () => {
    const wsm = new WorkingStateManager();
    wsm.setTask("test task");
    const result = await buildV2Summary({
      wsm,
      olderMessages: [],
    });
    expect(result.summary).toContain("## Task");
  });

  test("skips gap-fill when state is rich (>= 15 slots)", async () => {
    const wsm = new WorkingStateManager();
    wsm.setTask("complex task");
    for (let i = 0; i < 5; i++) wsm.addDecision(`decision ${i} about architecture`);
    for (let i = 0; i < 5; i++) wsm.trackFile(`src/file${i}.ts`, { type: "read", summary: "read" });
    for (let i = 0; i < 5; i++) wsm.addToolResult("shell", `command ${i}`);
    expect(wsm.slotCount()).toBeGreaterThanOrEqual(15);

    // Even with a model, should skip LLM when state is rich
    const result = await buildV2Summary({
      wsm,
      olderMessages: [userMsg("do stuff"), assistantMsg("doing stuff")],
      // No model = no LLM call possible, but the threshold check should trigger first
    });
    expect(result.summary).toContain("## Task");
    expect(result.summary).toContain("## Key Decisions");
    expect(result.summary).toContain("## Files Touched");
    expect(result.summary).not.toContain("## Additional Context");
  });

  test("empty WSM produces empty string", async () => {
    const wsm = new WorkingStateManager();
    const result = await buildV2Summary({ wsm, olderMessages: [], skipLlm: true });
    expect(result.summary).toBe("");
  });
});

describe("slotCount accuracy", () => {
  test("counts all categories", () => {
    const wsm = new WorkingStateManager();
    wsm.setTask("task");                           // +1
    wsm.trackFile("a.ts", { type: "read", summary: "r" }); // +1
    wsm.trackFile("b.ts", { type: "read", summary: "r" }); // +1
    wsm.addDecision("d1");                         // +1
    wsm.addFailure("f1");                          // +1
    wsm.addDiscovery("disc1");                     // +1
    wsm.addToolResult("shell", "cmd");             // +1
    wsm.addEnvironment("node v20");                // +1
    wsm.addUserRequirement("must handle edge cases well"); // +1
    wsm.addAssistantNote("the module uses dependency injection pattern"); // +1
    expect(wsm.slotCount()).toBe(10);
  });
});

describe("integration: full extraction cycle", () => {
  test("simulates a realistic session and produces coherent summary", async () => {
    const wsm = new WorkingStateManager();

    // User asks to fix a bug
    extractFromUserMessage(wsm, userMsg("fix the authentication timeout bug in src/auth.ts"));

    // Agent reads the file
    extractFromToolCall(wsm, "read", { path: "src/auth.ts" });
    extractFromToolResult(
      wsm,
      "read",
      "export function login(creds) {\n  const token = jwt.sign(creds);\n  return token;\n}\nexport function verify(token) {\n  return jwt.verify(token);\n}",
      { path: "src/auth.ts" },
    );

    // Agent greps for related code
    extractFromToolCall(wsm, "bake_grep", { pattern: "timeout", path: "src/" });
    extractFromToolResult(wsm, "bake_grep", "src/auth.ts:15:  // TODO: add timeout\nsrc/config.ts:8:const TIMEOUT = 3600");

    // Agent edits the file
    extractFromToolCall(wsm, "edit_file", {
      path: "src/auth.ts",
      old_string: "return jwt.verify(token);",
      new_string: "return jwt.verify(token, { maxAge: TIMEOUT });",
    });

    // Agent runs tests
    extractFromToolCall(wsm, "shell", { command: "bun test" });
    extractFromToolResult(wsm, "shell", "5 tests passed, 0 failed");

    // Agent explains
    extractFromAssistantMessage(
      wsm,
      assistantMsg(
        "The authentication module was missing a timeout check on JWT verification. " +
          "I added maxAge parameter to jwt.verify which enforces token expiry. " +
          "All existing tests pass with this change.",
      ),
    );

    wsm.addDecision("use jwt maxAge for timeout enforcement");

    const { summary } = await buildV2Summary({ wsm, olderMessages: [], skipLlm: true });

    expect(summary).toContain("authentication timeout bug");
    expect(summary).toContain("src/auth.ts");
    expect(summary).toContain("exports: login, verify");
    expect(summary).toContain("maxAge");
    expect(summary).toContain("5 tests passed");
    expect(summary).toContain("jwt maxAge");

    // Verify it's compact
    expect(summary.length).toBeLessThan(2000);
  });
});
